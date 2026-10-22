'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { TransactionBuilder } from '@stellar/stellar-sdk'
import { requirePasskey } from '@/lib/passkeyAuth'
import {
  getWalletConnectClient,
  getWalletConnectSessions,
  handleSignXdrRequest,
} from '@/lib/walletConnect'
import { getNetwork } from '@/lib/network'
import { OriginDisplay } from './OriginDisplay'

type ParsedRequestDetails = {
  operationType: 'payment' | 'contract' | 'unknown'
  amount?: string
  destination?: string
  contractAddress?: string
  functionName?: string
}

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

function parseRequestDetails(request: any): ParsedRequestDetails {
  const xdrString = getRequestXdr(request?.params?.request?.params)
  if (!xdrString) return { operationType: 'unknown' }

  try {
    const tx = TransactionBuilder.fromXDR(xdrString, getNetwork().networkPassphrase)
    const operation = tx.operations?.[0] as any
    if (!operation) return { operationType: 'unknown' }

    if (operation.type === 'payment') {
      return {
        operationType: 'payment',
        amount: typeof operation.amount === 'string' ? operation.amount : undefined,
        destination: typeof operation.destination === 'string' ? operation.destination : undefined,
      }
    }

    if (operation.type === 'invokeHostFunction') {
      let contractAddress = ''
      let functionName = ''
      try {
        const invokeContract = operation.func?.invokeContract?.()
        const contractAddressValue = invokeContract?.contractAddress?.()
        const functionNameValue = invokeContract?.functionName?.()
        if (contractAddressValue && typeof contractAddressValue.toString === 'function') {
          contractAddress = contractAddressValue.toString()
        }
        if (functionNameValue && typeof functionNameValue.toString === 'function') {
          functionName = functionNameValue.toString()
        }
      } catch {
        // Fall through to safe fallback messaging for MVP.
      }

      return {
        operationType: 'contract',
        contractAddress: contractAddress || undefined,
        functionName: functionName || undefined,
      }
    }
  } catch {
    return { operationType: 'unknown' }
  }

  return { operationType: 'unknown' }
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
  const dappUrl = dappMetadata?.url || ''

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
          
          {dappUrl && (
            <OriginDisplay url={dappUrl} />
          )}
        </div>

        <div className="card-md" style={{ marginBottom: '1rem' }}>
          <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)', marginBottom: '0.5rem' }}>
            Operation type
          </p>
          <p style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.875rem' }}>
            {details.operationType === 'payment' ? 'Payment' : details.operationType === 'contract' ? 'Contract call' : 'Unknown'}
          </p>

          {details.operationType === 'payment' && (
            <>
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)' }}>Amount</p>
              <p style={{ fontSize: '0.9rem', marginBottom: '0.625rem' }}>{details.amount || 'Unknown'}</p>
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)' }}>Destination</p>
              <p className="mono" style={{ fontSize: '0.8125rem', wordBreak: 'break-all' }}>
                {details.destination || 'Unknown'}
              </p>
            </>
          )}

          {details.operationType === 'contract' && (
            <>
              {details.contractAddress ? (
                <>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)' }}>Contract address</p>
                  <p className="mono" style={{ fontSize: '0.8125rem', marginBottom: '0.625rem', wordBreak: 'break-all' }}>
                    {details.contractAddress}
                  </p>
                </>
              ) : null}
              {details.functionName ? (
                <>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)' }}>Function name</p>
                  <p style={{ fontSize: '0.9rem' }}>{details.functionName}</p>
                </>
              ) : (
                <p style={{ fontSize: '0.85rem', color: 'rgba(246,247,248,0.65)' }}>
                  Contract interaction — review carefully
                </p>
              )}
            </>
          )}

          {details.operationType === 'unknown' && (
            <p style={{ fontSize: '0.85rem', color: 'rgba(246,247,248,0.65)' }}>
              Contract interaction — review carefully
            </p>
          )}
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
