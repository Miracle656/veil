import { Routes, Route, Navigate, NavLink, useNavigate } from '@solidjs/router';
import { createSignal, createEffect, onMount, Show } from 'solid-js';
import { useInvisibleWallet } from '@veil/invisible-wallet-solid';
import {
  appConfig,
  persistSession,
  readWalletAddress,
  readSignerSecret,
  readSignerPublicKey,
  readCredentialId,
  bytesToHex,
  deriveFeePayerKeypair,
  requirePasskeyAssertion
} from './lib';
import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Memo,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc
} from '@stellar/stellar-sdk';

const HorizonServer = Horizon.Server;

// --- Register Page Component ---
function RegisterPage() {
  const navigate = useNavigate();
  const wallet = useInvisibleWallet({
    factoryAddress: appConfig.factoryAddress,
    rpcUrl: appConfig.rpcUrl,
    networkPassphrase: appConfig.networkPassphrase,
  });

  const [username, setUsername] = createSignal('Veil User');
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<'idle' | 'registering' | 'deploying' | 'done'>('idle');

  const canStart = () => appConfig.factoryAddress.length > 0 && !wallet.isPending();

  const handleRegister = async () => {
    setError(null);

    if (!appConfig.factoryAddress) {
      setError('Set VITE_FACTORY_ADDRESS before running the starter.');
      return;
    }

    try {
      setStatus('registering');
      const registration = await wallet.register(username().trim() || 'Veil User');

      const credentialId = readCredentialId();
      if (!credentialId) {
        throw new Error('Registration completed, but the credential ID was not stored.');
      }

      setStatus('deploying');
      const feePayer = await deriveFeePayerKeypair(credentialId);

      if (appConfig.friendbotUrl) {
        const response = await fetch(`${appConfig.friendbotUrl}?addr=${feePayer.publicKey()}`);
        if (!response.ok) {
          throw new Error('Friendbot funding failed.');
        }
      }

      const deployed = await wallet.deploy(feePayer.secret(), registration.publicKeyBytes);
      persistSession(deployed.walletAddress, feePayer.secret(), feePayer.publicKey());
      setStatus('done');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
    }
  };

  return (
    <section class="panel hero-panel">
      <p class="eyebrow">Register</p>
      <h1>Create a passkey wallet</h1>
      <p class="lede">
        Register a WebAuthn credential, derive the fee-payer key, and deploy the wallet contract on testnet.
      </p>

      <div class="stack">
        <label class="field">
          <span>Display name</span>
          <input value={username()} onInput={event => setUsername(event.currentTarget.value)} placeholder="Veil User" />
        </label>

        <button class="primary" onClick={handleRegister} disabled={!canStart()}>
          <Show when={wallet.isPending() || status() === 'registering'} fallback={
            <Show when={status() === 'deploying'} fallback="Create wallet">
              Deploying wallet...
            </Show>
          }>
            Creating passkey...
          </Show>
        </button>

        <Show when={error()}>
          <div class="notice error">{error()}</div>
        </Show>
        <div class="hint">This flow mirrors the Next.js starter onboarding: register first, then deploy, then continue to the dashboard.</div>
      </div>
    </section>
  );
}

// --- Dashboard Page Component ---
function DashboardPage() {
  const navigate = useNavigate();
  const wallet = useInvisibleWallet({
    factoryAddress: appConfig.factoryAddress,
    rpcUrl: appConfig.rpcUrl,
    networkPassphrase: appConfig.networkPassphrase,
  });

  const [address, setAddress] = createSignal<string | null>(null);
  const [signature, setSignature] = createSignal<any | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    const stored = readWalletAddress();
    if (!stored) {
      navigate('/register', { replace: true });
      return;
    }

    setAddress(stored);
    wallet.login().catch(() => {
      setError('Wallet not yet deployed. Return to Register and deploy it first.');
    });
  });

  const handleSignDemo = async () => {
    setError(null);
    try {
      const payload = new Uint8Array(32);
      payload.fill(7);
      const result = await wallet.signAuthEntry(payload);
      if (!result) {
        throw new Error('No signature returned.');
      }
      setSignature(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section class="panel">
      <p class="eyebrow">Dashboard</p>
      <h1>Wallet overview</h1>
      <p class="lede">A compact status page that shows the registered wallet and the stored fee-payer session.</p>

      <Show when={error()}>
        <div class="notice error">{error()}</div>
      </Show>

      <div class="grid two-up">
        <article class="card">
          <span class="card-label">Wallet address</span>
          <div class="mono break">{address() ?? 'No wallet registered yet.'}</div>
        </article>
        <article class="card">
          <span class="card-label">Fee-payer public key</span>
          <div class="mono break">{readSignerPublicKey() ?? 'Missing'}</div>
        </article>
      </div>

      <div class="stack">
        <div class="actions">
          <button class="primary" onClick={handleSignDemo} disabled={wallet.isPending() || !address()}>
            Sign auth entry demo
          </button>
          <NavLink class="secondary" href="/send">Go to send</NavLink>
        </div>

        <Show when={signature()}>
          <article class="card">
            <span class="card-label">WebAuthn signature</span>
            <div class="mono small">publicKey: {bytesToHex(signature().publicKey)}</div>
            <div class="mono small">authData: {bytesToHex(signature().authData)}</div>
            <div class="mono small">clientDataJSON: {bytesToHex(signature().clientDataJSON)}</div>
            <div class="mono small">signature: {bytesToHex(signature().signature)}</div>
          </article>
        </Show>

        <div class="hint">
          Network: {appConfig.networkPassphrase === 'Test SDF Network ; September 2015' ? 'Testnet' : 'Custom'}
        </div>
      </div>
    </section>
  );
}

// --- Send Page Component ---
function SendPage() {
  const wallet = useInvisibleWallet({
    factoryAddress: appConfig.factoryAddress,
    rpcUrl: appConfig.rpcUrl,
    networkPassphrase: appConfig.networkPassphrase,
  });

  const [recipient, setRecipient] = createSignal('');
  const [amount, setAmount] = createSignal('1');
  const [memo, setMemo] = createSignal('');
  const [txHash, setTxHash] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const handleSend = async () => {
    setError(null);
    setTxHash('');

    const walletAddress = readWalletAddress();
    const signerSecret = readSignerSecret();
    const credentialId = readCredentialId();

    if (!walletAddress) {
      setError('Create a wallet first.');
      return;
    }
    if (!signerSecret) {
      setError('Fee-payer secret not found. Return to Register and redeploy the wallet.');
      return;
    }
    if (!credentialId) {
      setError('Passkey credential not found. Register the wallet first.');
      return;
    }
    if (!recipient() || (!recipient().startsWith('G') && !recipient().startsWith('C'))) {
      setError('Enter a valid Stellar address starting with G or C.');
      return;
    }

    const parsedAmount = Number(amount());
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('Enter a positive amount.');
      return;
    }

    setLoading(true);
    try {
      const feePayer = await deriveFeePayerKeypair(credentialId);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      await requirePasskeyAssertion(credentialId, challenge);

      if (recipient().startsWith('G')) {
        const horizon = new HorizonServer(appConfig.horizonUrl);
        const account = await horizon.loadAccount(feePayer.publicKey());
        const txBuilder = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: appConfig.networkPassphrase,
        })
          .addOperation(Operation.payment({
            destination: recipient(),
            asset: Asset.native(),
            amount: amount(),
          }));

        if (memo()) {
          txBuilder.addMemo(Memo.text(memo()));
        }

        const tx = txBuilder.setTimeout(30).build();

        tx.sign(feePayer);
        const result = await horizon.submitTransaction(tx);
        setTxHash(result.hash);
        return;
      }

      const rpc = new SorobanRpc.Server(appConfig.rpcUrl);
      const account = await rpc.getAccount(feePayer.publicKey());
      const contract = new Contract(Asset.native().contractId(appConfig.networkPassphrase));
      const amountStroops = BigInt(Math.round(parsedAmount * 10_000_000));

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: appConfig.networkPassphrase,
      })
        .addOperation(contract.call(
          'transfer',
          nativeToScVal(feePayer.publicKey(), { type: 'address' }),
          nativeToScVal(recipient(), { type: 'address' }),
          nativeToScVal(amountStroops, { type: 'i128' }),
        ))
        .setTimeout(30)
        .build();

      const simulation = await rpc.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new Error(simulation.error);
      }

      const assembled = SorobanRpc.assembleTransaction(tx, simulation).build();
      assembled.sign(feePayer);
      const submission = await rpc.sendTransaction(assembled);
      if (submission.status === 'ERROR') {
        throw new Error(submission.errorResult?.toXDR('base64') ?? 'Transaction rejected');
      }

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await rpc.getTransaction(submission.hash);
        if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          setTxHash(submission.hash);
          return;
        }
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          throw new Error(`Transaction failed: ${result.status}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      throw new Error('Transaction timed out.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section class="panel">
      <p class="eyebrow">Send</p>
      <h1>Transfer XLM</h1>
      <p class="lede">The starter supports classic G→G payments and G→C native SAC transfers, matching the Next.js example flow.</p>

      <div class="stack">
        <label class="field">
          <span>Recipient address</span>
          <input value={recipient()} onInput={event => setRecipient(event.currentTarget.value)} placeholder="G... or C..." />
        </label>

        <label class="field">
          <span>Amount</span>
          <input value={amount()} onInput={event => setAmount(event.currentTarget.value)} inputMode="decimal" placeholder="1.0" />
        </label>

        <label class="field">
          <span>Memo</span>
          <input value={memo()} onInput={event => setMemo(event.currentTarget.value)} placeholder="Optional memo" />
        </label>

        <button class="primary" onClick={handleSend} disabled={loading() || wallet.isPending()}>
          <Show when={loading()} fallback="Send">
            Sending...
          </Show>
        </button>

        <Show when={error()}>
          <div class="notice error">{error()}</div>
        </Show>
        <Show when={txHash()}>
          <div class="notice success">
            Submitted successfully: <span class="mono break">{txHash()}</span>
          </div>
        </Show>
      </div>
    </section>
  );
}

export function App() {
  return (
    <div class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Veil</p>
          <h1>Vite + Solid starter</h1>
        </div>
        <nav class="nav">
          <NavLink href="/register" end>Register</NavLink>
          <NavLink href="/dashboard">Dashboard</NavLink>
          <NavLink href="/send">Send</NavLink>
        </nav>
      </header>

      <main class="content">
        <Routes>
          <Route path="/" element={<Navigate href="/register" />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/send" element={<SendPage />} />
        </Routes>
      </main>

      <footer class="footer">
        <NavLink href="/register">Start with registration</NavLink>
        <span>Passkey wallet starter example</span>
      </footer>
    </div>
  );
}
