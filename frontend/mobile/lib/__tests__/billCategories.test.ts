/**
 * Bill Category Declarations & Identifier Validation Tests.
 *
 * Verifies:
 * 1. Each category declares its identifier, label and validation in one place.
 * 2. Validation runs before the confirm step and names the specific problem (NEVER "invalid input").
 * 3. Provider lookup is used where one exists, returning the customer name.
 * 4. Adding a category means adding a declaration, not editing a flow.
 * 5. Tests cover a valid id, a malformed id, and a well-formed id the provider rejects.
 */

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

describe('Bill Category Declarations (One place per category)', () => {
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

describe('Airtime & Data Identifier Validation', () => {
  it('accepts a valid 11-digit Nigerian phone number', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '08031234567');
    expect(result.valid).toBe(true);
    expect(result.normalizedId).toBe('08031234567');
    expect(result.error).toBeUndefined();
  });

  it('normalizes numbers with international prefixes (+234 / 234)', async () => {
    const res1 = await validateIdentifierBeforeConfirm('airtime', '+234 803 123 4567');
    expect(res1.valid).toBe(true);
    expect(res1.normalizedId).toBe('08031234567');

    const res2 = await validateIdentifierBeforeConfirm('data', '2348031234567', { provider: 'MTN' });
    expect(res2.valid).toBe(true);
    expect(res2.normalizedId).toBe('08031234567');
  });

  it('rejects a malformed phone number and names the specific problem (too short)', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '080312345');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too short \(9\/11 digits\)/i);
    expect(result.error).not.toBe('invalid input');
  });

  it('rejects a malformed phone number and names the specific problem (too long)', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '0803123456789');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too long \(13\/11 digits\)/i);
    expect(result.error).not.toBe('invalid input');
  });

  it('rejects a malformed phone number with non-digits', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '0803ABC4567');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Phone number must contain only digits');
  });

  it('rejects an empty phone number with a specific message', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '   ');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Phone number is required');
  });

  it('rejects an unrecognized Nigerian network prefix', async () => {
    const result = await validateIdentifierBeforeConfirm('airtime', '01234567890');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Phone number prefix "0123" is not a recognized Nigerian mobile network');
  });
});

describe('Electricity Meter Validation & Provider Lookup', () => {
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
    expect(result.normalizedId).toBe('01234567890');
  });

  it('rejects a malformed meter number before calling provider lookup', async () => {
    const lookupFn = jest.fn();
    const result = await validateIdentifierBeforeConfirm(
      'electricity',
      '12345', // too short
      { provider: 'IKEDC', lookupFn },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too short \(5 digits\)/i);
    expect(result.error).not.toBe('invalid input');
    // Format failure stops before calling the provider
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it('rejects a malformed meter number with letters', async () => {
    const lookupFn = jest.fn();
    const result = await validateIdentifierBeforeConfirm(
      'electricity',
      '0123456789X',
      { provider: 'IKEDC', lookupFn },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Meter number must contain only digits');
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it('rejects when disco provider is missing', async () => {
    const result = await validateIdentifierBeforeConfirm(
      'electricity',
      '01234567890',
      { provider: '' },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Select an electricity distribution company (Disco)');
  });

  it('rejects a well-formed meter number that the provider rejects (crucial safety check)', async () => {
    // 11 digits is well-formed, but the provider lookup discovers it is nonexistent/wrong
    const result = await validateIdentifierBeforeConfirm(
      'electricity',
      '99999999999',
      { provider: 'IKEDC', lookupFn: mockSuccessLookup },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      'Meter number 99999999999 was not found for IKEDC. Check the number and disco.',
    );
    expect(result.accountHolderName).toBeUndefined();
  });
});

describe('Cable TV Smartcard Validation & Provider Lookup', () => {
  const mockCableLookup: BillLookupFunction = jest.fn(async ({ provider, customerId }) => {
    if (customerId === '1234567890' && provider === 'DSTV') {
      return {
        valid: true,
        accountHolderName: 'CHUKWUMA OBI',
        currentPackage: 'DSTV Compact Plus',
        dueDate: '2026-11-20',
      };
    }
    return {
      valid: false,
      error: `Smartcard number not found on ${provider}. Verify your smartcard number.`,
    };
  });

  it('validates a valid smartcard and retrieves account holder name and package', async () => {
    const result = await validateIdentifierBeforeConfirm(
      'cabletv',
      '1234567890',
      { provider: 'DSTV', lookupFn: mockCableLookup },
    );

    expect(result.valid).toBe(true);
    expect(result.accountHolderName).toBe('CHUKWUMA OBI');
    expect(result.lookupResult?.currentPackage).toBe('DSTV Compact Plus');
  });

  it('rejects a malformed smartcard (DSTV requires 10 digits)', async () => {
    const lookupFn = jest.fn();
    const result = await validateIdentifierBeforeConfirm(
      'cabletv',
      '123456789', // 9 digits
      { provider: 'DSTV', lookupFn },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('DSTV smartcard number must be exactly 10 digits (got 9)');
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it('rejects a malformed smartcard (StarTimes requires 11 digits)', async () => {
    const lookupFn = jest.fn();
    const result = await validateIdentifierBeforeConfirm(
      'cabletv',
      '1234567890', // 10 digits instead of 11
      { provider: 'STARTIMES', lookupFn },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('StarTimes smartcard/IUC number must be exactly 11 digits (got 10)');
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it('rejects a well-formed smartcard that the provider rejects', async () => {
    const result = await validateIdentifierBeforeConfirm(
      'cabletv',
      '9999999999', // 10 digits, valid format for DSTV
      { provider: 'DSTV', lookupFn: mockCableLookup },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Smartcard number not found on DSTV. Verify your smartcard number.');
  });
});

describe('Betting Account Validation & Provider Lookup', () => {
  const mockBettingLookup: BillLookupFunction = jest.fn(async ({ provider, customerId }) => {
    if (customerId === '7654321' && provider === 'BET9JA') {
      return {
        valid: true,
        accountHolderName: 'EMMANUEL OKEKE',
      };
    }
    return {
      valid: false,
      error: `Account ID "${customerId}" not found on ${provider}. Check your user ID.`,
    };
  });

  it('validates a valid betting account ID and returns bettor name', async () => {
    const result = await validateIdentifierBeforeConfirm(
      'betting',
      '7654321',
      { provider: 'BET9JA', lookupFn: mockBettingLookup },
    );

    expect(result.valid).toBe(true);
    expect(result.accountHolderName).toBe('EMMANUEL OKEKE');
  });

  it('rejects a malformed account ID (too short)', async () => {
    const lookupFn = jest.fn();
    const result = await validateIdentifierBeforeConfirm(
      'betting',
      '123',
      { provider: 'BET9JA', lookupFn },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Account ID is too short (minimum 5 characters, got 3)');
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it('rejects a well-formed account ID that provider rejects', async () => {
    const result = await validateIdentifierBeforeConfirm(
      'betting',
      '8888888', // 7 chars, well formed
      { provider: 'BET9JA', lookupFn: mockBettingLookup },
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Account ID "8888888" not found on BET9JA. Check your user ID.');
  });
});

describe('Extensibility Seam (Adding a category means adding a declaration, not editing a flow)', () => {
  afterEach(() => {
    unregisterBillCategory('toll');
  });

  it('supports adding a new category by registering a declaration without editing flow code', async () => {
    // Declare a new category, e.g. "toll" for Lekki Concession Company / e-Tag
    const tollDeclaration = createCategoryDeclaration({
      category: 'toll',
      label: 'Toll e-Tag',
      identifier: {
        key: 'eTagNumber',
        label: 'e-Tag Number',
        placeholder: 'LCC-12345678',
      },
      requiresProvider: true,
      providerLabel: 'Toll Operator',
      formatValidation: (id, context) => {
        const trimmed = id.trim();
        if (!trimmed) return { valid: false, error: 'e-Tag number is required' };
        if (!trimmed.startsWith('LCC-')) {
          return { valid: false, error: 'e-Tag number must begin with "LCC-"' };
        }
        if (trimmed.length !== 12) {
          return { valid: false, error: 'e-Tag number must be LCC- followed by 8 digits' };
        }
        return { valid: true, normalizedId: trimmed };
      },
      hasProviderLookup: true,
      lookup: async (id) => {
        if (id === 'LCC-12345678') {
          return { valid: true, accountHolderName: 'TUNDE BAKARE' };
        }
        return { valid: false, error: 'e-Tag not registered with toll operator' };
      },
    });

    // Register without modifying any flow or existing declarations
    registerBillCategory(tollDeclaration);

    // Flow invokes generic validation for the new category
    const validResult = await validateIdentifierBeforeConfirm('toll', 'LCC-12345678');
    expect(validResult.valid).toBe(true);
    expect(validResult.accountHolderName).toBe('TUNDE BAKARE');

    // Flow handles malformed ID for new category
    const malformedResult = await validateIdentifierBeforeConfirm('toll', 'WRONG-123');
    expect(malformedResult.valid).toBe(false);
    expect(malformedResult.error).toBe('e-Tag number must begin with "LCC-"');

    // Flow handles well-formed ID rejected by provider
    const rejectedResult = await validateIdentifierBeforeConfirm('toll', 'LCC-99999999');
    expect(rejectedResult.valid).toBe(false);
    expect(rejectedResult.error).toBe('e-Tag not registered with toll operator');
  });
});
