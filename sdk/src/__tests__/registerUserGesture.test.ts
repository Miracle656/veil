/**
 * Registration must reach the WebAuthn prompt without leaving the click's task.
 *
 * Written from a live failure: a person on iOS tapped Create wallet in Safari
 * and got `NotAllowedError`, then succeeded in Chrome on the same phone minutes
 * later. Both are WebKit, so the engine was not the difference — the user
 * activation was. Safari will not carry transient activation across awaits that
 * Chromium tolerates, and `register()` had three awaited storage reads between
 * the click and `navigator.credentials.create()`.
 *
 * On a localStorage-backed store none of those reads needed to be async at all.
 * They are now only awaited when the adapter genuinely returns a promise.
 *
 * The assertion below is deliberately strict: `create` must have been called
 * **synchronously**, before `register()` yields even once. An `await` on an
 * already-resolved value still costs a microtask hop, and a test that awaited
 * the result first would pass with the bug fully reinstated.
 */

import { InvisibleWalletCore } from '../core'
import { webAuthnProvider } from '../webauthn'

jest.mock('../webauthn', () => ({
  webAuthnProvider: {
    create: jest.fn(),
    authenticate: jest.fn(),
  },
}))

/** A synchronous adapter, exactly like the localStorage one the web app uses. */
function syncStore() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

/** An adapter that genuinely defers, like AsyncStorage on React Native. */
function asyncStore() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => Promise.resolve(map.get(k) ?? null),
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
  }
}

function makeWallet(storage: ReturnType<typeof syncStore> | ReturnType<typeof asyncStore>) {
  return new InvisibleWalletCore({
    network: 'testnet',
    storage,
  } as unknown as ConstructorParameters<typeof InvisibleWalletCore>[0])
}

beforeEach(() => {
  jest.clearAllMocks()
  // Never resolves: the ceremony is irrelevant here, only when it is reached.
  ;(webAuthnProvider.create as jest.Mock).mockReturnValue(new Promise(() => {}))
})

describe('user activation survives the path to the passkey prompt', () => {
  it('calls credentials.create synchronously when the store is synchronous', () => {
    const wallet = makeWallet(syncStore())

    // Deliberately not awaited. If anything on the way to the prompt awaits —
    // even an already-resolved value — create has not run by this line, and
    // Safari would have dropped the gesture by the time it did.
    void wallet.register('alice')

    expect(webAuthnProvider.create).toHaveBeenCalledTimes(1)
  })

  it('still reaches the prompt on a store that genuinely defers', async () => {
    // React Native's AsyncStorage. Mobile does not run this ceremony in a
    // browser, so the gesture rule does not apply and awaiting is correct.
    const wallet = makeWallet(asyncStore())

    void wallet.register('bob')
    // Not yet: a deferring store necessarily costs at least one turn, which is
    // exactly the behaviour the synchronous path above exists to avoid.
    expect(webAuthnProvider.create).not.toHaveBeenCalled()

    // Drain the queue properly rather than counting ticks by hand.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(webAuthnProvider.create).toHaveBeenCalledTimes(1)
  })

  it('passes a user id and exclude list built from the same sync read', () => {
    const store = syncStore()
    store.setItem('invisible_wallet_key_id', 'existing-credential-id')
    const wallet = makeWallet(store)

    void wallet.register('carol')

    const args = (webAuthnProvider.create as jest.Mock).mock.calls[0][0]
    expect(args.userId).toBeInstanceOf(Uint8Array)
    expect(args.userId.byteLength).toBe(16)
    // The guard against an authenticator silently replacing a resident
    // credential must survive the synchronous path.
    expect(args.excludeCredentials).toEqual([
      { id: 'existing-credential-id', transports: undefined },
    ])
  })
})
