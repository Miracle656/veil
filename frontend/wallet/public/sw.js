// Veil Wallet Service Worker
// Handles background Horizon polling for incoming payments and push notifications.

const HORIZON_URL = 'https://horizon-testnet.stellar.org'
const POLL_INTERVAL_MS = 30_000 // 30 seconds
const CURSOR_KEY = 'veil_sw_cursor'
const ACCOUNT_KEY = 'veil_sw_account'

// ── Install / Activate ────────────────────────────────────────────────────────

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

// ── Push notifications (server-sent) ─────────────────────────────────────────

self.addEventListener('push', e => {
  if (!e.data) return
  let data
  try { data = e.data.json() } catch { data = { title: 'Veil', body: e.data.text() } }
  e.waitUntil(
    self.registration.showNotification(data.title ?? 'Veil Wallet', {
      body: data.body ?? 'You have a new notification.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url ?? '/dashboard' },
    })
  )
})

// ── Notification click → deep-link ───────────────────────────────────────────

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const target = e.notification.data?.url ?? '/dashboard'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes('/dashboard'))
      if (existing) return existing.navigate(target).then(c => c?.focus())
      return self.clients.openWindow(target)
    })
  )
})

// ── Message from page: register account for polling ──────────────────────────

self.addEventListener('message', e => {
  if (e.data?.type === 'VEIL_REGISTER_ACCOUNT') {
    const { account, cursor } = e.data
    // Store in SW scope via a simple in-memory map (persists while SW is alive)
    self._account = account
    self._cursor  = cursor ?? 'now'
  }
})

// ── Background polling via setInterval (fires while SW is alive) ─────────────
// Note: Background Sync API has limited browser support; periodic polling via
// setInterval is more broadly supported and sufficient for this use case.

let _polling = false

async function pollIncoming() {
  const account = self._account
  if (!account) return

  const cursor = self._cursor ?? 'now'
  try {
    const url = `${HORIZON_URL}/accounts/${account}/payments?cursor=${cursor}&order=asc&limit=10&include_failed=false`
    const res = await fetch(url)
    if (!res.ok) return
    const data = await res.json()
    const records = data?._embedded?.records ?? []

    for (const op of records) {
      // Update cursor so we don't re-notify
      self._cursor = op.paging_token

      // Only notify for incoming payments to this account
      if (op.type !== 'payment' && op.type !== 'create_account') continue
      const isIncoming = op.to === account || op.account === account
      if (!isIncoming) continue

      const amount = op.amount ?? op.starting_balance ?? '?'
      const asset  = op.asset_type === 'native' ? 'XLM' : (op.asset_code ?? 'token')
      const hash   = op.transaction_hash ?? ''

      await self.registration.showNotification('Veil Wallet — Payment received', {
        body: `+${parseFloat(amount).toFixed(2)} ${asset} received`,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: `veil-tx-${hash}`,
        renotify: false,
        data: { url: `/dashboard?tx=${hash}` },
      })
    }
  } catch {
    // Network error — silently skip this poll cycle
  }
}

// Start polling loop when SW activates
setInterval(pollIncoming, POLL_INTERVAL_MS)
