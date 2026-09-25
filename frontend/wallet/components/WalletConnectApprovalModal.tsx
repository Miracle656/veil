'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Address, scValToNative, TransactionBuilder } from '@stellar/stellar-sdk'
import { requirePasskey } from '@/lib/passkeyAuth'
import {
  getWalletConnectClient,
  getWalletConnectSessions,
  handleSignXdrRequest,
} from '@/lib/walletConnect'
import { getNetwork } from '@/lib/network'

export type ParsedOperation = {
  type: string
  label: string
  destination?: string
  asset?: string
  amount?: string
  contractAddress?: string
  functionName?: string
  arguments: string[]
  depth: number
}

export type ParsedRequestDetails = { operations: ParsedOperation[] }

function getRequestId(event: any): number {
  return Number(event?.id ?? event?.params?.request?.id ?? 0)
}

function getRequestXdr(params: any): string | null {
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
  return null
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (item instanceof Uint8Array) return `0x${Array.from(item).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
      if (item instanceof Map) return Object.fromEntries(item)
      return item
    }) ?? String(value)
  } catch {
    return String(value)
  }
}

function scValText(value: any): string {
  try {
    return safeStringify(scValToNative(value))
  } catch {
    return value?.toString?.() || 'Unable to decode argument'
  }
}

function contractInvocation(invocation: any, depth: number): ParsedOperation[] {
  if (!invocation) return []
  let functionName: string | undefined
  let contractAddress: string | undefined
  let args: string[] = []
  try {
    const func = invocation.function?.()
    const contract = func?.contractFn?.() ?? func?.invokeContract?.()
    const address = contract?.contractAddress?.()
    const name = contract?.functionName?.()
    contractAddress = address?.toString?.()
    functionName = name?.toString?.()
    args = (contract?.args?.() || []).map(scValText)
  } catch {
    // Keep a visible entry even when an SDK version cannot decode an arm.
  }
  const current: ParsedOperation = {
    type: 'invokeHostFunction',
    label: depth ? 'Sub-invocation' : 'Contract call',
    contractAddress,
    functionName,
    arguments: args,
    depth,
  }
  const children = (() => {
    try { return (invocation.subInvocations?.() || []).flatMap((item: any) => contractInvocation(item, depth + 1)) } catch { return [] }
  })()
  return [current, ...children]
}

function hostFunctionOperation(operation: any, depth: number): ParsedOperation {
  let contractAddress: string | undefined
  let functionName: string | undefined
  let args: string[] = []
  try {
    const contract = operation.func?.invokeContract?.()
    contractAddress = Address.fromScAddress(contract.contractAddress()).toString()
    functionName = contract.functionName().toString()
    args = (contract.args?.() || []).map(scValText)
  } catch {
    // Keep a visible contract entry when an SDK version cannot decode an arm.
  }
  return { type: 'invokeHostFunction', label: 'Contract call', contractAddress, functionName, arguments: args, depth }
}

function parseOperation(operation: any, depth = 0): ParsedOperation[] {
  const type = String(operation?.type || 'unknown')
  if (type === 'invokeHostFunction') {
    const children = (() => {
      try { return (operation.auth || []).flatMap((entry: any) => contractInvocation(entry.rootInvocation?.(), depth + 1)) } catch { return [] }
    })()
    return [hostFunctionOperation(operation, depth), ...children]
  }
  const result: ParsedOperation = { type, label: type, arguments: [], depth }
  if (typeof operation?.destination === 'string') result.destination = operation.destination
  if (typeof operation?.amount === 'string') result.amount = operation.amount
  try {
    if (operation?.asset?.isNative?.()) result.asset = 'XLM'
    else result.asset = operation?.asset?.getCode?.() || operation?.asset?.toString?.()
  } catch { /* Keep asset unknown. */ }
  result.label = type === 'payment' ? 'Payment' : type
  return [result]
}

export function parseRequestDetails(request: any): ParsedRequestDetails {
  const xdrString = getRequestXdr(request?.params?.request?.params)
  if (!xdrString) return { operations: [] }

  try {
    const tx = TransactionBuilder.fromXDR(xdrString, getNetwork().networkPassphrase)
    return { operations: (tx.operations || []).flatMap((operation: any) => parseOperation(operation)) }
  } catch {
    return { operations: [{ type: 'unknown', label: 'Unknown', arguments: [], depth: 0 }] }
  }
}

export function WalletConnectApprovalModal() {
  const [isOpen, setIsOpen] = useState(false)
  const [request, setRequest] = useState<any | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getWalletConnectClient().catch(() => {})

    const onWalletConnectRequest = (event: Event) => {
      const customEvent = event as CustomEvent<any>
      setRequest(customEvent.detail ?? null)
      setError(null)
      setIsOpen(true)
    }

    window.addEventListener('wc:request', onWalletConnectRequest as EventListener)
    return () => {
      window.removeEventListener('wc:request', onWalletConnectRequest as EventListener)
    }
  }, [])

  const details = useMemo(() => parseRequestDetails(request), [request])

  const dappMetadata = useMemo(() => {
    if (!request?.topic) return null
    const session = getWalletConnectSessions().find((item) => item.topic === request.topic)
    return session?.peer ?? null
  }, [request])

  const dappName = dappMetadata?.name || 'Unknown dApp'
  const dappIcon = dappMetadata?.icons?.[0]

  const closeModal = useCallback(() => {
    setIsOpen(false)
    setRequest(null)
    setError(null)
  }, [])

  const handleApprove = useCallback(async () => {
    if (!request) return
    setIsSubmitting(true)
    setError(null)
    try {
      await requirePasskey()
      await handleSignXdrRequest(request)
      closeModal()
    } catch (approveError: unknown) {
      const message = approveError instanceof Error ? approveError.message : String(approveError)
      setError(message || 'Failed to approve request.')
    } finally {
      setIsSubmitting(false)
    }
  }, [closeModal, request])

  const handleReject = useCallback(async () => {
    if (!request) return
    setIsSubmitting(true)
    setError(null)
    try {
      const client = await getWalletConnectClient()
      await client.respondSessionRequest({
        topic: request.topic,
        response: {
          id: getRequestId(request),
          jsonrpc: '2.0',
          error: {
            code: 4001,
            message: 'User rejected',
          },
        },
      })
      closeModal()
    } catch (rejectError: unknown) {
      const message = rejectError instanceof Error ? rejectError.message : String(rejectError)
      setError(message || 'Failed to reject request.')
    } finally {
      setIsSubmitting(false)
    }
  }, [closeModal, request])

  if (!isOpen || !request) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'rgba(0, 0, 0, 0.72)',
        display: 'flex',
        alignItems: 'flex-end',
      }}
    >
      <div
        className="card"
        role="dialog"
        aria-modal="true"
        aria-label="WalletConnect transaction approval"
        style={{
          width: '100%',
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          maxHeight: '85dvh',
          overflowY: 'auto',
        }}
      >
        <h3 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.25rem', marginBottom: '1rem' }}>
          Transaction approval
        </h3>

        <div className="card-md" style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {dappIcon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={dappIcon} alt={dappName} width={40} height={40} style={{ borderRadius: '999px' }} />
            ) : (
              <div style={{
                width: 40,
                height: 40,
                borderRadius: '999px',
                border: '1px solid var(--border-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--gold)',
                fontWeight: 700,
              }}>
                {dappName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div>
              <p style={{ fontSize: '0.95rem', fontWeight: 600 }}>{dappName}</p>
              <p style={{ fontSize: '0.8rem', color: 'rgba(246,247,248,0.5)' }}>
                WalletConnect request
              </p>
            </div>
          </div>
        </div>

        <div className="card-md" style={{ marginBottom: '1rem' }}>
          <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)', marginBottom: '0.75rem' }}>
            {details.operations.length} operation{details.operations.length === 1 ? '' : 's'}
          </p>
          {details.operations.length ? details.operations.map((operation, index) => (
            <div key={`${operation.type}-${index}`} style={{ marginBottom: index === details.operations.length - 1 ? 0 : '1rem', paddingLeft: `${operation.depth * 0.875}rem`, borderLeft: operation.depth ? '1px solid var(--border-dim)' : undefined }}>
              <p style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>{operation.label}</p>
              {operation.amount && <p style={{ fontSize: '0.85rem' }}>Amount: {operation.amount}{operation.asset ? ` ${operation.asset}` : ''}</p>}
              {operation.destination && <p className="mono" style={{ fontSize: '0.8125rem', wordBreak: 'break-all' }}>Destination: {operation.destination}</p>}
              {operation.contractAddress && <p className="mono" style={{ fontSize: '0.8125rem', wordBreak: 'break-all' }}>Contract: {operation.contractAddress}</p>}
              {operation.functionName && <p style={{ fontSize: '0.85rem' }}>Function: {operation.functionName}</p>}
              {operation.arguments.map((argument, argumentIndex) => <p className="mono" key={argumentIndex} style={{ fontSize: '0.78rem', wordBreak: 'break-word' }}>Argument {argumentIndex + 1}: {argument}</p>)}
              {!operation.amount && !operation.destination && !operation.contractAddress && !operation.functionName && !operation.arguments.length && <p style={{ fontSize: '0.85rem', color: 'rgba(246,247,248,0.65)' }}>Review this operation carefully</p>}
            </div>
          )) : <p style={{ fontSize: '0.85rem', color: 'rgba(246,247,248,0.65)' }}>Unable to decode operations. Review carefully.</p>}
        </div>

        <div style={{ display: 'grid', gap: '0.625rem' }}>
          <button className="btn-gold" onClick={handleApprove} disabled={isSubmitting}>
            {isSubmitting ? 'Approving...' : 'Approve'}
          </button>
          <button className="btn-ghost" onClick={handleReject} disabled={isSubmitting}>
            Reject
          </button>
        </div>

        {error && (
          <p style={{ marginTop: '0.875rem', color: 'var(--teal)', fontSize: '0.8125rem' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
