'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  fetchWalletNFTs,
  formatTokenId,
  truncateAddress,
  FIXTURE_NFTS,
  type NFTItem,
} from '@/lib/nfts'

export default function NFTGalleryPage() {
  const router = useRouter()
  useInactivityLock()

  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [nfts, setNfts] = useState<NFTItem[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'fixtures' | 'onchain'>('all')
  const [simulateEmpty, setSimulateEmpty] = useState(false)
  const [selectedNFT, setSelectedNFT] = useState<NFTItem | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showRawJson, setShowRawJson] = useState(false)
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({})

  // Load wallet session
  useEffect(() => {
    const stored =
      sessionStorage.getItem('invisible_wallet_address') ||
      localStorage.getItem('invisible_wallet_address')
    if (stored) {
      setWalletAddress(stored)
    }
  }, [])

  // Load NFTs
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const items = await fetchWalletNFTs(walletAddress || 'GDEMO...WALLET', {
        includeFixtures: true,
      })
      setNfts(items)
    } catch {
      setNfts(FIXTURE_NFTS)
    } finally {
      setLoading(false)
    }
  }, [walletAddress])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Copy helper
  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  // Filtered NFTs list
  const filteredNFTs = useMemo(() => {
    if (simulateEmpty) return []

    return nfts.filter(nft => {
      // Filter tab
      if (filterType === 'fixtures' && !nft.isFixture) return false
      if (filterType === 'onchain' && nft.isFixture) return false

      // Search query
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase().trim()
      const matchName = nft.name.toLowerCase().includes(q)
      const matchSymbol = nft.symbol.toLowerCase().includes(q)
      const matchCollection = (nft.collectionName || '').toLowerCase().includes(q)
      const matchContract = nft.contractId.toLowerCase().includes(q)
      const matchTokenId = String(nft.tokenId).toLowerCase().includes(q)

      return matchName || matchSymbol || matchCollection || matchContract || matchTokenId
    })
  }, [nfts, searchQuery, filterType, simulateEmpty])

  return (
    <div className="wallet-shell" style={{ minHeight: '100vh', background: 'var(--near-black)' }}>
      {/* ── Header ── */}
      <header className="wallet-nav" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-dim)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={() => router.push('/dashboard')}
            style={{
              background: 'var(--surface-md)',
              border: '1px solid var(--border-dim)',
              borderRadius: '8px',
              color: 'var(--off-white)',
              padding: '0.5rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 150ms var(--ease)',
            }}
            title="Back to Dashboard"
            aria-label="Back to Dashboard"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <div>
            <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontSize: '1.25rem', letterSpacing: '0.08em', color: 'var(--gold)', userSelect: 'none' }}>
              VEIL
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.5rem', padding: '0.15rem 0.5rem', background: 'rgba(253,218,36,0.1)', border: '1px solid rgba(253,218,36,0.25)', borderRadius: '4px', fontFamily: 'Inconsolata, monospace' }}>
              CAP-46
            </span>
          </div>
        </div>

        {walletAddress && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="address-chip" style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
              {truncateAddress(walletAddress)}
            </span>
          </div>
        )}
      </header>

      {/* ── Main Content ── */}
      <main className="wallet-main" style={{ maxWidth: '1100px', margin: '0 auto', padding: '2rem 1.5rem 4rem' }}>
        {/* Title & Banner */}
        <div style={{ marginBottom: '2rem', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.375rem' }}>
              <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '2rem', color: 'var(--off-white)' }}>
                NFT Gallery
              </h1>
              <span style={{ background: 'linear-gradient(135deg, var(--teal), var(--navy))', color: '#FFF', fontSize: '0.75rem', fontWeight: 600, padding: '0.2rem 0.6rem', borderRadius: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Soroban Standard
              </span>
            </div>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', maxWidth: '600px' }}>
              Detecting CAP-46 smart contract non-fungible tokens in your wallet. Renders metadata, media assets, and trait attributes indexed via Wraith & Soroban RPC.
            </p>
          </div>

          {/* Quick controls / Empty state toggle for AC testing */}
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <button
              onClick={() => setSimulateEmpty(!simulateEmpty)}
              style={{
                fontSize: '0.8125rem',
                fontWeight: 500,
                padding: '0.5rem 0.875rem',
                borderRadius: '8px',
                background: simulateEmpty ? 'rgba(253,218,36,0.15)' : 'var(--surface-md)',
                border: `1px solid ${simulateEmpty ? 'var(--gold)' : 'var(--border-dim)'}`,
                color: simulateEmpty ? 'var(--gold)' : 'var(--off-white)',
                cursor: 'pointer',
                transition: 'all 150ms var(--ease)',
              }}
              title="Toggle empty state mode for testing"
            >
              {simulateEmpty ? '✦ Showing Empty State' : 'Simulate Empty State'}
            </button>
            <button
              onClick={loadData}
              disabled={loading}
              style={{
                fontSize: '0.8125rem',
                padding: '0.5rem 0.75rem',
                borderRadius: '8px',
                background: 'var(--surface-md)',
                border: '1px solid var(--border-dim)',
                color: 'var(--off-white)',
                cursor: 'pointer',
              }}
              title="Refresh NFTs"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}>
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Search & Filter Controls ── */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '2rem', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Search box */}
          <div style={{ flex: '1 1 280px', position: 'relative' }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search by NFT name, symbol, or contract ID..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="input-field"
              style={{
                width: '100%',
                paddingLeft: '2.5rem',
                paddingRight: '1rem',
                paddingTop: '0.625rem',
                paddingBottom: '0.625rem',
                borderRadius: '10px',
                fontSize: '0.875rem',
                background: 'var(--surface-md)',
                border: '1px solid var(--border-dim)',
                color: 'var(--off-white)',
                outline: 'none',
              }}
            />
          </div>

          {/* Filter Pills */}
          <div style={{ display: 'flex', gap: '0.5rem', background: 'var(--surface)', padding: '0.25rem', borderRadius: '10px', border: '1px solid var(--border-dim)' }}>
            {(['all', 'fixtures', 'onchain'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setFilterType(tab)}
                style={{
                  padding: '0.4rem 0.875rem',
                  fontSize: '0.8125rem',
                  fontWeight: 500,
                  borderRadius: '8px',
                  background: filterType === tab ? 'var(--surface-md)' : 'transparent',
                  color: filterType === tab ? 'var(--gold)' : 'var(--text-muted)',
                  border: filterType === tab ? '1px solid var(--border-dim)' : 'none',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                  transition: 'all 120ms var(--ease)',
                }}
              >
                {tab === 'all' ? 'All NFTs' : tab === 'fixtures' ? 'Fixtures' : 'On-Chain'}
              </button>
            ))}
          </div>
        </div>

        {/* ── Loading Skeleton ── */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1.5rem' }}>
            {[1, 2, 3].map(i => (
              <div
                key={i}
                className="skeleton"
                style={{ height: '380px', borderRadius: '16px', border: '1px solid var(--border-dim)' }}
              />
            ))}
          </div>
        ) : filteredNFTs.length === 0 ? (
          /* ── Empty State ── */
          <div
            style={{
              textAlign: 'center',
              padding: '4rem 2rem',
              background: 'var(--surface)',
              border: '1px dashed var(--border-dim)',
              borderRadius: '20px',
              maxWidth: '560px',
              margin: '2rem auto',
            }}
          >
            <div
              style={{
                width: '64px',
                height: '64px',
                margin: '0 auto 1.5rem',
                borderRadius: '50%',
                background: 'rgba(253,218,36,0.1)',
                border: '1px solid rgba(253,218,36,0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--gold)',
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
            <h3 style={{ fontFamily: 'Lora, Georgia, serif', fontStyle: 'italic', fontSize: '1.375rem', marginBottom: '0.5rem', color: 'var(--off-white)' }}>
              No CAP-46 NFTs Found
            </h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1.75rem', lineHeight: 1.6 }}>
              {simulateEmpty
                ? 'Simulated empty state mode is active. Tap below or turn off the toggle to display fixture NFTs.'
                : searchQuery
                ? `No NFTs matching "${searchQuery}". Try clearing your search query.`
                : 'This wallet address currently holds no CAP-46 non-fungible token balances.'}
            </p>

            <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
              {simulateEmpty && (
                <button
                  className="btn-gold"
                  onClick={() => setSimulateEmpty(false)}
                  style={{ fontSize: '0.875rem', padding: '0.625rem 1.5rem' }}
                >
                  Show Fixture NFTs
                </button>
              )}
              {searchQuery && (
                <button
                  className="btn-ghost"
                  onClick={() => setSearchQuery('')}
                  style={{ fontSize: '0.875rem', padding: '0.625rem 1.25rem' }}
                >
                  Clear Search
                </button>
              )}
            </div>
          </div>
        ) : (
          /* ── NFT Cards Grid ── */
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '1.5rem' }}>
            {filteredNFTs.map(nft => (
              <div
                key={nft.id}
                onClick={() => setSelectedNFT(nft)}
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border-dim)',
                  borderRadius: '16px',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'all 200ms var(--ease)',
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = 'rgba(253, 218, 36, 0.4)'
                  e.currentTarget.style.transform = 'translateY(-4px)'
                  e.currentTarget.style.boxShadow = '0 12px 24px -10px rgba(0,0,0,0.5)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'var(--border-dim)'
                  e.currentTarget.style.transform = 'none'
                  e.currentTarget.style.boxShadow = 'none'
                }}
              >
                {/* Image Media Box */}
                <div style={{ position: 'relative', width: '100%', aspectRatio: '1/1', background: 'rgba(255,255,255,0.02)', overflow: 'hidden' }}>
                  {!failedImages[nft.id] ? (
                    <Image
                      src={nft.image}
                      alt={nft.name}
                      fill
                      sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                      unoptimized
                      style={{ objectFit: 'cover' }}
                      onError={() => setFailedImages(prev => ({ ...prev, [nft.id]: true }))}
                    />
                  ) : (
                    /* Fallback Image Generator */
                    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #1f1c2c, #928dab)', padding: '1rem', textAlign: 'center' }}>
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      <span style={{ fontSize: '0.875rem', fontWeight: 600, marginTop: '0.5rem', color: '#FFF' }}>{nft.name}</span>
                    </div>
                  )}

                  {/* Top Badges */}
                  <div style={{ position: 'absolute', top: '0.75rem', left: '0.75rem', display: 'flex', gap: '0.5rem' }}>
                    <span style={{ background: 'rgba(15,15,15,0.85)', backdropFilter: 'blur(6px)', color: 'var(--gold)', fontSize: '0.75rem', fontWeight: 600, padding: '0.2rem 0.5rem', borderRadius: '6px', border: '1px solid rgba(253,218,36,0.3)' }}>
                      {formatTokenId(nft.tokenId)}
                    </span>
                  </div>

                  {nft.isFixture && (
                    <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem' }}>
                      <span style={{ background: 'rgba(0,167,181,0.85)', backdropFilter: 'blur(6px)', color: '#FFF', fontSize: '0.7rem', fontWeight: 600, padding: '0.2rem 0.5rem', borderRadius: '6px' }}>
                        Fixture NFT
                      </span>
                    </div>
                  )}
                </div>

                {/* Card Info */}
                <div style={{ padding: '1.25rem', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                  <div>
                    {nft.collectionName && (
                      <p style={{ fontSize: '0.75rem', color: 'var(--teal)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
                        {nft.collectionName}
                      </p>
                    )}
                    <h3 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontSize: '1.125rem', color: 'var(--off-white)', marginBottom: '0.5rem', lineHeight: 1.3 }}>
                      {nft.name}
                    </h3>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginBottom: '1rem' }}>
                      {nft.description}
                    </p>
                  </div>

                  <div>
                    {/* Contract Address & Copy */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0.6rem', background: 'var(--surface-md)', borderRadius: '6px', marginBottom: '0.75rem' }}>
                      <span style={{ fontSize: '0.75rem', fontFamily: 'Inconsolata, monospace', color: 'var(--text-muted)' }}>
                        Contract: {truncateAddress(nft.contractId, 5, 5)}
                      </span>
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          handleCopy(nft.contractId, nft.id)
                        }}
                        style={{ background: 'none', border: 'none', color: copiedId === nft.id ? 'var(--teal)' : 'var(--text-muted)', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
                        title="Copy contract ID"
                      >
                        {copiedId === nft.id ? 'Copied' : 'Copy'}
                      </button>
                    </div>

                    {/* Traits tags */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                      {nft.attributes.slice(0, 3).map((attr, idx) => (
                        <span key={idx} style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.05)', color: 'rgba(246,247,248,0.8)', padding: '0.2rem 0.5rem', borderRadius: '4px', border: '1px solid var(--border-dim)' }}>
                          <strong style={{ color: 'var(--gold)' }}>{attr.trait_type}:</strong> {attr.value}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* ── Detail View Modal ── */}
      {selectedNFT && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            background: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
          }}
          onClick={() => {
            setSelectedNFT(null)
            setShowRawJson(false)
          }}
        >
          <div
            style={{
              background: '#141414',
              border: '1px solid var(--border-dim)',
              borderRadius: '20px',
              maxWidth: '800px',
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              boxShadow: '0 25px 50px -12px rgba(0,0,0,0.7)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '1.5rem 2rem', borderBottom: '1px solid var(--border-dim)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--teal)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {selectedNFT.collectionName || 'Soroban CAP-46 NFT'}
                </span>
                <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontSize: '1.5rem', color: 'var(--off-white)' }}>
                  {selectedNFT.name}
                </h2>
              </div>
              <button
                onClick={() => {
                  setSelectedNFT(null)
                  setShowRawJson(false)
                }}
                style={{ background: 'var(--surface-md)', border: 'none', color: 'var(--off-white)', width: '32px', height: '32px', borderRadius: '50%', cursor: 'pointer', fontSize: '1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '2rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '2rem' }}>
              {/* Media Preview */}
              <div>
                <div style={{ position: 'relative', width: '100%', aspectRatio: '1/1', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--border-dim)' }}>
                  <Image
                    src={selectedNFT.image}
                    alt={selectedNFT.name}
                    fill
                    unoptimized
                    style={{ objectFit: 'cover' }}
                  />
                </div>
              </div>

              {/* Metadata Details */}
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                    Description
                  </h4>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
                    {selectedNFT.description}
                  </p>

                  <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
                    Contract Properties
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem', background: 'var(--surface)', padding: '1rem', borderRadius: '10px', border: '1px solid var(--border-dim)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Standard</span>
                      <span style={{ color: 'var(--off-white)', fontWeight: 600 }}>{selectedNFT.standard}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Token ID</span>
                      <span style={{ color: 'var(--off-white)', fontWeight: 600 }}>{selectedNFT.tokenId}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Contract ID</span>
                      <span style={{ fontFamily: 'Inconsolata, monospace', color: 'var(--gold)' }}>{truncateAddress(selectedNFT.contractId, 6, 6)}</span>
                    </div>
                  </div>

                  {/* Attributes */}
                  <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
                    Traits & Attributes
                  </h4>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', marginBottom: '1.5rem' }}>
                    {selectedNFT.attributes.map((attr, idx) => (
                      <div key={idx} style={{ background: 'var(--surface-md)', padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid var(--border-dim)' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{attr.trait_type}</div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--off-white)', fontWeight: 600, marginTop: '0.1rem' }}>{attr.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Raw JSON toggle */}
                <div>
                  <button
                    onClick={() => setShowRawJson(!showRawJson)}
                    style={{ background: 'none', border: 'none', color: 'var(--teal)', fontSize: '0.8125rem', cursor: 'pointer', padding: 0, marginBottom: '0.75rem', fontWeight: 500 }}
                  >
                    {showRawJson ? '▼ Hide Raw Metadata' : '▶ View Raw JSON Metadata'}
                  </button>

                  {showRawJson && (
                    <pre style={{ background: '#000', padding: '1rem', borderRadius: '8px', fontSize: '0.75rem', color: '#00FFC8', overflowX: 'auto', maxHeight: '150px', marginBottom: '1rem', border: '1px solid var(--border-dim)' }}>
                      {JSON.stringify(selectedNFT.rawMetadata || selectedNFT, null, 2)}
                    </pre>
                  )}

                  <a
                    href={`https://stellar.expert/explorer/testnet/contract/${selectedNFT.contractId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-ghost"
                    style={{ display: 'block', textAlign: 'center', padding: '0.625rem 1rem', fontSize: '0.875rem', textDecoration: 'none' }}
                  >
                    View Contract on Stellar Expert ↗
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
