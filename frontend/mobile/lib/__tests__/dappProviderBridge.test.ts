/**
 * The rules the injected provider is held to, tested on the app side.
 *
 * Everything here runs without a WebView, a passkey or a network: the bridge
 * takes its wallet, its signer and its prompt as injected functions, so these
 * tests can pin the *decisions* — who gets answered, who gets a prompt, who gets
 * what error — which is the whole security surface of the feature.
 *
 * The acceptance criteria this suite is written against, in order:
 *
 * - A dApp can discover the wallet and read its address.
 * - Every signature is approved explicitly, with the request shown.
 * - An origin outside the allow-list gets no provider at all.
 * - Nothing but a result key ever leaves — no key, no secret, no credential id.
 */
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

import type { HandledProviderMessage, ProviderContext } from '../dappProviderBridge';
import { DAPP_PROVIDER_REQUEST_TYPE, SEP43_ERROR, type ProviderResponse } from '../dappProvider';

// `lib/dappBridge.ts` pulls in the WalletConnect client, which is RN-only and
// loads polyfills at import. The bridge never uses it — the signing functions are
// injected — so the mock keeps this a pure test of the decision logic.
jest.mock('../walletConnect', () => ({ signXdrPayload: jest.fn(async () => 'unused') }));

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
  },
}));

const SOROSWAP = 'https://app.soroswap.finance';
const NOT_LISTED = 'https://phishing.example';
const PASSPHRASE = Networks.TESTNET;

// The wallet this device would disclose and sign for.
const WALLET = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const OTHER_WALLET = StrKey.encodeContract(Buffer.alloc(32, 0x99));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x22));
const RECIPIENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33)).publicKey();
// A dApp builds its transaction with an account as the source; the wallet contract
// is the address carried inside the auth entries the simulation returns.
const DAPP_SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x44)).publicKey();

type BridgeModule = typeof import('../dappProviderBridge');
type PermissionsModule = typeof import('../permissions');

let bridge: BridgeModule;
let permissions: PermissionsModule;

/** Fresh copies of the permission store and the bridge bound to it. */
async function load(): Promise<void> {
  jest.resetModules();
  permissions = require('../permissions');
  await permissions.hydrateOriginPermissions();
  bridge = require('../dappProviderBridge');
}

beforeEach(async () => {
  mockStorage.clear();
  await load();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRANSFER_ARGS = [
  nativeToScVal(Address.fromString(WALLET)),
  nativeToScVal(Address.fromString(RECIPIENT)),
  nativeToScVal(100n, { type: 'i128' }),
];

function invokeOperation() {
  return Operation.invokeContractFunction({
    contract: TOKEN,
    function: 'transfer',
    args: TRANSFER_ARGS,
  });
}

/** A one-operation Soroban call — the shape Veil signs. */
function signingTransaction(): string {
  return new TransactionBuilder(new Account(DAPP_SOURCE, '9'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(invokeOperation())
    .setTimeout(30)
    .build()
    .toXDR();
}

function twoOperationTransaction(): string {
  return new TransactionBuilder(new Account(DAPP_SOURCE, '9'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(invokeOperation())
    .addOperation(invokeOperation())
    .setTimeout(30)
    .build()
    .toXDR();
}

function paymentTransaction(): string {
  return new TransactionBuilder(new Account(DAPP_SOURCE, '9'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.payment({ destination: RECIPIENT, amount: '10', asset: Asset.native() }))
    .setTimeout(30)
    .build()
    .toXDR();
}

function feeBumpTransaction(): string {
  const inner = TransactionBuilder.fromXDR(signingTransaction(), PASSPHRASE) as never;
  return TransactionBuilder.buildFeeBumpTransaction(DAPP_SOURCE, '120', inner, PASSPHRASE).toXDR();
}

/** An auth entry the wallet's own key can authorise. */
function authEntry(address = WALLET): string {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString('777'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(TOKEN).toScAddress(),
          functionName: 'transfer',
          args: TRANSFER_ARGS,
        }),
      ),
      subInvocations: [],
    }),
  }).toXDR('base64');
}

/** Base64 that survives the wire check but is not an authorization entry. */
const NOT_AN_ENTRY = Buffer.from('this is not an xdr envelope').toString('base64');

// ── The context ───────────────────────────────────────────────────────────────

type Fake = {
  prompt: jest.Mock;
  signTransactionXdr: jest.Mock;
  signAuthEntryXdr: jest.Mock;
  getAddress: jest.Mock;
  hasSigner: jest.Mock;
};

type Overrides = {
  approvedOrigin?: string;
  messageOrigin?: string | null;
  approve?: boolean;
  wallet?: string | null;
  signer?: boolean;
};

function makeContext(overrides: Overrides = {}): { context: ProviderContext; fake: Fake } {
  const approve = overrides.approve ?? true;
  const fake: Fake = {
    prompt: jest.fn(async () => approve),
    signTransactionXdr: jest.fn(async (xdrString: string) => `signed-tx:${xdrString.length}`),
    signAuthEntryXdr: jest.fn(async (xdrString: string) => `signed-entry:${xdrString.slice(0, 4)}`),
    getAddress: jest.fn(async () => (overrides.wallet === undefined ? WALLET : overrides.wallet)),
    hasSigner: jest.fn(() => overrides.signer !== false),
  };
  return {
    context: {
      approvedOrigin: overrides.approvedOrigin ?? SOROSWAP,
      messageOrigin: overrides.messageOrigin === undefined ? SOROSWAP : overrides.messageOrigin,
      dappName: 'Soroswap',
      prompt: fake.prompt as ProviderContext['prompt'],
      isGranted: (origin, scope) => permissions.isOriginPermissionGranted(origin, scope),
      getAddress: fake.getAddress,
      signTransactionXdr: fake.signTransactionXdr,
      signAuthEntryXdr: fake.signAuthEntryXdr,
      hasSigner: fake.hasSigner,
      network: () => ({ name: 'testnet', displayName: 'Testnet', networkPassphrase: PASSPHRASE }),
    },
    fake,
  };
}

/** A page's `postMessage` payload, in the envelope the injected script writes. */
function providerMessage(method: string, params: Record<string, unknown> = {}, id = 'r1-1'): string {
  return JSON.stringify({ type: DAPP_PROVIDER_REQUEST_TYPE, id, method, params });
}

async function ask(
  method: string,
  params: Record<string, unknown> = {},
  overrides: Overrides = {}
): Promise<{ handled: HandledProviderMessage; fake: Fake }> {
  const { context, fake } = makeContext(overrides);
  const handled = await bridge.handleProviderMessage(providerMessage(method, params), context);
  return { handled, fake };
}

/** The SEP-43 payload a handled message answered with. */
function replyOf(handled: HandledProviderMessage): ProviderResponse {
  if (handled.kind !== 'replied') {
    throw new Error(`Expected a reply, got ${handled.kind}`);
  }
  return handled.response;
}

function errorOf(response: ProviderResponse): { message: string; code: number } {
  expect(response.error).toBeDefined();
  return response.error as { message: string; code: number };
}

// ── 1. Who gets answered at all ───────────────────────────────────────────────

describe('origin gating', () => {
  it('an origin outside the allow-list gets no answer', async () => {
    const { handled, fake } = await ask('getAddress', {}, { approvedOrigin: NOT_LISTED });

    expect(handled).toEqual({ kind: 'ignored', reason: 'origin-not-allowed' });
    // No prompt, no disclosure, nothing signed: the request never gets as far as
    // the permission layer, let alone the wallet.
    expect(fake.prompt).not.toHaveBeenCalled();
    expect(fake.signTransactionXdr).not.toHaveBeenCalled();
  });

  it('a message from a frame that is not the approved page is dropped', async () => {
    const nested = await ask('getAddress', {}, { messageOrigin: 'https://iframe-inside.example/child' });
    expect(nested.handled).toEqual({ kind: 'ignored', reason: 'origin-not-verified' });

    // A path or query on the same origin is still the same origin.
    const samePage = await ask('getAddress', {}, { messageOrigin: `${SOROSWAP}/trade?pair=USDC:XLM` });
    expect(samePage.handled.kind).toBe('replied');
  });

  it('a message whose origin the WebView did not report is dropped', async () => {
    const { handled } = await ask('getAddress', {}, { messageOrigin: null });
    expect(handled).toEqual({ kind: 'ignored', reason: 'origin-not-verified' });
  });

  it('a payload that is not a provider request is ignored without a reply', async () => {
    const { context } = makeContext();
    const payloads = ['not json', JSON.stringify({ type: 'veil:window-open', url: 'x' }), '42'];
    for (const data of payloads) {
      // eslint-disable-next-line no-await-in-loop
      expect(await bridge.handleProviderMessage(data, context)).toEqual({
        kind: 'ignored',
        reason: 'not-a-provider-request',
      });
    }
  });
});

// ── 2. Discovery and reading the address ──────────────────────────────────────

describe('network and connection state', () => {
  it('getNetwork answers without a prompt or a grant', async () => {
    const { handled, fake } = await ask('getNetwork');

    expect(replyOf(handled)).toEqual({ network: 'testnet', networkPassphrase: PASSPHRASE });
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it('isApproved reports the live grant and never summons a sheet', async () => {
    expect(replyOf((await ask('isApproved')).handled)).toEqual({ approved: false });

    await permissions.grantOriginPermissions(SOROSWAP, ['address_disclosure']);
    expect(replyOf((await ask('isApproved')).handled)).toEqual({ approved: true });
  });

  it('isApproved flips back the moment the grant is revoked', async () => {
    await permissions.grantOriginPermissions(SOROSWAP, ['address_disclosure']);
    await permissions.revokeOriginPermissions(SOROSWAP, 'address_disclosure');

    expect(replyOf((await ask('isApproved')).handled)).toEqual({ approved: false });
  });
});

describe('address disclosure', () => {
  it('asks the user, then answers with the address and nothing else', async () => {
    const { handled, fake } = await ask('getAddress');

    expect(fake.prompt).toHaveBeenCalledTimes(1);
    expect(fake.prompt.mock.calls[0][0]).toMatchObject({
      origin: SOROSWAP,
      scope: 'address_disclosure',
      name: 'Soroswap',
    });
    const response = replyOf(handled);
    expect(response).toEqual({ address: WALLET });
    // The reply is a fixed shape, so an unexpected extra key would be a leak.
    expect(Object.keys(response).sort()).toEqual(['address']);
  });

  it('a declined disclosure returns -4 and never reveals the address', async () => {
    const response = replyOf((await ask('getAddress', {}, { approve: false })).handled);

    expect(errorOf(response).code).toBe(SEP43_ERROR.userRejected);
    expect(response.address).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain(WALLET);
  });

  it('a declined disclosure stores no grant', async () => {
    await ask('getAddress', {}, { approve: false });
    expect(permissions.isOriginPermissionGranted(SOROSWAP, 'address_disclosure')).toBe(false);
  });

  it('getAddresses answers the plural form with the same one address', async () => {
    expect(replyOf((await ask('getAddresses')).handled)).toEqual({ addresses: [WALLET] });
  });

  it('the connect gesture grants disclosure without taking the address back', async () => {
    const { fake } = await ask('request');

    expect(fake.prompt).toHaveBeenCalledTimes(1);
    expect(permissions.isOriginPermissionGranted(SOROSWAP, 'address_disclosure')).toBe(true);
    // Connecting never reaches as far as the signing scope.
    expect(permissions.isOriginPermissionGranted(SOROSWAP, 'transaction_signing')).toBe(false);
  });

  it('a granted origin reads its address again without a second prompt', async () => {
    await ask('getAddress');
    const second = await ask('getAddress');

    expect(second.fake.prompt).toHaveBeenCalledTimes(0);
    expect(replyOf(second.handled)).toEqual({ address: WALLET });
  });

  it('says what is wrong when there is no wallet, instead of a rejection the user never made', async () => {
    const { handled, fake } = await ask('getAddress', {}, { wallet: null });

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.internal);
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it('prompts again after a revoke while the page is open', async () => {
    await ask('getAddress');
    await permissions.revokeOriginPermissions(SOROSWAP, 'address_disclosure');
    const after = await ask('getAddress');

    expect(after.fake.prompt).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Signing: always the user, always shown ─────────────────────────────────

describe('signTransaction', () => {
  it('prompts even when the origin already holds the signing grant', async () => {
    await permissions.grantOriginPermissions(SOROSWAP, ['transaction_signing']);
    const { handled, fake } = await ask('signTransaction', { xdr: signingTransaction() });

    // A remembered grant means the site may ask, never that it may sign.
    expect(fake.prompt).toHaveBeenCalledTimes(1);
    expect(replyOf(handled)).toEqual({ signedTxXdr: expect.any(String), signerAddress: WALLET });
  });

  it('shows the user what they are approving', async () => {
    const { fake } = await ask('signTransaction', { xdr: signingTransaction() });
    const request = fake.prompt.mock.calls[0][0];

    expect(request.scope).toBe('transaction_signing');
    expect(request.details).toMatchObject({
      operationType: 'contract',
      contractAddress: TOKEN,
      functionName: 'transfer',
    });
  });

  it('signs nothing when the user declines, and says it was them', async () => {
    const { handled, fake } = await ask(
      'signTransaction',
      { xdr: signingTransaction() },
      { approve: false }
    );

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.userRejected);
    expect(fake.signTransactionXdr).not.toHaveBeenCalled();
  });

  it('refuses a multi-operation transaction before the user sees anything', async () => {
    const { handled, fake } = await ask('signTransaction', { xdr: twoOperationTransaction() });

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.invalidRequest);
    expect(fake.prompt).not.toHaveBeenCalled();
    expect(fake.signTransactionXdr).not.toHaveBeenCalled();
  });

  it('refuses an operation this signing path cannot describe accurately', async () => {
    const { handled, fake } = await ask('signTransaction', { xdr: paymentTransaction() });

    expect(errorOf(replyOf(handled)).message).toMatch(/host function/);
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it('refuses a transaction built for another network', async () => {
    const { handled, fake } = await ask('signTransaction', {
      xdr: signingTransaction(),
      opts: { networkPassphrase: Networks.PUBLIC },
    });

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.invalidRequest);
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it('refuses to submit, rather than submitting quietly', async () => {
    const { handled } = await ask('signTransaction', { xdr: signingTransaction(), opts: { submit: true } });

    expect(errorOf(replyOf(handled)).message).toMatch(/does not submit/);
  });

  it('refuses a request that names a different wallet', async () => {
    const { handled, fake } = await ask('signTransaction', {
      xdr: signingTransaction(),
      opts: { address: OTHER_WALLET },
    });

    expect(errorOf(replyOf(handled)).message).toMatch(/other than the one on this device/);
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it('refuses a fee-bump envelope', async () => {
    const { handled } = await ask('signTransaction', { xdr: feeBumpTransaction() });

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.invalidRequest);
  });

  it('refuses an XDR that cannot be read, and a call that carried none', async () => {
    const unreadable = await ask('signTransaction', { xdr: NOT_AN_ENTRY });
    expect(errorOf(replyOf(unreadable.handled)).code).toBe(SEP43_ERROR.invalidRequest);

    const missing = await ask('signTransaction', {});
    expect(errorOf(replyOf(missing.handled)).code).toBe(SEP43_ERROR.invalidRequest);
  });

  it('says so before the prompt when there is no signer on this device', async () => {
    const { handled, fake } = await ask(
      'signTransaction',
      { xdr: signingTransaction() },
      { signer: false }
    );

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.internal);
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it('reports a network failure as an external service error, not a wallet fault', async () => {
    const { context, fake } = makeContext();
    fake.signTransactionXdr.mockRejectedValueOnce(
      new Error('Could not reach the network to read the wallet nonce.')
    );

    const handled = await bridge.handleProviderMessage(
      providerMessage('signTransaction', { xdr: signingTransaction() }),
      context
    );

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.externalService);
  });
});

// ── 4. Standalone auth entries ────────────────────────────────────────────────

describe('signAuthEntry', () => {
  it('signs an entry for this wallet and returns the documented single shape', async () => {
    const entry = authEntry();
    const { handled, fake } = await ask('signAuthEntry', { authEntry: entry });

    const response = replyOf(handled);
    expect(response).toEqual({
      signedAuthEntry: `signed-entry:${entry.slice(0, 4)}`,
      signerAddress: WALLET,
    });
    // SEP-43 documents one entry; the array key must not ride along uninvited.
    expect(response.signedAuthEntries).toBeUndefined();
    expect(fake.prompt).toHaveBeenCalledTimes(1);
  });

  it('will not sign an entry addressed to another wallet', async () => {
    const { handled, fake } = await ask('signAuthEntry', { authEntry: authEntry(OTHER_WALLET) });

    expect(errorOf(replyOf(handled)).message).toMatch(/other than the one on this device/);
    expect(fake.prompt).not.toHaveBeenCalled();
    expect(fake.signAuthEntryXdr).not.toHaveBeenCalled();
  });

  it('answers a batch with the list shape, one approval, one signature per entry', async () => {
    const { handled, fake } = await ask('signAuthEntry', { authEntries: [authEntry(), authEntry()] });

    const response = replyOf(handled);
    expect(response.signedAuthEntries).toHaveLength(2);
    expect(fake.prompt).toHaveBeenCalledTimes(1);
    expect(fake.signAuthEntryXdr).toHaveBeenCalledTimes(2);
  });

  it('refuses a batch containing anything it cannot read, and signs none of it', async () => {
    const { handled, fake } = await ask('signAuthEntry', {
      authEntries: [authEntry(), NOT_AN_ENTRY],
    });

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.invalidRequest);
    expect(fake.signAuthEntryXdr).not.toHaveBeenCalled();
  });

  it('declining one batch signs none of it', async () => {
    const { handled, fake } = await ask(
      'signAuthEntry',
      { authEntries: [authEntry(), authEntry()] },
      { approve: false }
    );

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.userRejected);
    expect(fake.signAuthEntryXdr).not.toHaveBeenCalled();
  });

  it('shows the contract and function the entry authorises', async () => {
    const { fake } = await ask('signAuthEntry', { authEntry: authEntry() });

    expect(fake.prompt.mock.calls[0][0].details).toMatchObject({
      operationType: 'authEntry',
      contractAddress: TOKEN,
      functionName: 'transfer',
    });
  });
});

// ── 5. What may never reach the page ──────────────────────────────────────────

describe('the reply surface', () => {
  const ALLOWED_RESULT_KEYS = [
    'address',
    'addresses',
    'approved',
    'error',
    'network',
    'networkPassphrase',
    'signedAuthEntries',
    'signedAuthEntry',
    'signedTxXdr',
    'signerAddress',
  ];

  it('names every result key it may use, and no others', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['getNetwork', {}],
      ['isApproved', {}],
      ['getAddress', {}],
      ['signTransaction', { xdr: signingTransaction() }],
      ['signAuthEntry', { authEntry: authEntry() }],
    ];
    for (const [method, params] of cases) {
      const response = replyOf((await ask(method, params)).handled);
      for (const key of Object.keys(response)) {
        expect(ALLOWED_RESULT_KEYS).toContain(key);
      }
    }
  });

  it('carries no key material, secret or credential id anywhere in the script it injects', async () => {
    const { handled } = await ask('signTransaction', { xdr: signingTransaction() });
    if (handled.kind !== 'replied') throw new Error('expected a reply');

    expect(handled.javascript).not.toMatch(/secret|seed|credentialId|privateKey/i);
    // The page is handed one function call with one JSON string.
    expect(handled.javascript).toContain('__veilDappProviderReply(');
  });

  it('escapes what a page could otherwise have executed', async () => {
    const { context, fake } = makeContext();
    fake.signTransactionXdr.mockResolvedValueOnce('</script><script>alert(1)</script>');

    const handled = await bridge.handleProviderMessage(
      providerMessage('signTransaction', { xdr: signingTransaction() }),
      context
    );

    if (handled.kind !== 'replied') throw new Error('expected a reply');
    expect(handled.javascript).not.toContain('</script>');
    expect(handled.javascript).toContain('\\u003c');
  });

  it('answers an unsupported SEP-43 method with the standard error, without a prompt', async () => {
    const { handled, fake } = await ask('signMessage', { message: 'hello' });

    expect(errorOf(replyOf(handled)).code).toBe(SEP43_ERROR.invalidRequest);
    expect(fake.prompt).not.toHaveBeenCalled();
  });
});
