import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

export type SignerKind = 'ed25519' | 'secp256r1'

export interface SpendLimit {
  /** Maximum amount in stroops the key may spend, as a decimal string. */
  amount: string
  /** Ledger sequence after which the limit resets, if applicable. */
  resetLedger?: number
}

export interface Signer {
  id: string
  publicKey: string
  kind: SignerKind
  spendLimit?: SpendLimit
}

/**
 * Contract client for the wallet's signer methods. Implementations must call the
 * deployed wallet contract's add_signer, remove_signer and get_signers entrypoints.
 */
export interface SignersClient {
  getSigners(walletAddress: string): Promise<Signer[]>
  addSigner(walletAddress: string, signer: Omit<Signer, 'id'>): Promise<Signer>
  removeSigner(walletAddress: string, signerId: string): Promise<void>
}

export const LAST_SIGNER_REASON =
  'This is the only signer on the wallet. Add another signer before removing it, or the wallet would be locked.'

/** Returns a human-readable reason if the signer cannot be removed, otherwise null. */
export function removalBlockReason(signers: Signer[], signerId: string): string | null {
  const target = signers.find((s) => s.id === signerId)
  if (!target) return null
  if (signers.length <= 1) return LAST_SIGNER_REASON
  return null
}

export function describeCapabilities(signer: Signer): string {
  if (!signer.spendLimit) return 'Can sign any transaction (no spend limit)'
  return `Can spend up to ${signer.spendLimit.amount} stroops`
}

interface Props {
  walletAddress: string
  client: SignersClient
}

export default function SignersScreen({ walletAddress, client }: Props) {
  const [signers, setSigners] = useState<Signer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState('')
  const [newLimit, setNewLimit] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSigners(await client.getSigners(walletAddress))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load signers')
    } finally {
      setLoading(false)
    }
  }, [client, walletAddress])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = async () => {
    const publicKey = newKey.trim()
    if (!publicKey) {
      setError('Enter a public key')
      return
    }
    if (signers.some((s) => s.publicKey === publicKey)) {
      setError('That key is already a signer')
      return
    }
    const limitTrimmed = newLimit.trim()
    if (limitTrimmed && !/^\d+$/.test(limitTrimmed)) {
      setError('Spend limit must be a whole number of stroops')
      return
    }
    setBusy(true)
    try {
      await client.addSigner(walletAddress, {
        publicKey,
        kind: 'ed25519',
        spendLimit: limitTrimmed ? { amount: limitTrimmed } : undefined,
      })
      setNewKey('')
      setNewLimit('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add signer')
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = (signer: Signer) => {
    const reason = removalBlockReason(signers, signer.id)
    if (reason) {
      Alert.alert('Cannot remove signer', reason)
      return
    }
    Alert.alert('Remove signer', `Remove ${signer.publicKey.slice(0, 8)}…? It will no longer be able to sign.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setBusy(true)
          try {
            await client.removeSigner(walletAddress, signer.id)
            await refresh()
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to remove signer')
          } finally {
            setBusy(false)
          }
        },
      },
    ])
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Signers</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={signers}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => {
          const blocked = removalBlockReason(signers, item.id) !== null
          return (
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.mono}>{item.publicKey}</Text>
                <Text style={styles.caption}>{describeCapabilities(item)}</Text>
                {blocked ? <Text style={styles.caption}>{LAST_SIGNER_REASON}</Text> : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || blocked }}
                disabled={busy}
                onPress={() => handleRemove(item)}
                style={[styles.removeBtn, (busy || blocked) && styles.disabled]}
              >
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            </View>
          )
        }}
        ListEmptyComponent={<Text style={styles.caption}>No signers found.</Text>}
      />

      <View style={styles.form}>
        <Text style={styles.label}>Add signer</Text>
        <TextInput
          style={styles.input}
          placeholder="Public key"
          autoCapitalize="none"
          autoCorrect={false}
          value={newKey}
          onChangeText={setNewKey}
          editable={!busy}
        />
        <TextInput
          style={styles.input}
          placeholder="Spend limit in stroops (optional)"
          keyboardType="number-pad"
          value={newLimit}
          onChangeText={setNewLimit}
          editable={!busy}
        />
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={handleAdd}
          style={[styles.addBtn, busy && styles.disabled]}
        >
          <Text style={styles.addText}>{busy ? 'Working…' : 'Add signer'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '700' },
  error: { color: '#f87171' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 8 },
  rowText: { flex: 1, gap: 4 },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  caption: { fontSize: 12, color: '#9ca3af' },
  removeBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#f87171' },
  removeText: { color: '#f87171', fontWeight: '600' },
  form: { gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#374151' },
  label: { fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#374151', borderRadius: 8, padding: 10 },
  addBtn: { backgroundColor: '#6366f1', borderRadius: 8, padding: 12, alignItems: 'center' },
  addText: { color: '#fff', fontWeight: '600' },
  disabled: { opacity: 0.5 },
})
