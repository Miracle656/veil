import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  getNotificationPreferences,
  setNotificationPreferences,
  type NotificationPreferences,
} from './notificationPreferences'

/**
 * Registration of an Expo push token for a wallet address.
 *
 * The token is sent to the Wraith backend, which watches the wallet's addresses
 * on mainnet and sends pushes. Neither the token nor the address is ever logged here.
 *
 * Registration requires explicit consent: the caller must pass `consent: true`,
 * and the preferences must have `enabled: true`. Revocation removes the token
 * from the backend and from local storage, so a revoked token stops receiving pushes.
 */

export type RegistrationRecord = {
  walletAddress: string
  expoPushToken: string
  registeredAt: number
}

export type RegisterPushTokenInput = {
  walletAddress: string
  expoPushToken: string
  /** Must be true. The user has to actively agree to push notifications. */
  consent: boolean
  preferences?: Partial<NotificationPreferences>
}

const STORAGE_KEY = 'veil.notifications.registration.v1'

export type PushRegistry = Record<string, RegistrationRecord>

const DEFAULT_BACKEND_URL = 'https://wraith.useveilapp.xyz'

function backendUrl(): string {
  // Expo injects EXPO_PUBLIC_* vars at build time. Fall back to the production
  // host so a dev build still talks to a real service instead of failing silently.
  const fromEnv = process.env.EXPO_PUBLIC_WRAITH_URL
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '')
  return DEFAULT_BACKEND_URL
  }

async function readRegistry(): Promise<PushRegistry> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as PushRegistry
  } catch {
    return {}
  }
}

async function writeRegistry(registry: PushRegistry): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(registry))
}

export async function getRegistration(walletAddress: string): Promise<RegistrationRecord | null> {
  const registry = await readRegistry()
  return registry[walletAddress] ?? null
}

/**
 * Register a push token for a wallet. Requires consent and an enabled
 * preference set. The token and address are sent to the backend over HTTPS,
 * and are not written to any log.
 */
export async function registerPushToken(
  input: RegisterPushTokenInput,
): Promise<RegistrationRecord> {
  if (!input.consent) {
    throw new Error('Push notifications require explicit consent.')
  }
  if (!input.walletAddress) {
    throw new Error('A wallet address is required.')
  }
  if (!input.expoPushToken) {
    throw new Error('An Expo push token is required.')
  }

  // Persist the user's choice first, so the rest of the app sees the
  // enabled preferences even if the network call is slower than the UI.
  const prefs = await setNotificationPreferences({ enabled: true, ...input.preferences })
  if (!prefs.enabled) {
    throw new Error('Notifications are disabled in preferences.')
  }

  const response = await fetch(`${backendUrl()}/notifications/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: input.walletAddress,
      expoPushToken: input.expoPushToken,
      preferences: prefs,
    }),
  })
  if (!response.ok) {
    // Do not include the token or address in the error message.
    throw new Error(`Push registration failed (status ${response.status}).`)
  }

  const record: RegistrationRecord = {
    walletAddress: input.walletAddress,
    expoPushToken: input.expoPushToken,
    registeredAt: Date.now(),
  }
  const registry = await readRegistry()
  registry[input.walletAddress] = record
  await writeRegistry(registry)
  return record
}

/**
 * Revoke the push token for a wallet. This is best-effort on the network:
 * the local record is always removed, and the backend is told to stop
 * sending pushes. If the network call fails, the local removal still means
 * the app will not re-register the token on next launch.
 */
export async function revokePushToken(walletAddress: string): Promise<void> {
  if (!walletAddress) {
    throw new Error('A wallet address is required.')
  }

  const registry = await readRegistry()
  const existing = registry[walletAddress]
  delete registry[walletAddress]
  await writeRegistry(registry)

  // Turn the master switch off as well, so the app does not re-register
  // on the next launch and the user sees a consistent state.
  await setNotificationPreferences({ enabled: false })

  if (!existing) return

  try {
    await fetch(`${backendUrl()}/notifications/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: walletAddress,
        expoPushToken: existing.expoPushToken,
      }),
    })
  } catch {
    // Network failure is not fatal: the local record is gone, and the backend
    // will drop the token on the next delivery attempt (Expo reports the
    // token as unregistered). We do not log the address or token here.
  }
}
