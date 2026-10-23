'use client'

import { useState } from 'react'
import { useContacts, Contact } from './useContacts'

interface ContactPickerProps {
  onSelect: (contact: Contact) => void
  onClose: () => void
}

export function ContactPicker({ onSelect, onClose }: ContactPickerProps) {
  const { contacts, isLoaded } = useContacts()
  const [searchTerm, setSearchTerm] = useState('')

  const filteredContacts = contacts.filter(c =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.address.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'flex-end',
      zIndex: 1000,
    }}>
      <div className="wallet-shell" style={{
        height: '80vh',
        backgroundColor: 'var(--near-black)',
        borderTopLeftRadius: '1.5rem',
        borderTopRightRadius: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: '1px solid var(--border-dim)',
      }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-dim)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.25rem' }}>
              Contacts
            </h3>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(246,247,248,0.4)', padding: '0.5rem' }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>

          <input
            type="text"
            className="input-field"
            placeholder="Search name or address..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            autoFocus
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
          {!isLoaded ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <div className="spinner spinner-light" style={{ margin: '0 auto' }} />
            </div>
          ) : filteredContacts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
              <p style={{ color: 'rgba(246,247,248,0.4)', fontSize: '0.875rem' }}>
                {searchTerm ? 'No contacts found' : "You haven't saved any contacts yet."}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {filteredContacts.map(contact => (
                <button
                  key={contact.id}
                  onClick={() => onSelect(contact)}
                  className="card"
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    width: '100%',
                    padding: '1rem',
                    transition: 'border-color 0.2s',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--gold)'}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border-dim)'}
                >
                  <div style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: '0.25rem' }}>
                    {contact.name}
                  </div>
                  <div style={{
                    fontFamily: 'Inconsolata, monospace',
                    fontSize: '0.75rem',
                    color: 'rgba(246,247,248,0.4)',
                    wordBreak: 'break-all'
                  }}>
                    {contact.address.slice(0, 12)}...{contact.address.slice(-12)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
