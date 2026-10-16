// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

/**
 * #793 — swaps address USDT0 by code:issuer and by its derived SAC, never by
 * code. These tests pin the routing INPUT: what each venue is asked about,
 * and what is refused before it is asked.
 */

import { Asset, Networks } from '@stellar/stellar-sdk'
import {
  checkSwapAsset,
  classicAsset,
  noRouteMessage,
  pathPaysOut,
  quoteMismatch,
  swapAssetLabel,
  swapDestinations,
  swapRouteInput,
  NATIVE,
} from '../swapAssets'

const USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'
const IMPOSTORS = [
  'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
  'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
  'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT',
  'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3',
  'GA7GNGYVJHF7LTI6OO4FAD2JEQBIQWRBIZOLEZSJJHMNAY6UUZERU526',
  'GAVRQZHG726XIHZKP3MODI3DOUP7IIQ6CC6OJX4JJD7PXRV4FJ3WE77O',
  'GDBDGR2U3KVHUGJ5SVALIAPT7FBPSYWD25XTF4JPHTPBKFH2SHOOHZFF',
]
const USDT0 = { code: 'USDT0', issuer: USDT0_ISSUER }
const PUBLIC = Networks.PUBLIC

// Derived, not pasted — then checked against the value from mainnet Horizon.
const USDT0_SAC = new Asset('USDT0', USDT0_ISSUER).contractId(PUBLIC)
const XLM_SAC = Asset.native().contractId(PUBLIC)
it('derives the USDT0 SAC Horizon reports', () => {
  expect(USDT0_SAC).toBe('CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF')
})

describe('the picker offers USDT0 only as the registered asset', () => {
  it('lists USDT0 with its genuine issuer on mainnet', () => {
    expect(swapDestinations('mainnet')).toContainEqual(USDT0)
  })

  it('does not offer USDT0 on testnet, where it does not exist', () => {
    expect(swapDestinations('testnet').map((a) => a.code)).not.toContain('USDT0')
  })

  it.each(IMPOSTORS)('refuses a held USDT0 issued by %s, naming the issuer', (issuer) => {
    const check = checkSwapAsset({ code: 'USDT0', issuer }, 'mainnet')
    expect(check).toEqual({ ok: false, reason: expect.stringContaining(`Unregistered issuer ${issuer}`) })
  })

  it('refuses a case-variant code and an "XLM" that has an issuer', () => {
    expect(checkSwapAsset({ code: 'usdt0', issuer: USDT0_ISSUER }, 'mainnet').ok).toBe(false)
    expect(checkSwapAsset({ code: 'XLM', issuer: USDT0_ISSUER }, 'mainnet').ok).toBe(false)
  })

  it('still lets a held, unregistered code be paid out of — labelled unverified', () => {
    const foo = { code: 'FOO', issuer: IMPOSTORS[0]! }
    expect(checkSwapAsset(foo, 'mainnet')).toMatchObject({ ok: true, registered: null })
    expect(swapAssetLabel(foo, 'mainnet')).toBe('FOO · unverified (GC35…BANK)')
  })
})

describe('routing input', () => {
  it('asks Soroswap for XLM → USDT0 by the derived SACs', () => {
    const route = swapRouteInput(NATIVE, USDT0, 'mainnet', PUBLIC)
    expect(route).toEqual({ ok: true, from: NATIVE, to: USDT0, tokenIn: XLM_SAC, tokenOut: USDT0_SAC })
  })

  it('asks Soroswap for USDT0 → XLM by the derived SACs', () => {
    const route = swapRouteInput(USDT0, NATIVE, 'mainnet', PUBLIC)
    expect(route).toMatchObject({ ok: true, tokenIn: USDT0_SAC, tokenOut: XLM_SAC })
  })

  it('addresses the classic DEX by code:issuer', () => {
    const asset = classicAsset(USDT0)
    expect([asset.getCode(), asset.getIssuer()]).toEqual(['USDT0', USDT0_ISSUER])
    expect(classicAsset(NATIVE).isNative()).toBe(true)
  })

  it.each(IMPOSTORS)('never builds a route for an impostor USDT0 (%s), either direction', (issuer) => {
    const fake = { code: 'USDT0', issuer }
    expect(swapRouteInput(NATIVE, fake, 'mainnet', PUBLIC).ok).toBe(false)
    expect(swapRouteInput(fake, NATIVE, 'mainnet', PUBLIC).ok).toBe(false)
  })

  it('refuses USDT0 on testnet and a pair of the same asset', () => {
    expect(swapRouteInput(NATIVE, USDT0, 'testnet', Networks.TESTNET).ok).toBe(false)
    expect(swapRouteInput(USDT0, USDT0, 'mainnet', PUBLIC)).toEqual({
      ok: false,
      reason: 'Pay and receive are the same asset.',
    })
  })
})

describe('a quote is only accepted for the pair that was asked for', () => {
  const impostorSac = new Asset('USDT0', IMPOSTORS[1]!).contractId(PUBLIC)

  it('accepts a quote whose assets and every leg match', () => {
    const quote = {
      assetIn: XLM_SAC,
      assetOut: USDT0_SAC,
      routePlan: [{ swapInfo: { path: [XLM_SAC, 'CUSDC', USDT0_SAC] } }],
    }
    expect(quoteMismatch(quote, XLM_SAC, USDT0_SAC)).toBeNull()
  })

  it('discards a quote that pays out a different USDT0', () => {
    expect(quoteMismatch({ assetIn: XLM_SAC, assetOut: impostorSac }, XLM_SAC, USDT0_SAC)).toMatch(/different asset pair/)
  })

  it('discards a quote with a leg ending at a different asset', () => {
    const quote = { assetIn: XLM_SAC, assetOut: USDT0_SAC, routePlan: [{ swapInfo: { path: [XLM_SAC, impostorSac] } }] }
    expect(quoteMismatch(quote, XLM_SAC, USDT0_SAC)).toMatch(/leg/)
  })

  it('accepts a classic path only when it pays out exactly the asset asked for', () => {
    const genuine = { destination_asset_type: 'credit_alphanum12', destination_asset_code: 'USDT0', destination_asset_issuer: USDT0_ISSUER }
    const fake = { ...genuine, destination_asset_issuer: IMPOSTORS[0] }
    expect(pathPaysOut(genuine, USDT0)).toBe(true)
    expect(pathPaysOut(fake, USDT0)).toBe(false)
    expect(pathPaysOut({ destination_asset_type: 'native' }, NATIVE)).toBe(true)
  })
})

describe('the route display names the issuer', () => {
  it('labels USDT0 with Tether and its issuer', () => {
    expect(swapAssetLabel(USDT0, 'mainnet')).toBe('USDT0 · Tether (GATI…HN6Q)')
  })

  it('says a pair is unroutable, naming both sides, instead of substituting one', () => {
    expect(noRouteMessage(NATIVE, USDT0, 'mainnet')).toBe(
      'No route from XLM to USDT0 · Tether (GATI…HN6Q). Try a different amount or asset — Veil will not substitute another asset.',
    )
  })
})

describe('getSoroswapQuote', () => {
  const quote = jest.fn()
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SOROSWAP_API_KEY = 'test-key'
  })
  afterAll(() => {
    delete process.env.NEXT_PUBLIC_SOROSWAP_API_KEY
  })

  function load() {
    let mod!: typeof import('../soroswap')
    jest.isolateModules(() => {
      jest.doMock('@soroswap/sdk', () => ({
        SoroswapSDK: jest.fn().mockImplementation(() => ({ quote })),
        SupportedNetworks: { TESTNET: 'testnet', MAINNET: 'mainnet' },
        SupportedProtocols: { SOROSWAP: 'soroswap', PHOENIX: 'phoenix', AQUA: 'aqua', SDEX: 'sdex' },
        TradeType: { EXACT_IN: 'EXACT_IN' },
      }))
      mod = require('../soroswap')
    })
    return mod
  }
  const params = { tokenIn: XLM_SAC, tokenOut: USDT0_SAC, amountIn: '10000000', slippageBps: 50, feePayerAddress: 'G' }

  beforeEach(() => quote.mockReset())

  it('sends the router exactly the derived SACs', async () => {
    quote.mockResolvedValue({ assetIn: XLM_SAC, assetOut: USDT0_SAC, amountOut: 1_000_000n, routePlan: [] })
    const result = await load().getSoroswapQuote(params)
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ assetIn: XLM_SAC, assetOut: USDT0_SAC }))
    expect(result.ok).toBe(true)
  })

  it('reports a quote for a different asset as a mismatch — not a quote, and not a reason to try SDEX', async () => {
    const impostorSac = new Asset('USDT0', IMPOSTORS[0]!).contractId(PUBLIC)
    quote.mockResolvedValue({ assetIn: XLM_SAC, assetOut: impostorSac, amountOut: 1_000_000n, routePlan: [] })
    expect(await load().getSoroswapQuote(params)).toMatchObject({ ok: false, kind: 'mismatch' })
  })

  it('says so when there is no route', async () => {
    quote.mockResolvedValue({ assetIn: XLM_SAC, assetOut: USDT0_SAC, amountOut: 0n, routePlan: [] })
    expect(await load().getSoroswapQuote(params)).toMatchObject({ ok: false, kind: 'no-route' })
  })

  it('says so when the router fails', async () => {
    quote.mockRejectedValue(new Error('503'))
    expect(await load().getSoroswapQuote(params)).toMatchObject({ ok: false, kind: 'unavailable' })
  })
})
