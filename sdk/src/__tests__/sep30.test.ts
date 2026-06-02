/**
 * Tests for the SEP-30 recoverysigner client.
 *
 * The recovery server is mocked at the `fetch` boundary, so these tests exercise
 * the full request/response and auth behaviour without a live server.
 */

import {
  Sep30Client,
  Sep30Error,
  collectRecoverySignatures,
  type Sep30Identity,
} from '../recovery/sep30'

const BASE = 'https://recovery.example.com'
const ADDR = 'GCEXAMPLEACCOUNTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
const SIGNER = 'GSERVERSIGNERKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'

const IDENTITIES: Sep30Identity[] = [
  { role: 'owner', auth_methods: [{ type: 'stellar_address', value: ADDR }] },
]

/** Build a fetch mock that returns a JSON body with the given status. */
function jsonFetch(status: number, body: unknown) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response)
}

describe('Sep30Client', () => {
  it('registers an account and returns the server signer', async () => {
    const fetchImpl = jsonFetch(200, {
      address: ADDR,
      identities: [{ role: 'owner', authenticated: false }],
      signers: [{ key: SIGNER }],
    })
    const client = new Sep30Client({ baseUrl: BASE, fetchImpl })

    const account = await client.registerAccount(ADDR, IDENTITIES)

    expect(account.signers[0].key).toBe(SIGNER)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BASE}/accounts/${ADDR}`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ identities: IDENTITIES })
  })

  it('attaches a static bearer token', async () => {
    const fetchImpl = jsonFetch(200, { address: ADDR, identities: [], signers: [] })
    const client = new Sep30Client({ baseUrl: BASE, fetchImpl, authToken: 'jwt-123' })

    await client.getAccount(ADDR)

    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer jwt-123')
  })

  it('resolves a dynamic token via getAuthToken before each request', async () => {
    const fetchImpl = jsonFetch(200, { address: ADDR, identities: [], signers: [] })
    const getAuthToken = jest.fn().mockResolvedValue('fresh-jwt')
    const client = new Sep30Client({ baseUrl: BASE, fetchImpl, getAuthToken })

    await client.getAccount(ADDR)

    expect(getAuthToken).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer fresh-jwt')
  })

  it('requests a signature for a transaction (re-establish a signer)', async () => {
    const fetchImpl = jsonFetch(200, {
      signature: 'BASE64SIG==',
      network_passphrase: 'Test SDF Network ; September 2015',
    })
    const client = new Sep30Client({ baseUrl: BASE, fetchImpl })

    const sig = await client.signTransaction(ADDR, SIGNER, 'AAAAtx==')

    expect(sig.signature).toBe('BASE64SIG==')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BASE}/accounts/${ADDR}/sign/${SIGNER}`)
    expect(JSON.parse(init.body)).toEqual({ transaction: 'AAAAtx==' })
  })

  it('throws Sep30Error with the server message on a non-2xx response', async () => {
    const fetchImpl = jsonFetch(401, { error: 'authentication required' })
    const client = new Sep30Client({ baseUrl: BASE, fetchImpl })

    await expect(client.getAccount(ADDR)).rejects.toMatchObject({
      name: 'Sep30Error',
      status: 401,
      message: 'authentication required',
    })
    await expect(client.getAccount(ADDR)).rejects.toBeInstanceOf(Sep30Error)
  })

  it('normalises a trailing slash in the base URL', async () => {
    const fetchImpl = jsonFetch(200, { address: ADDR, identities: [], signers: [] })
    const client = new Sep30Client({ baseUrl: `${BASE}/`, fetchImpl })
    await client.getAccount(ADDR)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/accounts/${ADDR}`)
  })

  it('deletes an account registration', async () => {
    const fetchImpl = jsonFetch(200, { address: ADDR, identities: [], signers: [] })
    const client = new Sep30Client({ baseUrl: BASE, fetchImpl })
    await client.deleteAccount(ADDR)
    expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE')
  })
})

describe('collectRecoverySignatures', () => {
  it('gathers signatures from every server, tagged by signer key', async () => {
    const mk = (sig: string, signer: string) => ({
      client: new Sep30Client({
        baseUrl: BASE,
        fetchImpl: jsonFetch(200, { signature: sig, network_passphrase: 'Test SDF Network ; September 2015' }),
      }),
      signerKey: signer,
    })
    const servers = [mk('SIG_A', 'GSERVER_A'), mk('SIG_B', 'GSERVER_B')]

    const sigs = await collectRecoverySignatures(servers, ADDR, 'AAAAtx==')

    expect(sigs).toHaveLength(2)
    expect(sigs.map(s => s.signerKey).sort()).toEqual(['GSERVER_A', 'GSERVER_B'])
    expect(sigs.map(s => s.signature).sort()).toEqual(['SIG_A', 'SIG_B'])
  })

  it('rejects if any server fails when requireAll is true (default)', async () => {
    const ok = { client: new Sep30Client({ baseUrl: BASE, fetchImpl: jsonFetch(200, { signature: 'S', network_passphrase: 'NP' }) }), signerKey: 'GOK' }
    const bad = { client: new Sep30Client({ baseUrl: BASE, fetchImpl: jsonFetch(500, { error: 'boom' }) }), signerKey: 'GBAD' }
    await expect(collectRecoverySignatures([ok, bad], ADDR, 'tx')).rejects.toBeInstanceOf(Sep30Error)
  })

  it('returns partial signatures when requireAll is false (M-of-N)', async () => {
    const ok = { client: new Sep30Client({ baseUrl: BASE, fetchImpl: jsonFetch(200, { signature: 'S', network_passphrase: 'NP' }) }), signerKey: 'GOK' }
    const bad = { client: new Sep30Client({ baseUrl: BASE, fetchImpl: jsonFetch(500, { error: 'boom' }) }), signerKey: 'GBAD' }
    const sigs = await collectRecoverySignatures([ok, bad], ADDR, 'tx', { requireAll: false })
    expect(sigs).toHaveLength(1)
    expect(sigs[0].signerKey).toBe('GOK')
  })
})
