/**
 * Bill Category Declarations & Identifier Validation Tests (Web Wallet).
 *
 * Sibling of frontend/mobile/lib/__tests__/billCategories.test.ts.
 */

import { webcrypto } from 'crypto';
import { TextEncoder, TextDecoder } from 'util';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
Object.assign(globalThis, { TextEncoder, TextDecoder });

import {
  AIRTIME_DECLARATION,
  DATA_DECLARATION,
  ELECTRICITY_DECLARATION,
  CABLETV_DECLARATION,
  BETTING_DECLARATION,
  getCategoryDeclaration,
  getAllCategoryDeclarations,
  registerBillCategory,
  unregisterBillCategory,
  validateIdentifierBeforeConfirm,
  createCategoryDeclaration,
  type BillLookupFunction,
} from '../billCategories';

describe('Bill Category Declarations (One place per category - Web Wallet)', () => {
  it('registers all five standard bill categories in one place', () => {
    const all = getAllCategoryDeclarations();
    const categories = all.map((d) => d.category);

    expect(categories).toEqual(
      expect.arrayContaining(['airtime', 'data', 'electricity', 'cabletv', 'betting']),
    );
  });

  it('declares the identifier, label, and validation for each category', () => {
    const airtime = getCategoryDeclaration('airtime')!;
    expect(airtime.label).toBe('Airtime');
    expect(airtime.identifier.key).toBe('phone');
    expect(airtime.identifier.label).toBe('Phone number');
    expect(airtime.hasProviderLookup).toBe(false);

    const electricity = getCategoryDeclaration('electricity')!;
    expect(electricity.label).toBe('Electricity');
    expect(electricity.identifier.key).toBe('meterNumber');
    expect(electricity.identifier.label).toBe('Meter number');
    expect(electricity.hasProviderLookup).toBe(true);

    const cabletv = getCategoryDeclaration('cabletv')!;
    expect(cabletv.label).toBe('Cable TV');
    expect(cabletv.identifier.key).toBe('smartcardNumber');
    expect(cabletv.identifier.label).toBe('Smartcard / IUC number');
    expect(cabletv.hasProviderLookup).toBe(true);

    const betting = getCategoryDeclaration('betting')!;
    expect(betting.label).toBe('Betting');
    expect(betting.identifier.key).toBe('accountId');
    expect(betting.identifier.label).toBe('Account ID');
    expect(betting.hasProviderLookup).toBe(true);
  });
});

describe('Airtime & Data Identifier Validation (Web Wallet)', () => {
  it('accepts a valid 11-digit Nigerian phone number', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '08031234567');
    expect(result.valid).toBe(true);
    expect(result.normalizedId).toBe('08031234567');
  });

  it('rejects a malformed phone number (too short)', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '080312345');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too short \(9\/11 digits\)/i);
    expect(result.error).not.toBe('invalid input');
  });

  it('rejects a malformed phone number (too long)', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '0803123456789');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too long \(13\/11 digits\)/i);
    expect(result.error).not.toBe('invalid input');
  });

  it('rejects an empty phone number', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Phone number is required');
  });
});

describe('Electricity Meter Validation & Provider Lookup (Web Wallet)', () => {
  const mockSuccessLookup: BillLookupFunction = jest.fn(async ({ provider, customerId }) => {
    if (customerId === '01234567890') {
      return {
        valid: true,
        accountHolderName: 'BABAFEMI ADELEKE',
        customerName: 'BABAFEMI ADELEKE',
      };
    }
    return {
      valid: false,
      error: `Meter number ${customerId} was not found for ${provider}. Check the number and disco.`,
    };
  });

  it('validates a valid meter number and returns the provider customer name', async () => {
    const result = await validateIdentifierBeforeConfirm(
      'electricity',
      '01234567890',
      { provider: 'IKEDC', lookupFn: mockSuccessLookup },
    );

    expect(result.valid).toBe(true);
    expect(result.accountHolderName).toBe('BABAFEMI ADELEKE');
  });

  it('rejects a malformed meter number before provider lookup', async () => {
    const lookupFn = jest.fn();
    const result = await validateIdentifierBeforeConfirm(
      'electricity',
      '12345',
      { provider: 'IKEDC', lookupFn },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too short \(5 digits\)/i);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it('rejects a well-formed meter number that the provider rejects', async () => {
    const result = await validateIdentifierBeforeConfirm(
      'electricity',
      '99999999999',
      { provider: 'IKEDC', lookupFn: mockSuccessLookup },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      'Meter number 99999999999 was not found for IKEDC. Check the number and disco.',
    );
  });
});

describe('Extensibility Seam (Web Wallet)', () => {
  afterEach(() => {
    unregisterBillCategory('toll');
  });

  it('supports adding a category via declaration without editing flow', async () => {
    const tollDeclaration = createCategoryDeclaration({
      category: 'toll',
      label: 'Toll e-Tag',
      identifier: {
        key: 'eTagNumber',
        label: 'e-Tag Number',
        placeholder: 'LCC-12345678',
      },
      formatValidation: (id) => {
        if (!id.startsWith('LCC-')) return { valid: false, error: 'e-Tag must start with LCC-' };
        return { valid: true, normalizedId: id };
      },
      hasProviderLookup: true,
      lookup: async (id) => {
        if (id === 'LCC-12345678') return { valid: true, accountHolderName: 'TUNDE BAKARE' };
        return { valid: false, error: 'e-Tag not registered' };
      },
    });

    registerBillCategory(tollDeclaration);

    const valid = await validateIdentifierBeforeConfirm('toll', 'LCC-12345678');
    expect(valid.valid).toBe(true);
    expect(valid.accountHolderName).toBe('TUNDE BAKARE');

    const invalid = await validateIdentifierBeforeConfirm('toll', 'OTHER-123');
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toBe('e-Tag must start with LCC-');
  });
});
