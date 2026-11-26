/**
 * #793 — mobile swaps address USDT0 by code:issuer and by its derived SAC,
 * never by code. Pins the routing INPUT each venue receives, and what is
 * refused before either is asked. Mirrors the wallet's swapAssets tests.
 */

import { Asset, Networks } from '@stellar/stellar-sdk';

import {
  checkSwapAsset,
  noRouteMessage,
  quoteMismatch,
  swapAssetLabel,
  swapDestinations,
  swapRouteInput,
  NATIVE,
} from '../swapAssets';

const USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q';
const IMPOSTORS = [
  'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
  'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
  'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT',
  'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3',
  'GA7GNGYVJHF7LTI6OO4FAD2JEQBIQWRBIZOLEZSJJHMNAY6UUZERU526',
  'GAVRQZHG726XIHZKP3MODI3DOUP7IIQ6CC6OJX4JJD7PXRV4FJ3WE77O',
  'GDBDGR2U3KVHUGJ5SVALIAPT7FBPSYWD25XTF4JPHTPBKFH2SHOOHZFF',
];
const USDT0 = { code: 'USDT0', issuer: USDT0_ISSUER };
const PUBLIC = Networks.PUBLIC;
const USDT0_SAC = new Asset('USDT0', USDT0_ISSUER).contractId(PUBLIC);
const XLM_SAC = Asset.native().contractId(PUBLIC);

it('derives the USDT0 SAC Horizon reports', () => {
  expect(USDT0_SAC).toBe('CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF');
});

describe('picker and routing input', () => {
  it('offers USDT0 on mainnet only, with its genuine issuer', () => {
    expect(swapDestinations('mainnet')).toContainEqual(USDT0);
    expect(swapDestinations('testnet').map((a) => a.code)).not.toContain('USDT0');
  });

  it('asks Soroswap for XLM ↔ USDT0 by the derived SACs', () => {
    expect(swapRouteInput(NATIVE, USDT0, 'mainnet', PUBLIC)).toMatchObject({ ok: true, tokenIn: XLM_SAC, tokenOut: USDT0_SAC });
    expect(swapRouteInput(USDT0, NATIVE, 'mainnet', PUBLIC)).toMatchObject({ ok: true, tokenIn: USDT0_SAC, tokenOut: XLM_SAC });
  });

  it.each(IMPOSTORS)('refuses a USDT0 issued by %s, naming the issuer', (issuer) => {
    expect(checkSwapAsset({ code: 'USDT0', issuer }, 'mainnet')).toEqual({
      ok: false,
      reason: expect.stringContaining(`Unregistered issuer ${issuer}`),
    });
    expect(swapRouteInput(NATIVE, { code: 'USDT0', issuer }, 'mainnet', PUBLIC).ok).toBe(false);
  });

  it('says USDT0 is unavailable on testnet rather than calling it an impostor', () => {
    expect(checkSwapAsset(USDT0, 'testnet')).toEqual({ ok: false, reason: 'USDT0 is not available on testnet.' });
  });

  it('names the issuer in the display, and in a no-route message', () => {
    expect(swapAssetLabel(USDT0, 'mainnet')).toBe('USDT0 · Tether (GATI…HN6Q)');
    expect(noRouteMessage(NATIVE, USDT0, 'mainnet')).toContain('USDT0 · Tether (GATI…HN6Q)');
  });

  it('discards a router quote for a different USDT0', () => {
    const impostorSac = new Asset('USDT0', IMPOSTORS[0]!).contractId(PUBLIC);
    expect(quoteMismatch({ assetIn: XLM_SAC, assetOut: impostorSac }, XLM_SAC, USDT0_SAC)).not.toBeNull();
  });
});

describe('getSoroswapQuote', () => {
  const quote = jest.fn();
  const params = { tokenIn: XLM_SAC, tokenOut: USDT0_SAC, amountIn: '10000000', slippageBps: 50, feePayerAddress: 'G' };

  function load(): typeof import('../soroswap') {
    let mod!: typeof import('../soroswap');
    jest.isolateModules(() => {
      process.env['EXPO_PUBLIC_SOROSWAP_API_KEY'] = 'test-key';
      jest.doMock('@soroswap/sdk', () => ({
        SoroswapSDK: jest.fn().mockImplementation(() => ({ quote })),
        SupportedNetworks: { TESTNET: 'testnet', MAINNET: 'mainnet' },
        SupportedProtocols: { SOROSWAP: 'soroswap', PHOENIX: 'phoenix', AQUA: 'aqua', SDEX: 'sdex' },
        TradeType: { EXACT_IN: 'EXACT_IN' },
      }));
      mod = require('../soroswap');
    });
    return mod;
  }

  beforeEach(() => quote.mockReset());
  afterAll(() => {
    delete process.env['EXPO_PUBLIC_SOROSWAP_API_KEY'];
  });

  it('sends the router exactly the derived SACs', async () => {
    quote.mockResolvedValue({ assetIn: XLM_SAC, assetOut: USDT0_SAC, amountOut: 1_000_000n, routePlan: [] });
    expect((await load().getSoroswapQuote(params)).ok).toBe(true);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ assetIn: XLM_SAC, assetOut: USDT0_SAC }));
  });

  it('reports an answer about a different asset as a mismatch, not a quote', async () => {
    const impostorSac = new Asset('USDT0', IMPOSTORS[1]!).contractId(PUBLIC);
    quote.mockResolvedValue({ assetIn: XLM_SAC, assetOut: impostorSac, amountOut: 1_000_000n, routePlan: [] });
    expect(await load().getSoroswapQuote(params)).toMatchObject({ ok: false, kind: 'mismatch' });
  });

  it('says so when there is no route, or the router fails', async () => {
    quote.mockResolvedValueOnce({ assetIn: XLM_SAC, assetOut: USDT0_SAC, amountOut: 0n, routePlan: [] });
    expect(await load().getSoroswapQuote(params)).toMatchObject({ ok: false, kind: 'no-route' });
    quote.mockRejectedValueOnce(new Error('503'));
    expect(await load().getSoroswapQuote(params)).toMatchObject({ ok: false, kind: 'unavailable' });
  });
});

describe('getSdexQuote', () => {
  const call = jest.fn();
  const strictSendPaths = jest.fn(() => ({ call }));

  function load(): typeof import('../sdexSwap') {
    let mod!: typeof import('../sdexSwap');
    jest.isolateModules(() => {
      jest.doMock('@stellar/stellar-sdk', () => {
        const actual = jest.requireActual('@stellar/stellar-sdk');
        return { ...actual, Horizon: { ...actual.Horizon, Server: jest.fn(() => ({ strictSendPaths })) } };
      });
      mod = require('../sdexSwap');
    });
    return mod;
  }

  beforeEach(() => {
    call.mockReset();
    strictSendPaths.mockClear();
  });

  it('asks Horizon for the classic assets by code:issuer', async () => {
    call.mockResolvedValue({ records: [] });
    await load().getSdexQuote(NATIVE, '10', USDT0);
    const [src, , dests] = strictSendPaths.mock.calls[0] as unknown as [Asset, string, Asset[]];
    expect(src.isNative()).toBe(true);
    expect([dests[0]!.getCode(), dests[0]!.getIssuer()]).toEqual(['USDT0', USDT0_ISSUER]);
  });

  it('never takes a path that pays out a different USDT0', async () => {
    call.mockResolvedValue({
      records: [
        {
          destination_asset_type: 'credit_alphanum12',
          destination_asset_code: 'USDT0',
          destination_asset_issuer: IMPOSTORS[0],
          destination_amount: '999',
          path: [],
        },
      ],
    });
    expect(await load().getSdexQuote(NATIVE, '10', USDT0)).toBeNull();
  });

  it('takes the path that pays out the genuine one', async () => {
    call.mockResolvedValue({
      records: [
        {
          destination_asset_type: 'credit_alphanum12',
          destination_asset_code: 'USDT0',
          destination_asset_issuer: USDT0_ISSUER,
          destination_amount: '1.5',
          path: [],
        },
      ],
    });
    expect(await load().getSdexQuote(NATIVE, '10', USDT0)).toEqual({ amountOut: '1.5', path: [] });
  });
});
