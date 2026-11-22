/**
 * Saved recipients for cash-out and bills, kept in this browser only.
 *
 * Personal data, so these rules are fixed:
 * - Stored in localStorage under one key. Never sent to the backend, never
 *   logged, never put in a URL or query string.
 * - Written only when the user ticks "Save for next time". Nothing else calls
 *   `add`.
 * - Cleared by `clearSavedRecipients`, which the wallet calls when its
 *   local data is wiped.
 *
 * Reads never throw. Blocked storage (private windows), a missing key, or
 * malformed JSON all read as an empty list, and bad entries are dropped one by
 * one so a single corrupt record cannot hide the rest.
 *
 * The storage is injected so the logic can be tested without a browser.
 */

export interface SavedBankRecipient {
  id: string
  bankCode: string
  bankName: string
  accountNumber: string
  /** The name the bank returned when the account was verified. */
  accountName: string
}

export interface SavedBillRecipient {
  id: string
  /** Network or provider the bill is paid to, for example "MTN". */
  provider: string
  /** The phone number or meter number the bill is paid against. */
  identifier: string
}

export interface SavedRecipients {
  bank: SavedBankRecipient[]
  bill: SavedBillRecipient[]
}

export type RecipientStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const SAVED_RECIPIENTS_KEY = 'veil_saved_recipients'

/** Enough for everyday use, small enough that the list stays scannable. */
export const MAX_SAVED_PER_KIND = 20

const ACCOUNT_NUMBER = /^\d{10}$/
const BILL_IDENTIFIER = /^\d{4,20}$/
const MAX_TEXT = 120

/** The browser's localStorage, or null when storage is missing or blocked. */
export function browserRecipientStorage(): RecipientStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Blocked storage throws on access in some private windows.
    return null
  }
}

function newId(kind: 'bank' | 'bill'): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

function parseBank(raw: unknown): SavedBankRecipient | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = text(r.id, 80)
  const bankCode = text(r.bankCode, 20)
  const bankName = text(r.bankName)
  const accountNumber = typeof r.accountNumber === 'string' ? r.accountNumber : ''
  const accountName = text(r.accountName)
  if (!id || !bankCode || !bankName || !accountName) return null
  if (!ACCOUNT_NUMBER.test(accountNumber)) return null
  return { id, bankCode, bankName, accountNumber, accountName }
}

function parseBill(raw: unknown): SavedBillRecipient | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = text(r.id, 80)
  const provider = text(r.provider, 40)
  const identifier = typeof r.identifier === 'string' ? r.identifier : ''
  if (!id || !provider) return null
  if (!BILL_IDENTIFIER.test(identifier)) return null
  return { id, provider, identifier }
}

/**
 * Read and validate the stored list. Anything that does not parse is dropped,
 * so the result is always safe to render.
 */
export function parseSavedRecipients(raw: string | null): SavedRecipients {
  const empty: SavedRecipients = { bank: [], bill: [] }
  if (!raw) return empty
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!data || typeof data !== 'object') return empty
  const d = data as Record<string, unknown>
  const bank = Array.isArray(d.bank)
    ? d.bank.map(parseBank).filter((x): x is SavedBankRecipient => x !== null)
    : []
  const bill = Array.isArray(d.bill)
    ? d.bill.map(parseBill).filter((x): x is SavedBillRecipient => x !== null)
    : []
  return { bank: bank.slice(0, MAX_SAVED_PER_KIND), bill: bill.slice(0, MAX_SAVED_PER_KIND) }
}

export interface SavedRecipientStore {
  list(): SavedRecipients
  /** Adds or replaces the bank account with the same code and number. */
  addBank(entry: Omit<SavedBankRecipient, 'id'>): SavedBankRecipient | null
  removeBank(id: string): void
  /** Adds or replaces the bill recipient with the same provider and number. */
  addBill(entry: Omit<SavedBillRecipient, 'id'>): SavedBillRecipient | null
  removeBill(id: string): void
  clear(): void
}

/**
 * A store over one storage area. `storage` is a function so the default
 * localStorage lookup happens at call time, not when the module loads.
 * Every method returns a safe value when storage is unavailable.
 */
export function createSavedRecipientStore(
  storage: () => RecipientStorage | null = browserRecipientStorage,
): SavedRecipientStore {
  const read = (): SavedRecipients => {
    try {
      const store = storage()
      return parseSavedRecipients(store ? store.getItem(SAVED_RECIPIENTS_KEY) : null)
    } catch {
      return { bank: [], bill: [] }
    }
  }

  // Returns false when the write is refused, for example a full quota.
  const write = (next: SavedRecipients): boolean => {
    try {
      const store = storage()
      if (!store) return false
      store.setItem(SAVED_RECIPIENTS_KEY, JSON.stringify(next))
      return true
    } catch {
      return false
    }
  }

  return {
    list: read,

    addBank(entry) {
      const bankCode = text(entry.bankCode, 20)
      const bankName = text(entry.bankName)
      const accountName = text(entry.accountName)
      if (!bankCode || !bankName || !accountName) return null
      if (!ACCOUNT_NUMBER.test(entry.accountNumber)) return null
      const record: SavedBankRecipient = {
        id: newId('bank'),
        bankCode,
        bankName,
        accountNumber: entry.accountNumber,
        accountName,
      }
      const current = read()
      const others = current.bank.filter(
        (b) => !(b.bankCode === record.bankCode && b.accountNumber === record.accountNumber),
      )
      const bank = [record, ...others].slice(0, MAX_SAVED_PER_KIND)
      return write({ ...current, bank }) ? record : null
    },

    removeBank(id) {
      const current = read()
      write({ ...current, bank: current.bank.filter((b) => b.id !== id) })
    },

    addBill(entry) {
      const provider = text(entry.provider, 40)
      if (!provider || !BILL_IDENTIFIER.test(entry.identifier)) return null
      const record: SavedBillRecipient = {
        id: newId('bill'),
        provider,
        identifier: entry.identifier,
      }
      const current = read()
      const others = current.bill.filter(
        (b) => !(b.provider === record.provider && b.identifier === record.identifier),
      )
      const bill = [record, ...others].slice(0, MAX_SAVED_PER_KIND)
      return write({ ...current, bill }) ? record : null
    },

    removeBill(id) {
      const current = read()
      write({ ...current, bill: current.bill.filter((b) => b.id !== id) })
    },

    clear() {
      try {
        storage()?.removeItem(SAVED_RECIPIENTS_KEY)
      } catch {
        /* blocked — nothing stored to remove */
      }
    },
  }
}

/** The store the pages use, backed by this browser's localStorage. */
export const savedRecipients = createSavedRecipientStore()

/** Called when the wallet's local data is wiped. */
export function clearSavedRecipients(): void {
  savedRecipients.clear()
}
