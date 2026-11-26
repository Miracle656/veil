'use client'

import { inclusionFee } from './fees'
import { useState, useEffect, useCallback } from 'react'
import { Core } from '@walletconnect/core'
import { WalletKit, type IWalletKit } from '@reown/walletkit'
import { getInternalError, getSdkError } from '@walletconnect/utils'
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
  FeeBumpTransaction,
} from '@stellar/stellar-sdk'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { walletContractErrorMessage } from './walletContractError'
import { recordApprovalsInXdr } from './allowances'

/**
 * Remember any allowance a signed dApp transaction grants, so Settings →
 * Spending permissions can find it later (the contract keeps no list; #1187).
 */
function rememberApprovals(xdrString: string): void {
  const wallet = walletLocal.getItem('invisible_wallet_address') ?? walletSession.getItem('invisible_wallet_address')
  recordApprovalsInXdr(walletLocal, wallet, xdrString)
}

async function getWalletNonce(
  rpc: SorobanRpc.Server,
  contractAddress: string,
  networkPassphrase: string,
): Promise<bigint | null> {
  try {
    const dummyKp = Keypair.random()
    const dummyAcct = new Account(dummyKp.publicKey(), '0')
    const probeTx = new TransactionBuilder(dummyAcct, {
      fee: inclusionFee(),
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
import {
  createSep43Wallet,
  signSorobanAuthEntry,
  signMessage as sdkSignMessage,
  type WebAuthnSignature,
  type Sep43Wallet,
} from '@veil/sdk'
import { derToRawSignature, hexToUint8Array } from '@veil/utils'
import { getNetwork } from './network'
import { WalletNotActivatedError, getDeploymentState } from './walletDeployment'

const SESSION_STORAGE_KEY = 'veil_walletconnect_sessions'
const METHODS = [
  'stellar_signXDR',
  'stellar_signAndSubmitXDR',
  'stellar_signAuthEntry',
  'stellar_signMessage',
  'stellar_getAccount',
  'stellar_getAddress',
  'stellar_getNetwork',
]

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
  /** Unix seconds after which the relay drops the session. Absent on sessions stored before it was recorded. */
  expiry?: number | null
}

/**
 * A request this wallet will not sign, refused before any key is touched.
 * `code` is what the dApp receives in the JSON-RPC error.
 */
export class WalletConnectRefusal extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'WalletConnectRefusal'
  }
}

// JSON-RPC "Invalid params": the request is not something this wallet can read.
const MALFORMED_REQUEST = -32602
const UNSUPPORTED_METHOD = 10001

export type WalletConnectProposal = {
  id: number
  proposer?: {
    metadata?: WalletConnectPeer
  }
}

type SessionListener = (sessions: WalletConnectSession[]) => void
type ProposalListener = (proposal: WalletConnectProposal | null) => void

let _client: IWalletKit | null = null
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
    expiry: typeof raw.expiry === 'number' ? raw.expiry : null,
  }
}

/**
 * WalletKit does not tell the wallet when a session runs out, so an expired
 * session would otherwise stay listed as connected, and its requests would
 * still be offered for signing.
 */
function isExpired(expiry: number | null | undefined, nowMs = Date.now()): boolean {
  return typeof expiry === 'number' && expiry * 1000 <= nowMs
}

function loadStoredSessions(): WalletConnectSession[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s) => !isExpired(s?.expiry)) : []
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

async function syncSessionsFromClient(client: IWalletKit): Promise<void> {
  const active = client.getActiveSessions()
  _sessions = Object.values(active)
    .map(parseSession)
    .filter((session) => !isExpired(session.expiry))
  persistSessions(_sessions)
  notifySessions()
}

function getFeePayerKeypair(): Keypair {
  const signerSecret =
    walletSession.getItem('veil_signer_secret')
    || walletLocal.getItem('veil_signer_secret')
  if (!signerSecret) {
    throw new Error('No fee-payer signer secret found in storage.')
  }
  return Keypair.fromSecret(signerSecret)
}

async function signAuthEntry(payload: Uint8Array): Promise<WebAuthnSignature | null> {
  const keyId = walletLocal.getItem('invisible_wallet_key_id')
  const publicKeyHex = walletLocal.getItem('invisible_wallet_public_key')
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
  throw new WalletConnectRefusal(MALFORMED_REQUEST, 'Missing XDR payload in WalletConnect request.')
}

/**
 * The session a request arrived on, checked before anything is parsed or
 * signed. Returns the wallet address that session was granted, which is the
 * only address this request may ask the passkey to authorize.
 */
function checkRequestSession(client: IWalletKit, event: any): string {
  const session = client.getActiveSessions()[event.topic]
  if (!session || isExpired(session.expiry)) {
    throw new WalletConnectRefusal(
      getInternalError('EXPIRED').code,
      'This dApp connection has ended. Reconnect the dApp and try again.',
    )
  }

  // The XDR does not say which network it was built for: a transaction asked
  // for on testnet would be signed here for whichever network is active.
  const chainId = getChainId()
  const requested = event.params?.chainId
  if (requested !== chainId) {
    throw new WalletConnectRefusal(
      getSdkError('UNSUPPORTED_CHAINS').code,
      `This wallet is on ${chainId}; the request was for ${String(requested)}.`,
    )
  }

  const { account } = parseSession(session)
  const [namespace, reference, address] = account.split(':')
  if (`${namespace}:${reference}` !== chainId || !address) {
    throw new WalletConnectRefusal(
      getSdkError('UNSUPPORTED_CHAINS').code,
      `This dApp was connected on ${account ? `${namespace}:${reference}` : 'no network'}, not ${chainId}.`,
    )
  }
  return address
}

function buildWcResult(id: number, result: unknown) {
  return { id, jsonrpc: '2.0', result }
}

function buildWcError(id: number, code: number, message: string) {
  return { id, jsonrpc: '2.0', error: { code, message } }
}

function parseRequestTransaction(xdrString: string, networkPassphrase: string) {
  let tx
  try {
    tx = TransactionBuilder.fromXDR(xdrString, networkPassphrase)
  } catch {
    throw new WalletConnectRefusal(MALFORMED_REQUEST, 'The request does not contain a readable Stellar transaction.')
  }
  if (tx instanceof FeeBumpTransaction) {
    throw new WalletConnectRefusal(MALFORMED_REQUEST, 'Fee-bump transactions are not accepted.')
  }
  // Only the first operation is rebuilt and submitted, so anything after it
  // would be silently dropped from what the user approved.
  if (tx.operations.length !== 1 || tx.operations[0].type !== 'invokeHostFunction') {
    throw new WalletConnectRefusal(
      MALFORMED_REQUEST,
      'The request must be a single contract call (one invokeHostFunction operation).',
    )
  }
  return tx
}

/**
 * Refuse any auth entry the passkey must not sign, before it is asked to sign
 * anything. The fee-payer key signs the envelope that carries these entries,
 * so an entry that authorizes by source account would authorize as the fee
 * payer, with no passkey involved.
 */
function checkAuthEntries(
  authEntries: xdr.SorobanAuthorizationEntry[],
  walletAddress: string,
): void {
  let forWallet = 0
  for (const entry of authEntries) {
    const cred = entry.credentials()
    if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
      throw new WalletConnectRefusal(
        getSdkError('UNSUPPORTED_ACCOUNTS').code,
        'The request asks for authorization by the transaction source account. This wallet only authorizes as its own contract.',
      )
    }
    const address = Address.fromScAddress(cred.address().address()).toString()
    if (address !== walletAddress) {
      throw new WalletConnectRefusal(
        getSdkError('UNSUPPORTED_ACCOUNTS').code,
        `The request asks for authorization from ${address}, which is not the connected wallet ${walletAddress}.`,
      )
    }
    forWallet++
  }
  // With nothing for the passkey to sign, the fee payer would sign and pay for
  // a transaction the user never authorized.
  if (forWallet === 0) {
    throw new WalletConnectRefusal(
      MALFORMED_REQUEST,
      'The request needs no authorization from this wallet, so there is nothing for it to sign.',
    )
  }
}

async function signXdrPayload(
  xdrString: string,
  walletAddress: string,
): Promise<string> {
  const network = getNetwork()
  const tx = parseRequestTransaction(xdrString, network.networkPassphrase)
  const rpc = getRpcServer()
  const feePayerKeypair = getFeePayerKeypair()

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
  const authEntries = successSim.result?.auth ?? []
  checkAuthEntries(authEntries, walletAddress)

  // A dApp can only be answered by a contract that exists: `__check_auth`
  // runs on chain. Wallets are deployed on first use now, so stop here with
  // a sentence about what to do, instead of asking for a passkey signature
  // the network is guaranteed to reject.
  if ((await getDeploymentState(walletAddress)) === 'undeployed') {
    throw new WalletNotActivatedError(feePayerKeypair.publicKey())
  }

  const networkIdBytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(network.networkPassphrase)),
  )

  for (const parsed of authEntries) {
    // checkAuthEntries has already refused every other credential type.
    const addrCred = parsed.credentials().address()
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

  // Re-simulate with signed auth entries embedded so the simulator runs in
  // `enforce` mode and produces a footprint that includes the wallet
  // contract's instance storage that __check_auth reads.
  const ihfOp = tx.operations[0] as Operation.InvokeHostFunction
  const feePayerAcct = await rpc.getAccount(feePayerKeypair.publicKey())
  const signedTx = new TransactionBuilder(feePayerAcct, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({
      func:   ihfOp.func,
      auth:   authEntries,
      source: ihfOp.source,
    }))
    .setTimeout(30)
    .build()

  const sim2 = await rpc.simulateTransaction(signedTx)
  if (SorobanRpc.Api.isSimulationError(sim2)) {
    // Name the wallet-contract failure when we can. The raw HostError is two
    // thousand characters of diagnostic log with `Error(Contract, #N)` buried in
    // it, and #9 in particular means "retrying will never work" — the opposite
    // of what a generic auth message implies.
    const named = walletContractErrorMessage(sim2.error)
    if (named) {
      console.warn('[soroban] re-simulation failed:', sim2.error)
      throw new Error(named)
    }
    throw new Error(`Re-simulation (enforce mode) failed: ${sim2.error}`)
  }

  const assembled = SorobanRpc.assembleTransaction(signedTx, sim2).build()
  assembled.sign(feePayerKeypair)
  return assembled.toXDR()
}

async function handleSignAndSubmitXdrRequest(
  xdrString: string,
  walletAddress: string,
): Promise<string> {
  const rpc = getRpcServer()
  const signedXDR = await signXdrPayload(xdrString, walletAddress)
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

export function getWalletConnectSep43Wallet(): Sep43Wallet {
  return createSep43Wallet({
    getAddress: async () => walletLocal.getItem('invisible_wallet_address'),
    getNetwork: () => {
      const net = getNetwork()
      return {
        network: net.name === 'mainnet' ? 'PUBLIC' : 'TESTNET',
        networkPassphrase: net.networkPassphrase,
        rpcUrl: net.rpcUrl,
      }
    },
    signTransaction: async (xdrString) => {
      // walletAddress is required: signXdrPayload runs checkAuthEntries against
      // it, which refuses any Soroban auth entry not addressed to this wallet.
      // Passing it is what keeps the SEP-43 path as safe as the direct one.
      const walletAddress = walletLocal.getItem('invisible_wallet_address')
      if (!walletAddress) throw new Error('No wallet registered')
      return signXdrPayload(xdrString, walletAddress)
    },
    signAuthEntry: async (authEntryXdr, opts) => {
      const walletAddress = walletLocal.getItem('invisible_wallet_address')
      if (!walletAddress) throw new Error('No wallet registered')
      const network = getNetwork()
      const rpc = getRpcServer()
      const latestLedger = await rpc.getLatestLedger()
      return signSorobanAuthEntry(authEntryXdr, {
        signerAddress: walletAddress,
        networkPassphrase: opts?.networkPassphrase ?? network.networkPassphrase,
        signPayload: signAuthEntry,
        validUntilLedger: latestLedger.sequence + 100,
        getNonce: async (contractAddress) => getWalletNonce(rpc, contractAddress, network.networkPassphrase),
      })
    },
    signMessage: async (message) => {
      const keyId = walletLocal.getItem('invisible_wallet_key_id')
      if (!keyId) throw new Error('No passkey registered')
      const signed = await sdkSignMessage(
        new TextEncoder().encode(message),
        signAuthEntry,
        keyId
      )
      return JSON.stringify(signed)
    },
    submitTransaction: async (signedXdr) => {
      const network = getNetwork()
      const rpc = getRpcServer()
      const tx = TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase)
      const res = await rpc.sendTransaction(tx)
      if (res.status === 'ERROR') {
        throw new Error(
          `Transaction rejected: ${res.errorResult?.toXDR('base64') ?? 'unknown'}`
        )
      }
      return res.hash
    },
  })
}

function dispatchWalletConnectRequest(event: any): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('wc:request', { detail: event }),
  )
}

/**
 * Answer a `session_request` the user has chosen to approve in
 * `WalletConnectApprovalModal`. Signing additionally needs the passkey: every
 * auth entry is signed by `signAuthEntry`, and a request with no entry for the
 * passkey to sign is refused, so the fee-payer key never signs on its own.
 */
export async function handleSignXdrRequest(event: any): Promise<void> {
  const client = _client
  if (!client) throw new Error('WalletConnect client not initialized.')

  const topic = event.topic
  const method = event.params?.request?.method
  const requestId = getRequestId(event)
  const sep43Wallet = getWalletConnectSep43Wallet()

  // There is no live session to send an error back on, so tell the user
  // instead. Nothing is parsed or signed.
  let walletAddress: string
  try {
    walletAddress = checkRequestSession(client, event)
  } catch (error: unknown) {
    if (!(error instanceof WalletConnectRefusal)) throw error
    if (error.code === getInternalError('EXPIRED').code) {
      _sessions = _sessions.filter((session) => session.topic !== topic)
      persistSessions(_sessions)
      notifySessions()
      throw error
    }
    await client.respondSessionRequest({
      topic,
      response: buildWcError(requestId, error.code, error.message),
    })
    return
  }

  try {
    if (method === 'stellar_signXDR') {
      const requestParams = event.params?.request?.params
      const xdrString = getRequestXdr(requestParams)
      const signedXDR = await signXdrPayload(xdrString, walletAddress)
      rememberApprovals(xdrString)
      await client.respondSessionRequest({
        topic,
        response: buildWcResult(requestId, { signedXDR }),
      })
      return
    }

    if (method === 'stellar_signAndSubmitXDR') {
      const requestParams = event.params?.request?.params
      const xdrString = getRequestXdr(requestParams)
      const txHash = await handleSignAndSubmitXdrRequest(xdrString, walletAddress)
      rememberApprovals(xdrString)
      await client.respondSessionRequest({
        topic,
        response: buildWcResult(requestId, { txHash }),
      })
      return
    }

    if (method === 'stellar_signAuthEntry') {
      const requestParams = event.params?.request?.params
      const authEntryXdr = typeof requestParams === 'string'
        ? requestParams
        : requestParams?.authEntry ?? requestParams?.entry ?? (Array.isArray(requestParams) ? requestParams[0] : '')
      const result = await sep43Wallet.signAuthEntry(authEntryXdr)
      if (result.error) throw new Error(result.error.message)
      await client.respondSessionRequest({
        topic,
        response: buildWcResult(requestId, { signedAuthEntry: result.signedAuthEntry, signerAddress: result.signerAddress }),
      })
      return
    }

    if (method === 'stellar_signMessage') {
      const requestParams = event.params?.request?.params
      const message = typeof requestParams === 'string'
        ? requestParams
        : requestParams?.message ?? (Array.isArray(requestParams) ? requestParams[0] : '')
      const result = await sep43Wallet.signMessage(message)
      if (result.error) throw new Error(result.error.message)
      await client.respondSessionRequest({
        topic,
        response: buildWcResult(requestId, { signedMessage: result.signedMessage, signerAddress: result.signerAddress }),
      })
      return
    }

    if (method === 'stellar_getAccount' || method === 'stellar_getAddress') {
      const result = await sep43Wallet.getAddress()
      if (result.error) throw new Error(result.error.message)
      await client.respondSessionRequest({
        topic,
        response: buildWcResult(requestId, { address: result.address }),
      })
      return
    }

    if (method === 'stellar_getNetwork') {
      const result = await sep43Wallet.getNetwork()
      if (result.error) throw new Error(result.error.message)
      await client.respondSessionRequest({
        topic,
        response: buildWcResult(requestId, result),
      })
      return
    }

    await client.respondSessionRequest({
      topic,
      response: buildWcError(requestId, UNSUPPORTED_METHOD, `Unsupported method: ${String(method)}`),
    })
  } catch (error: unknown) {
    if (error instanceof WalletConnectRefusal) {
      await client.respondSessionRequest({
        topic,
        response: buildWcError(requestId, error.code, error.message),
      })
      return
    }

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

export async function getWalletConnectClient(): Promise<IWalletKit> {
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
  _client = await WalletKit.init({
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

  // A proposal the dApp has given up on can no longer be approved; leaving it
  // pending would offer the user a connect button that cannot work.
  _client.on('proposal_expire', (event: any) => {
    if (_pendingProposal && _pendingProposal.id === event?.id) {
      _pendingProposal = null
      notifyProposal()
    }
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
