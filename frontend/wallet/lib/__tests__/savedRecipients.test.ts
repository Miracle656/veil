/**
 * Storage module for saved cash-out and bill recipients. All values are made-up
 * placeholders. No real account numbers, phone numbers or names appear here.
 */

import {
  MAX_SAVED_PER_KIND,
  SAVED_RECIPIENTS_KEY,
  createSavedRecipientStore,
  parseSavedRecipients,
  type RecipientStorage,
} from '../savedRecipients'

function memoryStorage(initial: Record<string, string> = {}): RecipientStorage & {
  data: Map<string, string>
} {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => {
      data.set(k, v)
    },
    removeItem: (k) => {
      data.delete(k)
    },
  }
}

/** One storage instance per store, so reads see earlier writes. */
function freshStore() {
  const storage = memoryStorage()
  return createSavedRecipientStore(() => storage)
}

const BANK = {
  bankCode: '000',
  bankName: 'Test Bank',
  accountNumber: '0000000000',
  accountName: 'TEST ACCOUNT HOLDER',
}

const BILL = { provider: 'TESTNET', identifier: '08000000000' }

describe('reading saved recipients', () => {
  it('reads an empty list when nothing is stored', () => {
    const store = freshStore()
    expect(store.list()).toEqual({ bank: [], bill: [] })
  })

  it('reads an empty list when storage is unavailable', () => {
    const store = createSavedRecipientStore(() => null)
    expect(store.list()).toEqual({ bank: [], bill: [] })
  })

  it('does not throw when storage access itself throws', () => {
    const store = createSavedRecipientStore(() => {
      throw new Error('blocked')
    })
    expect(() => store.list()).not.toThrow()
    expect(store.list()).toEqual({ bank: [], bill: [] })
  })

  it('reads an empty list for malformed JSON', () => {
    expect(parseSavedRecipients('{not json')).toEqual({ bank: [], bill: [] })
  })

  it('reads an empty list for JSON that is not an object', () => {
    expect(parseSavedRecipients('"hello"')).toEqual({ bank: [], bill: [] })
    expect(parseSavedRecipients('null')).toEqual({ bank: [], bill: [] })
    expect(parseSavedRecipients('[]')).toEqual({ bank: [], bill: [] })
  })

  it('drops bad entries and keeps the good ones', () => {
    const raw = JSON.stringify({
      bank: [
        { id: 'a', bankCode: '000', bankName: 'Test Bank', accountNumber: '0000000000', accountName: 'X' },
        { id: 'b', bankCode: '000', bankName: 'Test Bank', accountNumber: '12ab', accountName: 'X' },
        { id: 'c', bankCode: '', bankName: 'Test Bank', accountNumber: '0000000001', accountName: 'X' },
        'not an object',
        null,
      ],
      bill: [
        { id: 'd', provider: 'TESTNET', identifier: '08000000000' },
        { id: 'e', provider: 'TESTNET', identifier: 'abc' },
      ],
    })
    const parsed = parseSavedRecipients(raw)
    expect(parsed.bank.map((b) => b.id)).toEqual(['a'])
    expect(parsed.bill.map((b) => b.id)).toEqual(['d'])
  })

  it('treats a non-array list as empty without losing the other kind', () => {
    const raw = JSON.stringify({
      bank: 'oops',
      bill: [{ id: 'd', provider: 'TESTNET', identifier: '08000000000' }],
    })
    const parsed = parseSavedRecipients(raw)
    expect(parsed.bank).toEqual([])
    expect(parsed.bill).toHaveLength(1)
  })
})

describe('bank recipients', () => {
  it('adds, lists and removes a bank account', () => {
    const storage = memoryStorage()
    const store = createSavedRecipientStore(() => storage)

    const saved = store.addBank(BANK)
    expect(saved).not.toBeNull()
    expect(store.list().bank).toEqual([saved])

    store.removeBank(saved!.id)
    expect(store.list().bank).toEqual([])
  })

  it('keeps one entry per bank code and account number', () => {
    const store = freshStore()
    store.addBank(BANK)
    store.addBank({ ...BANK, accountName: 'TEST ACCOUNT HOLDER TWO' })
    const bank = store.list().bank
    expect(bank).toHaveLength(1)
    expect(bank[0].accountName).toBe('TEST ACCOUNT HOLDER TWO')
  })

  it('refuses an account number that is not ten digits', () => {
    const store = freshStore()
    expect(store.addBank({ ...BANK, accountNumber: '123' })).toBeNull()
    expect(store.list().bank).toEqual([])
  })

  it('refuses a bank entry with no verified account name', () => {
    const store = freshStore()
    expect(store.addBank({ ...BANK, accountName: '   ' })).toBeNull()
  })
})

describe('bill recipients', () => {
  it('adds, lists and removes a bill recipient', () => {
    const store = freshStore()
    const saved = store.addBill(BILL)
    expect(saved).not.toBeNull()
    expect(store.list().bill).toEqual([saved])

    store.removeBill(saved!.id)
    expect(store.list().bill).toEqual([])
  })

  it('keeps one entry per provider and number', () => {
    const store = freshStore()
    store.addBill(BILL)
    store.addBill(BILL)
    expect(store.list().bill).toHaveLength(1)
  })

  it('refuses a number that is not digits', () => {
    const store = freshStore()
    expect(store.addBill({ provider: 'TESTNET', identifier: '0800-000' })).toBeNull()
    expect(store.addBill({ provider: 'TESTNET', identifier: '12' })).toBeNull()
  })
})

describe('limits and clearing', () => {
  it('caps each kind at the maximum, newest first', () => {
    const store = freshStore()
    for (let i = 0; i < MAX_SAVED_PER_KIND + 5; i++) {
      store.addBill({ provider: 'TESTNET', identifier: `0800000${String(1000 + i)}` })
    }
    const bill = store.list().bill
    expect(bill).toHaveLength(MAX_SAVED_PER_KIND)
    expect(bill[0].identifier).toBe(`0800000${String(1000 + MAX_SAVED_PER_KIND + 4)}`)
  })

  it('returns null from add when the write is refused', () => {
    const storage = memoryStorage()
    storage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    const store = createSavedRecipientStore(() => storage)
    expect(store.addBank(BANK)).toBeNull()
  })

  it('removes everything on clear', () => {
    const storage = memoryStorage()
    const store = createSavedRecipientStore(() => storage)
    store.addBank(BANK)
    store.addBill(BILL)
    store.clear()
    expect(storage.data.has(SAVED_RECIPIENTS_KEY)).toBe(false)
    expect(store.list()).toEqual({ bank: [], bill: [] })
  })

  it('does not throw on clear when storage is blocked', () => {
    const store = createSavedRecipientStore(() => {
      throw new Error('blocked')
    })
    expect(() => store.clear()).not.toThrow()
  })
})
