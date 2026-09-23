import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'net'

// ── Shared mock for agent ─────────────────────────────────────────────────────
const mockRunAgent: any = jest.fn()

jest.unstable_mockModule('../agent.js', () => ({
  runAgent: mockRunAgent,
}))

// Dynamic import AFTER mock registration
const { createAgentServer, getClientIp, timingSafeEqualStr, tokenFromRequest } = await import('../server.js')
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
    // Start server with a small 1 KiB max payload
    serverInstance = createAgentServer({
      port: 0,
      autoListen: true,
      maxPayload: 1024,
      allowedOrigins: ['http://localhost:3000'],
    })

    const addr = serverInstance.httpServer.address() as AddressInfo
    serverUrl = `ws://127.0.0.1:${addr.port}`

    const ws = await createTestClient(serverUrl)

    // Wait for closure on sending oversized message
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() })
      })
    })

    // Send payload of 2 KiB (> 1 KiB limit)
    const largeMessage = JSON.stringify({
      type: 'chat',
      walletAddress: 'GSOURCE',
      message: 'x'.repeat(2048),
    })

    ws.send(largeMessage)

    const { code } = await closePromise
    // WebSocket 1009 = Message Too Big
    expect(code).toBe(1009)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  // ── Global concurrent connection cap ────────────────────────────────────────
  it('enforces total concurrent connection cap', async () => {
    // Start server with maxTotalConnections = 2 and maxConnectionsPerIp = 10
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

    // Third connection should be rejected with 503
    await expect(createTestClient(serverUrl)).rejects.toThrow(/503/)
  })

  // ── Per-IP concurrent connection cap ────────────────────────────────────────
  it('enforces per-remote-address connection cap', async () => {
    // Start server with maxConnectionsPerIp = 2 and large total cap
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

    // Third connection from same IP (127.0.0.1) should be rejected with 429
    await expect(createTestClient(serverUrl)).rejects.toThrow(/429/)

    // Once one client disconnects, a new connection from that IP is accepted
    ws1.terminate()
    // Wait brief moment for close event to propagate on server
    await new Promise((r) => setTimeout(r, 50))

    const ws3 = await createTestClient(serverUrl)
    expect(ws3.readyState).toBe(WebSocket.OPEN)
  })

  // ── Rate limiting survives reconnection ──────────────────────────────────────
  it('enforces rate limits across client reconnections', async () => {
    // Start server with rateMaxMessages = 2, rateWindowMs = 60000
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

    // First connection: send 2 messages (reaching the rate limit)
    const ws1 = await createTestClient(serverUrl)

    const sendChat = (ws: WebSocket, msg: string): Promise<any> => {
      return new Promise((resolve) => {
        const handler = (data: any) => {
          const parsed = JSON.parse(data.toString())
          if (parsed.type === 'response' || parsed.type === 'error') {
            ws.off('message', handler)
            resolve(parsed)
          }
        }
        ws.on('message', handler)
        ws.send(JSON.stringify({
          type: 'chat',
          walletAddress: 'GSOURCE',
          message: msg,
        }))
      })
    }

    const res1 = await sendChat(ws1, 'Message 1')
    expect(res1.type).toBe('response')

    const res2 = await sendChat(ws1, 'Message 2')
    expect(res2.type).toBe('response')

    // Disconnect ws1
    ws1.close()
    await new Promise((r) => setTimeout(r, 50))

    // Reconnect as ws2 from same client IP
    const ws2 = await createTestClient(serverUrl)

    // Third message should hit rate limit despite being on a fresh socket
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

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'error') {
          resolve(parsed)
        }
      })
    })

    ws.send(JSON.stringify({
      type: 'chat',
      walletAddress: 'GSOURCE',
      message: 'Hello',
    }))

    const errorRes = await responsePromise
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
})
