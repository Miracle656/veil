import { jest, describe, it, expect, afterEach } from '@jest/globals'
import { Keypair } from '@stellar/stellar-sdk'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { buildChallengePayload } from '../auth.js'

// ── Shared mock for agent ─────────────────────────────────────────────────────
const mockRunAgent: any = jest.fn()

jest.unstable_mockModule('../agent.js', () => ({
  runAgent: mockRunAgent,
}))

// Dynamic import AFTER mock registration
const { createAgentServer } = await import('../server.js')
type AgentServerInstance = import('../server.js').AgentServerInstance

describe('WebSocket Server Resource Bounding & Security', () => {
  let serverInstance: AgentServerInstance | null = null
  let serverUrl: string = ''
  let activeClients: WebSocket[] = []

  const createTestClient = (url: string = serverUrl, origin: string = 'http://localhost:3000'): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { origin } })
      activeClients.push(ws)
      ws.on('open', () => resolve(ws))
      ws.on('error', (err) => reject(err))
    })
  }

  const sendAndWait = (ws: WebSocket, payload: Record<string, unknown>, matchTypes: string[]): Promise<any> => {
    return new Promise((resolve) => {
      const handler = (data: any) => {
        const parsed = JSON.parse(data.toString())
        if (matchTypes.includes(parsed.type)) {
          ws.off('message', handler)
          resolve(parsed)
        }
      }
      ws.on('message', handler)
      ws.send(JSON.stringify(payload))
    })
  }

  const authenticateClient = async (ws: WebSocket, kp: Keypair = Keypair.random()): Promise<{ sessionToken: string; walletAddress: string }> => {
    const walletAddress = kp.publicKey()
    const challengeRes = await sendAndWait(
      ws,
      { type: 'auth_challenge', walletAddress },
      ['auth_challenge', 'error'],
    )
    if (challengeRes.type !== 'auth_challenge') {
      throw new Error(`Challenge failed: ${challengeRes.message}`)
    }
    const sigHex = Buffer.from(
      kp.sign(Buffer.from(buildChallengePayload(walletAddress, challengeRes.challenge), 'utf8')),
    ).toString('hex')

    const verifyRes = await sendAndWait(
      ws,
      { type: 'auth_verify', walletAddress, challenge: challengeRes.challenge, signature: sigHex },
      ['authenticated', 'error'],
    )
    if (verifyRes.type !== 'authenticated') {
      throw new Error(`Verify failed: ${verifyRes.message}`)
    }
    return { sessionToken: verifyRes.sessionToken, walletAddress }
  }

  afterEach(async () => {
    for (const ws of activeClients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate()
      }
    }
    activeClients = []

    if (serverInstance) {
      await serverInstance.close()
      serverInstance = null
    }
    jest.clearAllMocks()
  })

  // ── maxPayload enforcement ──────────────────────────────────────────────────
  it('rejects oversized messages without allocating/processing payload', async () => {
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      maxPayload: 1024,
      allowedOrigins: ['http://localhost:3000'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    const ws = await createTestClient(serverUrl)

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() })
      })
    })

    const largeMessage = JSON.stringify({
      type: 'chat',
      message: 'x'.repeat(2048),
    })

    ws.send(largeMessage)

    const { code } = await closePromise
    expect(code).toBe(1009)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  // ── Global concurrent connection cap ────────────────────────────────────────
  it('enforces total concurrent connection cap', async () => {
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      maxTotalConnections: 2,
      maxConnectionsPerIp: 10,
      allowedOrigins: ['http://localhost:3000'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    const ws1 = await createTestClient(serverUrl)
    const ws2 = await createTestClient(serverUrl)
    expect(ws1.readyState).toBe(WebSocket.OPEN)
    expect(ws2.readyState).toBe(WebSocket.OPEN)

    await expect(createTestClient(serverUrl)).rejects.toThrow(/503/)
  })

  // ── Per-IP concurrent connection cap ────────────────────────────────────────
  it('enforces per-remote-address connection cap', async () => {
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      maxTotalConnections: 50,
      maxConnectionsPerIp: 2,
      allowedOrigins: ['http://localhost:3000'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    const ws1 = await createTestClient(serverUrl)
    const ws2 = await createTestClient(serverUrl)
    expect(ws1.readyState).toBe(WebSocket.OPEN)
    expect(ws2.readyState).toBe(WebSocket.OPEN)

    await expect(createTestClient(serverUrl)).rejects.toThrow(/429/)

    ws1.terminate()
    await new Promise((r) => setTimeout(r, 50))

    const ws3 = await createTestClient(serverUrl)
    expect(ws3.readyState).toBe(WebSocket.OPEN)
  })

  // ── Rate limiting survives reconnection ──────────────────────────────────────
  it('enforces rate limits across client reconnections', async () => {
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      rateMaxMessages: 2,
      rateWindowMs: 60_000,
      allowedOrigins: ['http://localhost:3000'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    mockRunAgent.mockResolvedValue({
      response: 'Hello!',
    })

    const wallet = Keypair.random()
    const ws1 = await createTestClient(serverUrl)
    const { sessionToken } = await authenticateClient(ws1, wallet)

    const sendChat = (ws: WebSocket, msg: string): Promise<any> =>
      sendAndWait(ws, { type: 'chat', sessionToken, message: msg }, ['response', 'error'])

    const res1 = await sendChat(ws1, 'Message 1')
    expect(res1.type).toBe('response')

    const res2 = await sendChat(ws1, 'Message 2')
    expect(res2.type).toBe('response')

    ws1.close()
    await new Promise((r) => setTimeout(r, 50))

    const ws2 = await createTestClient(serverUrl)

    const res3 = await sendChat(ws2, 'Message 3')
    expect(res3.type).toBe('error')
    expect(res3.message).toMatch(/Rate limit exceeded/)
  })

  // ── Generic error masking ───────────────────────────────────────────────────
  it('masks internal error messages and does not leak raw err.message to clients', async () => {
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      allowedOrigins: ['http://localhost:3000'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    mockRunAgent.mockRejectedValue(new Error('Sensitive Anthropic API internal failure sk-ant-secret-key-12345'))

    const ws = await createTestClient(serverUrl)
    await authenticateClient(ws)

    const errorRes = await sendAndWait(
      ws,
      { type: 'chat', message: 'Hello' },
      ['error'],
    )
    expect(errorRes.type).toBe('error')
    expect(errorRes.message).not.toContain('Sensitive Anthropic API internal failure')
    expect(errorRes.message).not.toContain('sk-ant-secret-key-12345')
    expect(errorRes.message).toBe('An internal error occurred. Please try again later.')
  })

  // ── Origin and Access Control ───────────────────────────────────────────────
  it('rejects unauthorized origins', async () => {
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      allowedOrigins: ['https://veil.app'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    await expect(createTestClient(serverUrl, 'https://evil.com')).rejects.toThrow(/403/)
  })

  // ── Wallet Authentication & Session Security (Issue #1314) ──────────────────
  it('rejects unauthenticated chat and clear_history messages', async () => {
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      allowedOrigins: ['http://localhost:3000'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    const victim = Keypair.random()
    serverInstance.conversations.set(victim.publicKey(), [{ role: 'user', content: 'secret' }])

    const ws = await createTestClient(serverUrl)

    const unauthChat = await sendAndWait(
      ws,
      { type: 'chat', walletAddress: victim.publicKey(), message: 'Hello' },
      ['error', 'response'],
    )
    expect(unauthChat.type).toBe('error')
    expect(unauthChat.message).toMatch(/Authentication required/i)
    expect(mockRunAgent).not.toHaveBeenCalled()

    const unauthClear = await sendAndWait(
      ws,
      { type: 'clear_history', walletAddress: victim.publicKey() },
      ['error', 'history_cleared'],
    )
    expect(unauthClear.type).toBe('error')
    expect(unauthClear.message).toMatch(/Authentication required/i)
    expect(serverInstance.conversations.get(victim.publicKey())).toHaveLength(1)
  })

  it('refuses a replayed challenge and rejects an expired session on WebSocket', async () => {
    let now = 10_000
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      allowedOrigins: ['http://localhost:3000'],
      authOptions: {
        challengeTtlMs: 5_000,
        sessionTtlMs: 10_000,
        now: () => now,
      },
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    const wallet = Keypair.random()
    const ws = await createTestClient(serverUrl)

    const ch = await sendAndWait(
      ws,
      { type: 'auth_challenge', walletAddress: wallet.publicKey() },
      ['auth_challenge'],
    )
    const sigHex = Buffer.from(
      wallet.sign(Buffer.from(buildChallengePayload(wallet.publicKey(), ch.challenge), 'utf8')),
    ).toString('hex')

    const verified = await sendAndWait(
      ws,
      { type: 'auth_verify', walletAddress: wallet.publicKey(), challenge: ch.challenge, signature: sigHex },
      ['authenticated', 'error'],
    )
    expect(verified.type).toBe('authenticated')

    // Replaying the same challenge + signature is refused
    const replay = await sendAndWait(
      ws,
      { type: 'auth_verify', walletAddress: wallet.publicKey(), challenge: ch.challenge, signature: sigHex },
      ['authenticated', 'error'],
    )
    expect(replay.type).toBe('error')
    expect(replay.message).toMatch(/invalid or has already been used/i)

    // Advance past session expiry (10_000ms)
    now += 10_001
    const expiredChat = await sendAndWait(
      ws,
      { type: 'chat', message: 'Are you still there?' },
      ['error', 'response'],
    )
    expect(expiredChat.type).toBe('error')
    expect(expiredChat.message).toMatch(/expired/i)
  })

  it('prevents an authenticated caller from reading or clearing another wallet’s history', async () => {
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      allowedOrigins: ['http://localhost:3000'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    mockRunAgent.mockResolvedValue({ response: 'Agent reply' })

    const alice = Keypair.random()
    const bob = Keypair.random()

    const wsAlice = await createTestClient(serverUrl)
    await authenticateClient(wsAlice, alice)
    await sendAndWait(wsAlice, { type: 'chat', message: 'Alice turn 1' }, ['response'])
    expect(serverInstance.conversations.get(alice.publicKey())).toHaveLength(2)

    // Bob authenticates on his own socket, then attempts to pass Alice's walletAddress in chat & clear_history
    const wsBob = await createTestClient(serverUrl)
    await authenticateClient(wsBob, bob)

    await sendAndWait(
      wsBob,
      { type: 'chat', walletAddress: alice.publicKey(), message: 'Spoof Alice' },
      ['response'],
    )
    expect(mockRunAgent).toHaveBeenLastCalledWith(
      'Spoof Alice',
      bob.publicKey(),
      [],
      undefined,
      undefined,
      expect.anything(),
    )

    await sendAndWait(
      wsBob,
      { type: 'clear_history', walletAddress: alice.publicKey() },
      ['history_cleared'],
    )

    // Alice's conversation history remains intact; only Bob's was cleared
    expect(serverInstance.conversations.get(alice.publicKey())).toHaveLength(2)
    expect(serverInstance.conversations.get(bob.publicKey())).toBeUndefined()
  })
})
