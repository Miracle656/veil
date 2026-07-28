import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Asset,
  Operation,
  Contract,
  rpc as SorobanRpc,
  nativeToScVal,
  Horizon,
} from '@stellar/stellar-sdk';
import {
  parseSep7QrValue,
} from 'invisible-wallet-sdk';
import { getNetwork, getNativeAssetContractId } from '../../lib/network';
import { getItem } from '../../lib/storage';
import { QrScanner } from '../../components/QrScanner';

const network = getNetwork();
const Server = Horizon.Server;

type Step = 'form' | 'confirm' | 'signing' | 'done' | 'error';

interface WalletAsset {
  code: string;
  issuer: string | null;
  contractId: string | null;
}

export default function SendScreen() {
  const router = useRouter();

  const [step, setStep] = useState<Step>('form');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);

  const [assets, setAssets] = useState<WalletAsset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<WalletAsset | null>(null);

  // Load assets on mount
  useEffect(() => {
    const loadAssets = async () => {
      const xlm: WalletAsset = {
        code: 'XLM',
        issuer: null,
        contractId: getNativeAssetContractId(),
      };

      try {
        const secret = await getItem('veil_signer_secret');
      const signerPublicKey = secret
        ? Keypair.fromSecret(secret).publicKey()
        : await getItem('veil_signer_public_key');

        if (!signerPublicKey || !signerPublicKey.startsWith('G')) {
          setAssets([xlm]);
          setSelectedAsset(xlm);
          return;
        }

        const server = new Server(network.horizonUrl);
        const account = await server.loadAccount(signerPublicKey);
        const list: WalletAsset[] = account.balances.map((b: any) => {
          if (b.asset_type === 'native') {
            return {
              code: 'XLM',
              issuer: null,
              contractId: getNativeAssetContractId(),
            };
          }
          const issued = b as { asset_code: string; asset_issuer: string };
          const asset = new Asset(issued.asset_code, issued.asset_issuer);
          return {
            code: issued.asset_code,
            issuer: issued.asset_issuer,
            contractId: asset.contractId(network.networkPassphrase),
          };
        });
        setAssets(list);
        if (list.length > 0) setSelectedAsset(list[0]);
      } catch {
        setAssets([xlm]);
        setSelectedAsset(xlm);
      }
    };

    loadAssets();
  }, []);

  function validateForm(): boolean {
    const validAddress =
      (recipient.startsWith('G') || recipient.startsWith('C')) &&
      recipient.length === 56;
    if (!validAddress) return false;
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return false;
    if (!selectedAsset) return false;
    return true;
  }

  const handleSend = useCallback(async () => {
    setStep('signing');
    setErrorMsg(null);

    try {
      const signerSecret = await getItem('veil_signer_secret');
      if (!signerSecret) {
        setErrorMsg(
          'Signing key not found. Return to dashboard and set up a fee-payer.'
        );
        setStep('error');
        return;
      }
      const feePayerKp = Keypair.fromSecret(signerSecret);

      const keyId = await getItem('invisible_wallet_key_id');
      if (!keyId) {
        setErrorMsg('No passkey found. Please register the wallet first.');
        setStep('error');
        return;
      }

      const horizonServer = new Server(network.horizonUrl);

      if (recipient.startsWith('G') && recipient.length === 56) {
        const account = await horizonServer.loadAccount(feePayerKp.publicKey());
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: network.networkPassphrase,
        })
          .addOperation(
            Operation.payment({
              destination: recipient,
              asset: Asset.native(),
              amount,
            })
          )
          .setTimeout(30)
          .build();
        tx.sign(feePayerKp);
        const result = await horizonServer.submitTransaction(tx);
        setTxHash(result.hash);
      } else {
        const rpcServer = new SorobanRpc.Server(network.rpcUrl);
        const feePayerAcct = await rpcServer.getAccount(feePayerKp.publicKey());
        const sacContract = new Contract(getNativeAssetContractId());
        const amountStroops = BigInt(
          Math.round(parseFloat(amount) * 10_000_000)
        );

        const tx = new TransactionBuilder(feePayerAcct, {
          fee: BASE_FEE,
          networkPassphrase: network.networkPassphrase,
        })
          .addOperation(
            sacContract.call(
              'transfer',
              nativeToScVal(feePayerKp.publicKey(), { type: 'address' }),
              nativeToScVal(recipient, { type: 'address' }),
              nativeToScVal(amountStroops, { type: 'i128' })
            )
          )
          .setTimeout(30)
          .build();

        const sim = await rpcServer.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(sim)) {
          throw new Error(`Simulation failed: ${sim.error}`);
        }
        const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(feePayerKp);

        const sendResult = await rpcServer.sendTransaction(assembled);
        if (sendResult.status === 'ERROR') {
          throw new Error(
            `Transaction rejected: ${
              sendResult.errorResult?.toXDR('base64') ?? 'unknown'
            }`
          );
        }
        for (let i = 0; i < 30; i++) {
          const result = await rpcServer.getTransaction(sendResult.hash);
          if (
            result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND
          ) {
            if (
              result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS
            ) {
              throw new Error(`Transaction failed: ${result.status}`);
            }
            break;
          }
          await new Promise((r) => setTimeout(r, 1_000));
        }
        setTxHash(sendResult.hash);
      }

      setStep('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(
        msg.includes('NotAllowedError') || msg.includes('not allowed')
          ? 'Biometric verification was cancelled. Please try again.'
          : msg
      );
      setStep('error');
    }
  }, [recipient, amount, selectedAsset, network]);

  const handleQrScan = useCallback(
    (value: string) => {
      try {
        const parsed = parseSep7QrValue(value);
        if (parsed.destination) setRecipient(parsed.destination);
        if ('amount' in parsed && parsed.amount) setAmount(parsed.amount);
        if ('memo' in parsed && parsed.memo) setMemo(parsed.memo);
      } catch {
        // If SEP-7 parsing fails, it might be a bare address — already handled in QrScanner
      }
      setShowScanner(false);
    },
    []
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Nav */}
      <View style={styles.nav}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backText}>{'< Back'}</Text>
        </TouchableOpacity>
        <Text style={styles.navLogo}>V</Text>
        <View style={styles.navSpacer} />
      </View>

      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.pageTitle}>Send</Text>

        {/* ── Form Step ─────────────────────────────────────────────── */}
        {step === 'form' && (
          <View style={styles.formSection}>
            {/* Asset selector */}
            {assets.length > 1 && (
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>ASSET</Text>
                <View style={styles.pickerRow}>
                  {assets.map((a) => (
                    <TouchableOpacity
                      key={`${a.code}-${a.issuer ?? 'native'}`}
                      style={[
                        styles.assetChip,
                        selectedAsset?.code === a.code && styles.assetChipActive,
                      ]}
                      onPress={() => setSelectedAsset(a)}
                    >
                      <Text
                        style={[
                          styles.assetChipText,
                          selectedAsset?.code === a.code &&
                            styles.assetChipTextActive,
                        ]}
                      >
                        {a.code}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* Recipient */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>RECIPIENT ADDRESS</Text>
              <View style={styles.recipientRow}>
                <TextInput
                  style={[styles.input, styles.monoInput]}
                  placeholder="G... or C..."
                  placeholderTextColor="rgba(246,247,248,0.3)"
                  value={recipient}
                  onChangeText={setRecipient}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
                <TouchableOpacity
                  onPress={() => setShowScanner(true)}
                  style={styles.iconBtn}
                  aria-label="Scan QR code"
                >
                  <Text style={styles.iconBtnText}>QR</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Amount */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>
                AMOUNT{selectedAsset ? ` (${selectedAsset.code})` : ''}
              </Text>
              <TextInput
                style={[styles.input, styles.amountInput]}
                placeholder="0.00"
                placeholderTextColor="rgba(246,247,248,0.3)"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
              />
            </View>

            {/* Memo */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>MEMO (OPTIONAL)</Text>
              <TextInput
                style={styles.input}
                placeholder="Add a note..."
                placeholderTextColor="rgba(246,247,248,0.3)"
                value={memo}
                onChangeText={setMemo}
                maxLength={28}
              />
            </View>

            <TouchableOpacity
              style={[
                styles.primaryButton,
                !validateForm() && styles.primaryButtonDisabled,
              ]}
              onPress={() => setStep('confirm')}
              disabled={!validateForm()}
            >
              <Text
                style={[
                  styles.primaryButtonText,
                  !validateForm() && styles.primaryButtonTextDisabled,
                ]}
              >
                Review
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Confirm Step ──────────────────────────────────────────── */}
        {step === 'confirm' && (
          <View style={styles.formSection}>
            <View style={styles.card}>
              <Row
                label="To"
                value={`${recipient.slice(0, 8)}...${recipient.slice(-8)}`}
                mono
              />
              <Row
                label="Amount"
                value={`${amount} ${selectedAsset?.code ?? 'XLM'}`}
              />
              {memo ? <Row label="Memo" value={memo} /> : null}
              <Row label="Network" value="Stellar Testnet" />
            </View>

            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleSend}
            >
              <Text style={styles.primaryButtonText}>Confirm & sign</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.ghostButton}
              onPress={() => setStep('form')}
            >
              <Text style={styles.ghostButtonText}>Edit</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Signing Step ──────────────────────────────────────────── */}
        {step === 'signing' && (
          <View style={[styles.card, styles.centeredCard]}>
            <ActivityIndicator size="large" color="#F6F7F8" />
            <Text style={styles.signingTitle}>Waiting for passkey...</Text>
            <Text style={styles.signingSubtitle}>
              Approve the prompt to authorise the transfer
            </Text>
          </View>
        )}

        {/* ── Done Step ─────────────────────────────────────────────── */}
        {step === 'done' && (
          <View style={[styles.card, styles.centeredCard]}>
            <View style={styles.successIcon}>
              <Text style={styles.successIconText}>✓</Text>
            </View>
            <Text style={styles.doneTitle}>Sent successfully</Text>
            {txHash && (
              <Text style={styles.txHash} selectable>
                {txHash.slice(0, 20)}...
              </Text>
            )}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.replace('/')}
            >
              <Text style={styles.primaryButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Error Step ────────────────────────────────────────────── */}
        {step === 'error' && (
          <View style={[styles.card, styles.centeredCard]}>
            <View style={styles.errorIcon}>
              <Text style={styles.errorIconText}>✕</Text>
            </View>
            <Text style={styles.errorTitle}>Transaction failed</Text>
            <Text style={styles.errorDetail}>{errorMsg}</Text>
            <TouchableOpacity
              style={styles.ghostButton}
              onPress={() => setStep('form')}
            >
              <Text style={styles.ghostButtonText}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* QR Scanner Modal */}
      <QrScanner
        visible={showScanner}
        onScan={handleQrScan}
        onClose={() => setShowScanner(false)}
      />
    </KeyboardAvoidingView>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.monoValue]}>{value}</Text>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0B0F',
  },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 60 : 20,
    paddingBottom: 12,
  },
  backButton: {
    paddingVertical: 4,
    paddingRight: 12,
  },
  backText: {
    color: '#F6F7F8',
    fontSize: 14,
    fontFamily: 'Inter, sans-serif',
  },
  navLogo: {
    fontSize: 22,
    color: '#D4AF37',
  },
  navSpacer: {
    width: 40,
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  pageTitle: {
    fontFamily: 'Lora, Georgia, serif',
    fontWeight: '600',
    fontStyle: 'italic',
    fontSize: 28,
    color: '#F6F7F8',
    marginBottom: 24,
  },
  formSection: {
    gap: 16,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 11,
    color: 'rgba(246,247,248,0.4)',
    fontFamily: 'Anton, Impact, sans-serif',
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: 'rgba(246,247,248,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(246,247,248,0.15)',
    borderRadius: 8,
    color: '#F6F7F8',
    fontSize: 14,
    padding: 14,
  },
  monoInput: {
    fontFamily: 'Inconsolata, monospace',
    flex: 1,
  },
  amountInput: {
    fontFamily: 'Inconsolata, monospace',
    fontSize: 20,
  },
  recipientRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'stretch',
  },
  iconBtn: {
    width: 48,
    backgroundColor: 'rgba(246,247,248,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(246,247,248,0.15)',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnText: {
    color: '#D4AF37',
    fontSize: 14,
    fontWeight: '700',
  },
  pickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  assetChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(246,247,248,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(246,247,248,0.1)',
  },
  assetChipActive: {
    backgroundColor: 'rgba(212,175,55,0.15)',
    borderColor: 'rgba(212,175,55,0.4)',
  },
  assetChipText: {
    color: 'rgba(246,247,248,0.5)',
    fontSize: 13,
    fontFamily: 'Inconsolata, monospace',
  },
  assetChipTextActive: {
    color: '#D4AF37',
  },
  primaryButton: {
    backgroundColor: '#D4AF37',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonDisabled: {
    opacity: 0.3,
  },
  primaryButtonText: {
    color: '#0B0B0F',
    fontWeight: '700',
    fontSize: 15,
  },
  primaryButtonTextDisabled: {
    color: 'rgba(11,11,15,0.5)',
  },
  ghostButton: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  ghostButtonText: {
    color: 'rgba(246,247,248,0.5)',
    fontSize: 14,
  },
  card: {
    backgroundColor: '#141519',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(246,247,248,0.08)',
    padding: 16,
    gap: 16,
  },
  centeredCard: {
    alignItems: 'center',
    gap: 16,
    paddingVertical: 32,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  rowLabel: {
    fontSize: 13,
    color: 'rgba(246,247,248,0.4)',
    flexShrink: 0,
  },
  rowValue: {
    fontSize: 14,
    color: '#F6F7F8',
    textAlign: 'right',
    flexShrink: 1,
  },
  monoValue: {
    fontFamily: 'Inconsolata, monospace',
  },
  signingTitle: {
    color: '#F6F7F8',
    fontSize: 16,
    fontWeight: '500',
  },
  signingSubtitle: {
    color: 'rgba(246,247,248,0.4)',
    fontSize: 13,
    textAlign: 'center',
  },
  successIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: '#35D4A0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successIconText: {
    color: '#35D4A0',
    fontSize: 24,
    fontWeight: '700',
  },
  doneTitle: {
    fontFamily: 'Lora, Georgia, serif',
    fontWeight: '600',
    fontStyle: 'italic',
    fontSize: 20,
    color: '#F6F7F8',
  },
  txHash: {
    fontSize: 12,
    color: 'rgba(246,247,248,0.35)',
    fontFamily: 'Inconsolata, monospace',
  },
  errorIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: '#35D4A0',
    opacity: 0.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorIconText: {
    color: '#35D4A0',
    fontSize: 24,
    fontWeight: '700',
  },
  errorTitle: {
    fontWeight: '500',
    fontSize: 16,
    color: '#F6F7F8',
  },
  errorDetail: {
    fontSize: 13,
    color: 'rgba(246,247,248,0.4)',
    textAlign: 'center',
    lineHeight: 20,
  },
});
