'use client'

import { PageHeader } from '@/components/ui/primitives'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useContacts } from '@/components/useContacts'
import { VeilMark } from '@/components/ui/VeilMark'

export default function ContactsPage() {
  const router = useRouter()
  const { contacts, isLoaded, addContact, removeContact } = useContacts()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  const canSave = name.trim().length > 0 && address.trim().length > 0

  const closeAddForm = () => {
    setShowAddForm(false)
    setName('')
    setAddress('')
    setError(null)
  }

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    setError(null)
    try {
      addContact(name, address)
      closeAddForm()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="wallet-shell">
      {/* Nav */}
      <nav className="wallet-nav">
        <button
          onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <VeilMark size={22} />
        <div style={{ width: 40 }} />
      </nav>

      <main className="wallet-main">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.75rem' }}>
          <div style={{ marginBottom: '1.75rem' }}>
          <PageHeader eyebrow="Address book" title="Contacts" />
        </div>
          {!showAddForm && (
            <button
              className="btn-gold"
              style={{ width: 'auto', padding: '0.5rem 1rem', fontSize: '0.8125rem' }}
              onClick={() => setShowAddForm(true)}
            >
              Add contact
            </button>
          )}
        </div>

        {showAddForm && (
          <form className="card" onSubmit={handleAddSubmit} style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  NAME
                </label>
                <input
                  className="input-field"
                  type="text"
                  placeholder="e.g. Alice"
                  value={name}
                  onChange={e => { setName(e.target.value); setError(null) }}
                  autoFocus
                />
              </div>

              <div>
                <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  STELLAR ADDRESS
                </label>
                <input
                  className="input-field mono"
                  type="text"
                  placeholder="G..."
                  value={address}
                  onChange={e => { setAddress(e.target.value.trim()); setError(null) }}
                />
              </div>

              {error && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--teal)' }}>{error}</p>
              )}

              {canSave && (
                <button type="submit" className="btn-gold">
                  Save contact
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={closeAddForm}>
                Cancel
              </button>
            </div>
          </form>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {!isLoaded ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <div className="spinner spinner-light" style={{ margin: '0 auto' }} />
            </div>
          ) : contacts.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem 2rem' }}>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)' }}>
                No contacts saved yet.
              </p>
            </div>
          ) : (
            contacts.map(contact => (
              <div key={contact.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: '0.125rem' }}>
                    {contact.name}
                  </p>
                  <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {contact.address.slice(0, 10)}...{contact.address.slice(-10)}
                  </p>
                </div>
                <button
                  onClick={() => removeContact(contact.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(246,247,248,0.3)', padding: '0.5rem' }}
                  title="Delete contact"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  )
}
