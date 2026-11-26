/**
 * Bill Category Declarations & Identifier Validation.
 *
 * Each category declares its identifier in one place:
 * - Its label and key (phone number, meter number, smartcard/IUC, account ID).
 * - Its format validation with explicit, actionable errors (NEVER "invalid input").
 * - Its provider lookup where one exists (electricity, cable TV, betting).
 *
 * ## The Seam
 *
 * Adding a category means registering a declaration, not editing flow code.
 *
 * ## Provider Lookups Win
 *
 * Where the provider offers a lookup returning the account holder's name,
 * it is preferred over format checks. A correctly-formatted wrong number is
 * the dangerous case (sending real crypto to a stranger), and only the provider
 * can catch it.
 */

import { lookupBillCustomer, type BillCustomerLookup, type BillCategory } from './onramp';

export { type BillCategory };

export interface IdentifierDeclaration {
  key: string;
  label: string;
  placeholder: string;
  keyboardType?: 'phone-pad' | 'number-pad' | 'default';
  hint?: string;
}

export interface FormatValidationResult {
  valid: boolean;
  error?: string;
  normalizedId?: string;
}

export interface BillLookupResult {
  valid: boolean;
  accountHolderName?: string;
  customerName?: string;
  currentPackage?: string;
  dueDate?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export type BillLookupFunction = (params: {
  billCategory: BillCategory | string;
  provider: string;
  customerId: string;
  customerRef?: string;
}) => Promise<BillCustomerLookup | BillLookupResult>;

export interface ValidationContext {
  provider?: string;
  customerRef?: string;
  lookupFn?: BillLookupFunction;
}

export interface BillValidationResult {
  valid: boolean;
  error?: string;
  accountHolderName?: string;
  normalizedId?: string;
  lookupResult?: BillLookupResult;
}

export interface BillCategoryDefinition {
  category: BillCategory | string;
  label: string;
  identifier: IdentifierDeclaration;
  requiresProvider?: boolean;
  providerLabel?: string;
  providers?: string[];
  formatValidation: (id: string, context?: ValidationContext) => FormatValidationResult;
  hasProviderLookup: boolean;
  lookup?: (id: string, context?: ValidationContext) => Promise<BillLookupResult>;
}

export interface BillCategoryDeclaration extends BillCategoryDefinition {
  validate: (id: string, context?: ValidationContext) => Promise<BillValidationResult>;
}

// ─── Nigerian Provider Constants ─────────────────────────────────────────────

export const NIGERIAN_MOBILE_PREFIXES: Record<string, string[]> = {
  MTN: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'],
  AIRTEL: ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'],
  GLO: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
  '9MOBILE': ['0809', '0818', '0817', '0909', '0908'],
};

export const ALL_MOBILE_PREFIXES = new Set(
  Object.values(NIGERIAN_MOBILE_PREFIXES).flat(),
);

export const ELECTRICITY_DISCOS = [
  'IKEDC',
  'EKEDC',
  'AEDC',
  'IBEDC',
  'EEDC',
  'KEDCO',
  'PHED',
  'JED',
  'KAEDCO',
  'YEDC',
  'BEDC',
];

export const CABLE_TV_PROVIDERS = ['DSTV', 'GOTV', 'STARTIMES', 'SHOWMAX'];

export const BETTING_PLATFORMS = ['SPORTYBET', 'BET9JA', '1XBET', 'BETWAY', 'BANGBET'];

// ─── Format Validation Helpers ───────────────────────────────────────────────

/**
 * Normalise raw input to standard 11-digit local Nigerian mobile format (080...).
 */
export function normalizeNigerianPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) return digits;
  if (digits.length === 13 && digits.startsWith('234')) return `0${digits.slice(3)}`;
  if (digits.length === 10 && !digits.startsWith('0')) return `0${digits}`;
  return digits;
}

export function validateNigerianMobilePhone(
  raw: string,
  _context?: ValidationContext,
): FormatValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'Phone number is required' };
  }

  // Check for invalid non-digit characters (allowing leading '+', spaces, dashes, parens)
  const strippedAllowed = trimmed.replace(/^(\+234|234)/, '').replace(/[\s\-()]/g, '');
  if (/\D/.test(strippedAllowed)) {
    return { valid: false, error: 'Phone number must contain only digits' };
  }

  const normalized = normalizeNigerianPhone(trimmed);

  if (normalized.length < 11) {
    return {
      valid: false,
      error: `Phone number is too short (${normalized.length}/11 digits). Nigerian mobile numbers must have 11 digits.`,
      normalizedId: normalized,
    };
  }

  if (normalized.length > 11) {
    return {
      valid: false,
      error: `Phone number is too long (${normalized.length}/11 digits). Nigerian mobile numbers must have 11 digits.`,
      normalizedId: normalized,
    };
  }

  if (!normalized.startsWith('0')) {
    return {
      valid: false,
      error: 'Phone number must start with 0 (e.g. 08031234567)',
      normalizedId: normalized,
    };
  }

  const prefix = normalized.slice(0, 4);
  if (!ALL_MOBILE_PREFIXES.has(prefix)) {
    return {
      valid: false,
      error: `Phone number prefix "${prefix}" is not a recognized Nigerian mobile network`,
      normalizedId: normalized,
    };
  }

  return {
    valid: true,
    normalizedId: normalized,
  };
}

export function validateElectricityMeter(
  raw: string,
  context?: ValidationContext,
): FormatValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'Meter number is required' };
  }

  const digits = trimmed.replace(/[\s-]/g, '');
  if (/\D/.test(digits)) {
    return { valid: false, error: 'Meter number must contain only digits' };
  }

  if (context && context.provider !== undefined && !context.provider.trim()) {
    return { valid: false, error: 'Select an electricity distribution company (Disco)' };
  }

  if (digits.length < 10) {
    return {
      valid: false,
      error: `Meter number is too short (${digits.length} digits). Meter numbers must be 10 to 13 digits.`,
      normalizedId: digits,
    };
  }

  if (digits.length > 13) {
    return {
      valid: false,
      error: `Meter number is too long (${digits.length} digits). Meter numbers must be 10 to 13 digits.`,
      normalizedId: digits,
    };
  }

  return {
    valid: true,
    normalizedId: digits,
  };
}

export function validateCableTvSmartcard(
  raw: string,
  context?: ValidationContext,
): FormatValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'Smartcard / IUC number is required' };
  }

  const digits = trimmed.replace(/[\s-]/g, '');
  if (/\D/.test(digits)) {
    return { valid: false, error: 'Smartcard / IUC number must contain only digits' };
  }

  const provider = context?.provider?.toUpperCase().trim();
  if (context && context.provider !== undefined && !provider) {
    return { valid: false, error: 'Select a cable TV provider' };
  }

  if (provider === 'DSTV' || provider === 'GOTV') {
    if (digits.length !== 10) {
      return {
        valid: false,
        error: `${provider} smartcard number must be exactly 10 digits (got ${digits.length})`,
        normalizedId: digits,
      };
    }
  } else if (provider === 'STARTIMES') {
    if (digits.length !== 11) {
      return {
        valid: false,
        error: `StarTimes smartcard/IUC number must be exactly 11 digits (got ${digits.length})`,
        normalizedId: digits,
      };
    }
  } else {
    if (digits.length < 10) {
      return {
        valid: false,
        error: `Smartcard / IUC number is too short (${digits.length} digits). It must be 10 or 11 digits.`,
        normalizedId: digits,
      };
    }
    if (digits.length > 11) {
      return {
        valid: false,
        error: `Smartcard / IUC number is too long (${digits.length} digits). It must be 10 or 11 digits.`,
        normalizedId: digits,
      };
    }
  }

  return {
    valid: true,
    normalizedId: digits,
  };
}

export function validateBettingAccountId(
  raw: string,
  context?: ValidationContext,
): FormatValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'Account ID is required' };
  }

  if (context && context.provider !== undefined && !context.provider.trim()) {
    return { valid: false, error: 'Select a betting platform' };
  }

  if (trimmed.length < 5) {
    return {
      valid: false,
      error: `Account ID is too short (minimum 5 characters, got ${trimmed.length})`,
      normalizedId: trimmed,
    };
  }

  if (trimmed.length > 16) {
    return {
      valid: false,
      error: `Account ID is too long (maximum 16 characters, got ${trimmed.length})`,
      normalizedId: trimmed,
    };
  }

  return {
    valid: true,
    normalizedId: trimmed,
  };
}

// ─── Declaration Factory ─────────────────────────────────────────────────────

export function createCategoryDeclaration(
  def: BillCategoryDefinition,
): BillCategoryDeclaration {
  return {
    ...def,
    async validate(id: string, context?: ValidationContext): Promise<BillValidationResult> {
      // 1. Format check first
      const formatResult = def.formatValidation(id, context);
      if (!formatResult.valid) {
        return {
          valid: false,
          error: formatResult.error,
          normalizedId: formatResult.normalizedId,
        };
      }

      const normalizedId = formatResult.normalizedId ?? id.trim();

      // 2. If provider offers lookup, run it before confirm
      if (def.hasProviderLookup && def.lookup) {
        try {
          const lookupResult = await def.lookup(normalizedId, context);
          if (!lookupResult.valid) {
            return {
              valid: false,
              error:
                lookupResult.error ||
                `The provider could not verify this ${def.identifier.label.toLowerCase()}`,
              normalizedId,
              lookupResult,
            };
          }

          const name = lookupResult.accountHolderName ?? lookupResult.customerName;
          return {
            valid: true,
            accountHolderName: name,
            normalizedId,
            lookupResult,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            valid: false,
            error: `Provider verification failed: ${message}`,
            normalizedId,
          };
        }
      }

      return {
        valid: true,
        normalizedId,
      };
    },
  };
}

// ─── Default Category Declarations ───────────────────────────────────────────

export const AIRTIME_DECLARATION = createCategoryDeclaration({
  category: 'airtime',
  label: 'Airtime',
  identifier: {
    key: 'phone',
    label: 'Phone number',
    placeholder: '0803 512 4471',
    keyboardType: 'phone-pad',
    hint: 'Nigerian mobile number (11 digits)',
  },
  requiresProvider: true,
  providerLabel: 'Network',
  providers: ['MTN', 'AIRTEL', 'GLO', '9MOBILE'],
  formatValidation: validateNigerianMobilePhone,
  hasProviderLookup: false,
});

export const DATA_DECLARATION = createCategoryDeclaration({
  category: 'data',
  label: 'Data',
  identifier: {
    key: 'phone',
    label: 'Phone number',
    placeholder: '0803 512 4471',
    keyboardType: 'phone-pad',
    hint: 'Nigerian mobile number (11 digits)',
  },
  requiresProvider: true,
  providerLabel: 'Network',
  providers: ['MTN', 'AIRTEL', 'GLO', '9MOBILE'],
  formatValidation: validateNigerianMobilePhone,
  hasProviderLookup: false,
});

export const ELECTRICITY_DECLARATION = createCategoryDeclaration({
  category: 'electricity',
  label: 'Electricity',
  identifier: {
    key: 'meterNumber',
    label: 'Meter number',
    placeholder: '01234567890',
    keyboardType: 'number-pad',
    hint: '10 to 13-digit prepaid or postpaid meter number',
  },
  requiresProvider: true,
  providerLabel: 'Distribution company (Disco)',
  providers: ELECTRICITY_DISCOS,
  formatValidation: validateElectricityMeter,
  hasProviderLookup: true,
  lookup: async (id, context) => {
    const disco = context?.provider?.toUpperCase().trim() ?? '';
    const fn = context?.lookupFn ?? lookupBillCustomer;
    const res = await fn({
      billCategory: 'electricity',
      provider: disco,
      customerId: id,
      customerRef: context?.customerRef,
    });
    return {
      valid: res.valid,
      accountHolderName: res.accountHolderName ?? res.customerName,
      customerName: res.customerName,
      error: res.error,
    };
  },
});

export const CABLETV_DECLARATION = createCategoryDeclaration({
  category: 'cabletv',
  label: 'Cable TV',
  identifier: {
    key: 'smartcardNumber',
    label: 'Smartcard / IUC number',
    placeholder: '1234567890',
    keyboardType: 'number-pad',
    hint: '10-digit DSTV/GOTV or 11-digit StarTimes number',
  },
  requiresProvider: true,
  providerLabel: 'Cable TV provider',
  providers: CABLE_TV_PROVIDERS,
  formatValidation: validateCableTvSmartcard,
  hasProviderLookup: true,
  lookup: async (id, context) => {
    const provider = context?.provider?.toUpperCase().trim() ?? '';
    const fn = context?.lookupFn ?? lookupBillCustomer;
    const res = await fn({
      billCategory: 'cabletv',
      provider,
      customerId: id,
      customerRef: context?.customerRef,
    });
    return {
      valid: res.valid,
      accountHolderName: res.accountHolderName ?? res.customerName,
      customerName: res.customerName,
      currentPackage: res.currentPackage,
      dueDate: res.dueDate,
      error: res.error,
    };
  },
});

export const BETTING_DECLARATION = createCategoryDeclaration({
  category: 'betting',
  label: 'Betting',
  identifier: {
    key: 'accountId',
    label: 'Account ID',
    placeholder: '12345678',
    keyboardType: 'default',
    hint: 'User ID with the betting platform',
  },
  requiresProvider: true,
  providerLabel: 'Betting platform',
  providers: BETTING_PLATFORMS,
  formatValidation: validateBettingAccountId,
  hasProviderLookup: true,
  lookup: async (id, context) => {
    const provider = context?.provider?.toUpperCase().trim() ?? '';
    const fn = context?.lookupFn ?? lookupBillCustomer;
    const res = await fn({
      billCategory: 'betting',
      provider,
      customerId: id,
      customerRef: context?.customerRef,
    });
    return {
      valid: res.valid,
      accountHolderName: res.accountHolderName ?? res.customerName,
      customerName: res.customerName,
      error: res.error,
    };
  },
});

// ─── Category Registry ────────────────────────────────────────────────────────

const REGISTRY = new Map<string, BillCategoryDeclaration>([
  ['airtime', AIRTIME_DECLARATION],
  ['data', DATA_DECLARATION],
  ['electricity', ELECTRICITY_DECLARATION],
  ['cabletv', CABLETV_DECLARATION],
  ['betting', BETTING_DECLARATION],
]);

/**
 * Register a category declaration.
 *
 * Adding a category means registering a declaration, not editing a flow.
 */
export function registerBillCategory(declaration: BillCategoryDeclaration): void {
  REGISTRY.set(declaration.category, declaration);
}

export function unregisterBillCategory(category: string): void {
  REGISTRY.delete(category);
}

export function getCategoryDeclaration(
  category: BillCategory | string,
): BillCategoryDeclaration | undefined {
  return REGISTRY.get(category);
}

export function getAllCategoryDeclarations(): BillCategoryDeclaration[] {
  return Array.from(REGISTRY.values());
}

/**
 * Validates a category's identifier before the confirm step.
 * Names the specific problem when invalid, and retrieves the account holder's
 * name when provider lookup is available.
 */
export async function validateIdentifierBeforeConfirm(
  category: BillCategory | string,
  id: string,
  context?: ValidationContext,
): Promise<BillValidationResult> {
  const declaration = getCategoryDeclaration(category);
  if (!declaration) {
    return {
      valid: false,
      error: `Unsupported bill category: ${category}`,
    };
  }

  return declaration.validate(id, context);
}
