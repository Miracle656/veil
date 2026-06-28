'use client'

import { useState, useEffect, useCallback } from 'react'
import { Core } from '@walletconnect/core'
import { Web3Wallet, type IWeb3Wallet } from '@walletconnect/web3wallet'
import { getSdkError } from '@walletconnect/utils'
import {
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc as SorobanRpc,
  xdr,
  Address,
  Account,
  Contract,
  BASE_FEE,
  Operation,
} from '@stellar/stellar-sdk'

async function getWalletNonce(
  rpc: SorobanRpc.Server,
  contractAddress: string,
  networkPassphrase: string,
): Promise<bigint | null> {
  try {
    const dummyKp = Keypair.random()
    const dummyAcct = new Account(dummyKp.publicKey(), '0')
    const probeTx = new TransactionBuilder(dummyAcct, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(new Contract(contractAddress).call('get_nonce'))
      .setTimeout(30)
      .build()
    const sim = await rpc.simulateTransaction(probeTx)
    if (SorobanRpc.Api.isSimulationError(sim)) return null
    const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
    if (!result?.retval) return null
    return scValToNative(result.retval) as bigint
  } catch {
    return null
  }
}
import type { WebAuthnSignature } from '@veil/sdk'
import { derToRawSignature, hexToUint8Array } from '@veil/utils'
import { getNetwork } from './network'

const SESSION_STORAGE_KEY = 'veil_walletconnect_sessions'
const METHODS = ['stellar_signXDR', 'stellar_signAndSubmitXDR']

type WalletConnectPeer = {
  name?: string
  description?: string
  url?: string
  icons?: string[]
}

export type WalletConnectSession = {
  topic: string
  chainId: string
  account: string
  peer: WalletConnectPeer | null
}

export type WalletConnectProposal = {
  id: number
  proposer?: {
    metadata?: WalletConnectPeer
  }
}

type SessionListener = (sessions: WalletConnectSession[]) => void
type ProposalListener = (proposal: WalletConnectProposal | null) => void

let _client: IWeb3Wallet | null = null
let _sessions: WalletConnectSession[] = []
let _pendingProposal: WalletConnectProposal | null = null

const sessionListeners = new Set<SessionListener>()
const proposalListeners = new Set<ProposalListener>()

function getChainId(): string {
  const network = getNetwork()
  return network.name === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet'
}

function parseSession(raw: any): WalletConnectSession {
  const allAccounts = Object.values(raw.namespaces ?? {}).flatMap((ns: any) => ns?.accounts ?? [])
  const account = allAccounts[0] ?? ''
  const chainId = account && account.includes(':')
    ? account.split(':').slice(0, 2).join(':')
    : getChainId()
  return {
    topic: raw.topic,
    chainId,
    account,
    peer: raw.peer?.metadata ?? null,
  }
}

function loadStoredSessions(): WalletConnectSession[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistSessions(sessions: WalletConnectSession[]): void {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions))
}

function notifySessions(): void {
  for (const listener of sessionListeners) listener([..._sessions])
}

function notifyProposal(): void {
  for (const listener of proposalListeners) listener(_pendingProposal)
}

async function syncSessionsFromClient(client: IWeb3Wallet): Promise<void> {
  const active = client.getActiveSessions()
  _sessions = Object.values(active).map(parseSession)
  persistSessions(_sessions)
  notifySessions()
}

function getFeePayerKeypair(): Keypair {
  const signerSecret =
    sessionStorage.getItem('veil_signer_secret')
    || localStorage.getItem('veil_signer_secret')
  if (!signerSecret) {
    throw new Error('No fee-payer signer secret found in storage.')
  }
  return Keypair.fromSecret(signerSecret)
}

async function signAuthEntry(payload: Uint8Array): Promise<WebAuthnSignature | null> {
  const keyId = localStorage.getItem('invisible_wallet_key_id')
  const publicKeyHex = localStorage.getItem('invisible_wallet_public_key')
  if (!keyId || !publicKeyHex) {
    throw new Error('No passkey found. Please register the wallet first.')
  }

  const challenge = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength,
  ) as ArrayBuffer

  const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const credIdBin = atob(padded)
  const credId = Uint8Array.from(credIdBin, (c) => c.charCodeAt(0))

  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credId, type: 'public-key' }],
        userVerification: 'required',
      },
    }) as PublicKeyCredential | null

    if (!assertion) return null

    const response = assertion.response as AuthenticatorAssertionResponse
    return {
      publicKey: hexToUint8Array(publicKeyHex),
      authData: new Uint8Array(response.authenticatorData),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
      signature: derToRawSignature(response.signature),
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message.includes('NotAllowedError')
      || message.toLowerCase().includes('cancel')
    ) {
      return null
    }
    throw error
  }
}

function getRpcServer(): SorobanRpc.Server {
  const network = getNetwork()
  return new SorobanRpc.Server(network.rpcUrl)
}

function getRequestId(event: any): number {
  return Number(event.id ?? event.params?.request?.id ?? 0)
}

function getRequestXdr(params: any): string {
  if (typeof params === 'string') return params
  if (Array.isArray(params)) {
    for (const item of params) {
      if (typeof item === 'string') return item
      if (item && typeof item.xdr === 'string') return item.xdr
      if (item && typeof item.transaction === 'string') return item.transaction
    }
  }
  if (params && typeof params.xdr === 'string') return params.xdr
  if (params && typeof params.transaction === 'string') return params.transaction
  if (params && typeof params.tx === 'string') return params.tx
  throw new Error('Missing XDR payload in WalletConnect request.')
}

function buildWcResult(id: number, result: unknown) {
  return { id, jsonrpc: '2.0', result }
}

function buildWcError(id: number, code: number, message: string) {
  return { id, jsonrpc: '2.0', error: { code, message } }
}

async function signXdrPayload(
  _topic: string,
  _requestId: number,
  xdrString: string,
): Promise<string> {
  const network = getNetwork()
  const rpc = getRpcServer()
  const feePayerKeypair = getFeePayerKeypair()
  const tx = TransactionBuilder.fromXDR(xdrString, network.networkPassphrase)

  // Small CPU leeway for host-function ECDSA verification not modeled by
  // recording-mode simulation.
  const sim = await rpc.simulateTransaction(tx, { cpuInstructions: 5_000_000 } as any)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`)
  }

  // Recording-mode simulation returns auth entries with
  // signatureExpirationLedger=0 — set a real future ledger so the host
  // doesn't reject the auth as expired. Must use the same value in both
  // the signed preimage and the credential we attach.
  const latestLedger = await rpc.getLatestLedger()
  const validUntilLedger = latestLedger.sequence + 100

  const successSim = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse
  const authEntries = successSim.result?.auth

  if (authEntries) {
    const networkIdBytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(network.networkPassphrase)),
    )

    for (const parsed of authEntries) {
      const cred = parsed.credentials()
      if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
        continue
      }

      const addrCred = cred.address()
      const contractAddr = Address.fromScAddress(addrCred.address()).toString()
      const currentNonce = await getWalletNonce(rpc, contractAddr, network.networkPassphrase)

      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: Buffer.from(networkIdBytes),
          nonce: addrCred.nonce(),
          invocation: parsed.rootInvocation(),
          signatureExpirationLedger: validUntilLedger,
        }),
      )
      const payloadHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(preimage.toXDR())),
      )

      const webAuthnSig = await signAuthEntry(payloadHash)
      if (!webAuthnSig) {
        throw new Error('USER_REJECTED')
      }

      const sigElements = [
        nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
      ]
      if (currentNonce !== null) {
        sigElements.push(nativeToScVal(currentNonce, { type: 'u64' }))
      }
      const sigVec = xdr.ScVal.scvVec(sigElements)

      parsed.credentials(
        xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: addrCred.address(),
            nonce: addrCred.nonce(),
            signatureExpirationLedger: validUntilLedger,
            signature: sigVec,
          }),
        ),
      )
    }
  }

  // Re-simulate with signed auth entries embedded so the simulator runs in
  // `enforce` mode and produces a footprint that includes the wallet
  // contract's instance storage that __check_auth reads.
  const ihfOp = tx.operations[0] as Operation.InvokeHostFunction
  const feePayerAcct = await rpc.getAccount(feePayerKeypair.publicKey())
  const signedTx = new TransactionBuilder(feePayerAcct, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({
      func:   ihfOp.func,
      auth:   authEntries ?? [],
      source: ihfOp.source,
    }))
    .setTimeout(30)
    .build()

  const sim2 = await rpc.simulateTransaction(signedTx)
  if (SorobanRpc.Api.isSimulationError(sim2)) {
    throw new Error(`Re-simulation (enforce mode) failed: ${sim2.error}`)
  }

  const assembled = SorobanRpc.assembleTransaction(signedTx, sim2).build()
  assembled.sign(feePayerKeypair)
  return assembled.toXDR()
}

async function handleSignAndSubmitXdrRequest(
  topic: string,
  requestId: number,
  xdrString: string,
): Promise<string> {
  const rpc = getRpcServer()
  const signedXDR = await signXdrPayload(topic, requestId, xdrString)
  const network = getNetwork()
  const signedTx = TransactionBuilder.fromXDR(signedXDR, network.networkPassphrase)
  const sendResult = await rpc.sendTransaction(signedTx)
  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`,
    )
  }
  return sendResult.hash
}

function dispatchWalletConnectRequest(event: any): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('wc:request', { detail: event }),
  )
}

export async function handleSignXdrRequest(event: any): Promise<void> {
  const client = _client
  if (!client) throw new Error('WalletConnect client not initialized.')

  const topic = event.topic
  const method = event.params?.request?.method
  const requestId = getRequestId(event)

  try {
    if (method === 'stellar_signXDR') {
      const requestParams = event.params?.request?.params
      const xdrString = getRequestXdr(requestParams)
      const signedXDR = await signXdrPayload(topic, requestId, xdrString)
      await client.respondSessionRequest({
        topic,
        response: buildWcResult(requestId, { signedXDR }),
      })
      return
    }

    if (method === 'stellar_signAndSubmitXDR') {
      const requestParams = event.params?.request?.params
      const xdrString = getRequestXdr(requestParams)
      const txHash = await handleSignAndSubmitXdrRequest(topic, requestId, xdrString)
      await client.respondSessionRequest({
        topic,
        response: buildWcResult(requestId, { txHash }),
      })
      return
    }

    await client.respondSessionRequest({
      topic,
      response: buildWcError(requestId, 10001, `Unsupported method: ${String(method)}`),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const rejected = message.includes('USER_REJECTED')
      || message.includes('NotAllowedError')
      || message.toLowerCase().includes('cancel')

    if (rejected) {
      const reason = getSdkError('USER_REJECTED')
      await client.respondSessionRequest({
        topic,
        response: buildWcError(requestId, reason.code, reason.message),
      })
      return
    }

    await client.respondSessionRequest({
      topic,
      response: buildWcError(requestId, 5000, message),
    })
  }
}

export function subscribeWalletConnectSessions(listener: SessionListener): () => void {
  sessionListeners.add(listener)
  listener([..._sessions])
  return () => sessionListeners.delete(listener)
}

export function subscribeWalletConnectProposal(listener: ProposalListener): () => void {
  proposalListeners.add(listener)
  listener(_pendingProposal)
  return () => proposalListeners.delete(listener)
}

export function getWalletConnectSessions(): WalletConnectSession[] {
  return [..._sessions]
}

export function getPendingWalletConnectProposal(): WalletConnectProposal | null {
  return _pendingProposal
}

export async function getWalletConnectClient(): Promise<IWeb3Wallet> {
  if (_client) return _client

  if (typeof window === 'undefined') {
    throw new Error('WalletConnect can only run in the browser.')
  }

  _sessions = loadStoredSessions()
  notifySessions()

  const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim()
  if (!projectId) {
    throw new Error('NEXT_PUBLIC_WC_PROJECT_ID is missing.')
  }

  const core = new Core({ projectId })
  _client = await Web3Wallet.init({
    core,
    metadata: {
      name: 'Veil Wallet',
      description: 'Passkey-powered Stellar wallet.',
      url: 'https://veil.app',
      icons: ['https://veil.app/icon.png'],
    },
  })

  _client.on('session_proposal', (proposal: any) => {
    _pendingProposal = proposal
    notifyProposal()
  })

  _client.on('session_delete', (event: any) => {
    _sessions = _sessions.filter((session) => session.topic !== event.topic)
    persistSessions(_sessions)
    notifySessions()
  })

  _client.on('session_request', (event: any) => {
    dispatchWalletConnectRequest(event)
  })

  await syncSessionsFromClient(_client)
  return _client
}

export async function pairWalletConnect(uri: string): Promise<void> {
  const client = await getWalletConnectClient()
  await client.pair({ uri })
}

export async function approveSession(
  proposal: WalletConnectProposal,
  contractAddress: string,
): Promise<void> {
  if (!contractAddress.startsWith('C')) {
    throw new Error('Wallet address must be a Stellar contract address (C...).')
  }

  const client = await getWalletConnectClient()
  const chainId = getChainId()
  const namespaces = {
    stellar: {
      methods: METHODS,
      chains: [chainId],
      events: ['accountsChanged', 'chainChanged'],
      accounts: [`${chainId}:${contractAddress}`],
    },
  }

  await client.approveSession({
    id: proposal.id,
    namespaces,
  })
  _pendingProposal = null
  notifyProposal()
  await syncSessionsFromClient(client)
}

export async function rejectSession(proposal: WalletConnectProposal): Promise<void> {
  const client = await getWalletConnectClient()
  await client.rejectSession({
    id: proposal.id,
    reason: getSdkError('USER_REJECTED'),
  })
  _pendingProposal = null
  notifyProposal()
}

export async function disconnectSession(topic: string): Promise<void> {
  const client = await getWalletConnectClient()
  await client.disconnectSession({
    topic,
    reason: getSdkError('USER_DISCONNECTED'),
  })
  _sessions = _sessions.filter((session) => session.topic !== topic)
  persistSessions(_sessions)
  notifySessions()
}

export async function disconnectAllSessions(): Promise<void> {
  const client = _client
  const sessions = [..._sessions]
  await Promise.all(
    sessions.map((s) =>
      client
        ? client
            .disconnectSession({ topic: s.topic, reason: getSdkError('USER_DISCONNECTED') })
            .catch(() => {})
        : Promise.resolve(),
    ),
  )
  _sessions = []
  persistSessions([])
  notifySessions()
}

// ── React hook ────────────────────────────────────────────────────────────────

export function useWalletConnect() {
  const [sessions, setSessions] = useState<WalletConnectSession[]>([])
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    const unsubscribe = subscribeWalletConnectSessions((s) => {
      setSessions(s)
      setIsLoaded(true)
    })
    return unsubscribe
  }, [])

  const disconnect = useCallback((topic: string) => {
    disconnectSession(topic).catch(console.error)
  }, [])

  const disconnectAll = useCallback(() => {
    disconnectAllSessions().catch(console.error)
  }, [])

  return { sessions, disconnect, disconnectAll, isLoaded }
}
