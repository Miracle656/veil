'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useContacts } from '@/components/useContacts'
import { VeilLogo } from '@/components/VeilLogo'

export default function ContactsPage() {
  const router = useRouter()
  const { contacts, isLoaded, addContact, removeContact } = useContacts()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await addContact(name, address)
      setName('')
      setAddress('')
      setShowAddForm(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await removeContact(id)
    } catch (err: unknown) {
      console.error('Failed to delete contact', err)
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
        <VeilLogo size={22} />
        <div style={{ width: 40 }} />
      </nav>

      <main className="wallet-main">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.75rem' }}>
          <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem' }}>
            Contacts
          </h2>
          <button
            className="btn-gold"
            style={{ width: 'auto', padding: '0.5rem 1rem', fontSize: '0.8125rem' }}
            onClick={() => { setShowAddForm(!showAddForm); setError(null) }}
          >
            {showAddForm ? 'Cancel' : 'Add contact'}
          </button>
        </div>

        {showAddForm && (
          <form className="card" onSubmit={handleAddSubmit} style={{ marginBottom: '2rem', border: '1px solid var(--gold)' }}>
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
                  onChange={e => setName(e.target.value)}
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
                  onChange={e => setAddress(e.target.value.trim())}
                />
              </div>

              {error && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--teal)' }}>{error}</p>
              )}

              <button type="submit" className="btn-gold" disabled={saving}>
                {saving ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Save contact'}
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
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" style={{ margin: '0 auto 1rem' }}>
                <circle cx="9" cy="7" r="4" stroke="rgba(246,247,248,0.2)" strokeWidth="1.5"/>
                <path d="M2 21v-2a4 4 0 014-4h6a4 4 0 014 4v2" stroke="rgba(246,247,248,0.2)" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M19 8v6m3-3h-6" stroke="rgba(253,218,36,0.4)" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.5rem' }}>
                No contacts saved yet.
              </p>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.25)' }}>
                Add a contact to quickly send to friends and collaborators.
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
                  onClick={() => handleRemove(contact.id)}
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
