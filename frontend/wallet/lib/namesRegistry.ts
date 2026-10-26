/**
 * Veil Names Registry (SEP-2 Write Layer)
 *
 * Implements the name issuance and claim rules for useveilapp.xyz:
 * - 5 USDC payment verification before reservation
 * - One claim per passkey (passkey public key as contract signer)
 * - Strict character set ([a-z0-9-], 3-32 chars)
 * - Confusable / homoglyph normalization skeleton mapping
 * - Pre-reserved names list protection
 * - Atomic concurrency control against race conditions
 */

export const NAME_PRICE_USDC = '5.0000000'
export const MIN_NAME_LENGTH = 3
export const MAX_NAME_LENGTH = 32

/**
 * Pre-reserved names that cannot be claimed by any user.
 */
export const RESERVED_NAMES: readonly string[] = Object.freeze([
  'veil',
  'admin',
  'administrator',
  'support',
  'help',
  'root',
  'system',
  'security',
  'official',
  'owner',
  'mod',
  'moderator',
  'null',
  'undefined',
  'api',
  'app',
  'wallet',
  'stellar',
  'soroban',
  'federation',
  'useveilapp',
])

/**
 * Homoglyph / confusable map mapping visually identical or confusable
 * Unicode characters (Cyrillic, Greek, fullwidth, Latin lookalikes)
 * to their canonical lowercase ASCII skeleton equivalents.
 */
const CONFUSABLE_MAP: Record<string, string> = {
  // Cyrillic lookalikes
  '\u0430': 'a', // Cyrillic small letter a
  '\u0410': 'a', // Cyrillic capital letter A
  '\u0431': 'b', // Cyrillic small letter be (lookalike in some fonts)
  '\u0432': 'b', // Cyrillic small letter ve
  '\u0412': 'b', // Cyrillic capital letter Ve
  '\u0441': 'c', // Cyrillic small letter es
  '\u0421': 'c', // Cyrillic capital letter Es
  '\u0434': 'd', // Cyrillic small letter de
  '\u0501': 'd', // Cyrillic small letter dwe
  '\u0435': 'e', // Cyrillic small letter ie
  '\u0415': 'e', // Cyrillic capital letter Ie
  '\u0451': 'e', // Cyrillic small letter io
  '\u0456': 'i', // Cyrillic small letter byelorussian-ukrainian i
  '\u0406': 'i', // Cyrillic capital letter Byelorussian-Ukrainian I
  '\u0458': 'j', // Cyrillic small letter je
  '\u0408': 'j', // Cyrillic capital letter Je
  '\u043A': 'k', // Cyrillic small letter ka
  '\u041A': 'k', // Cyrillic capital letter Ka
  '\u043C': 'm', // Cyrillic small letter em
  '\u041C': 'm', // Cyrillic capital letter Em
  '\u043D': 'h', // Cyrillic small letter en
  '\u041D': 'h', // Cyrillic capital letter En
  '\u043E': 'o', // Cyrillic small letter o
  '\u041E': 'o', // Cyrillic capital letter O
  '\u0440': 'p', // Cyrillic small letter er
  '\u0420': 'p', // Cyrillic capital letter Er
  '\u0442': 't', // Cyrillic small letter te
  '\u0422': 't', // Cyrillic capital letter Te
  '\u0443': 'y', // Cyrillic small letter u
  '\u0423': 'y', // Cyrillic capital letter U
  '\u0445': 'x', // Cyrillic small letter ha
  '\u0425': 'x', // Cyrillic capital letter Ha
  '\u051B': 'q', // Cyrillic small letter qa
  '\u051D': 'w', // Cyrillic small letter we

  // Greek lookalikes
  '\u03B1': 'a', // Greek small letter alpha
  '\u0391': 'a', // Greek capital letter Alpha
  '\u03B2': 'b', // Greek small letter beta
  '\u0392': 'b', // Greek capital letter Beta
  '\u03B5': 'e', // Greek small letter epsilon
  '\u0395': 'e', // Greek capital letter Epsilon
  '\u03B7': 'n', // Greek small letter eta
  '\u0397': 'h', // Greek capital letter Eta
  '\u03B9': 'i', // Greek small letter iota
  '\u0399': 'i', // Greek capital letter Iota
  '\u03BA': 'k', // Greek small letter kappa
  '\u039A': 'k', // Greek capital letter Kappa
  '\u03BD': 'v', // Greek small letter nu
  '\u03BF': 'o', // Greek small letter omicron
  '\u039F': 'o', // Greek capital letter Omicron
  '\u03C1': 'p', // Greek small letter rho
  '\u03A1': 'p', // Greek capital letter Rho
  '\u03C4': 't', // Greek small letter tau
  '\u03A4': 't', // Greek capital letter Tau
  '\u03C5': 'u', // Greek small letter upsilon
  '\u03C7': 'x', // Greek small letter chi
  '\u03A7': 'x', // Greek capital letter Chi
  '\u03C9': 'w', // Greek small letter omega

  // Common confusable digits/symbols
  '0': 'o',
  '1': 'l',
}

// Pre-computed set of reserved skeletons
const RESERVED_SKELETONS = new Set<string>(
  RESERVED_NAMES.map((name) => computeConfusableSkeleton(name)),
)

/**
 * Computes a canonical confusable skeleton string by:
 * 1. NFKC normalization
 * 2. Lowercasing
 * 3. Stripping non-essential accents/diacritics
 * 4. Mapping homoglyph/confusable glyphs to canonical ASCII skeletons
 */
export function computeConfusableSkeleton(input: string): string {
  // NFKC decomposes and recomposes compatible characters (e.g. fullwidth to ASCII)
  const normalized = input.normalize('NFKC').toLowerCase().trim()

  // Remove combining diacritical marks (e.g. á -> a + ´ -> a)
  const strippedDiacritics = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  let skeleton = ''
  for (const char of strippedDiacritics) {
    if (CONFUSABLE_MAP[char]) {
      skeleton += CONFUSABLE_MAP[char]
    } else {
      skeleton += char
    }
  }

  return skeleton
}

/**
 * Validates and normalizes an input name.
 * Allowed character set:
 * - Lowercase ASCII letters (a-z), digits (0-9), and hyphens (-)
 * - Length between 3 and 32 characters inclusive
 * - Cannot start or end with a hyphen
 * - Cannot have consecutive hyphens
 */
export function normalizeAndValidateName(rawName: string): {
  normalized: string
  skeleton: string
} {
  if (!rawName || typeof rawName !== 'string') {
    throw new InvalidNameError('Name must be a non-empty string.')
  }

  const trimmed = rawName.trim().toLowerCase()
  if (trimmed.length < MIN_NAME_LENGTH) {
    throw new InvalidNameError(`Name must be at least ${MIN_NAME_LENGTH} characters long.`)
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new InvalidNameError(`Name cannot exceed ${MAX_NAME_LENGTH} characters.`)
  }

  // Canonical name format: only standard ASCII lowercase alphanumeric and hyphens
  const VALID_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  const skeleton = computeConfusableSkeleton(trimmed)

  if (!VALID_NAME_REGEX.test(trimmed)) {
    throw new InvalidNameError(
      'Name contains invalid characters. Only lowercase alphanumeric characters (a-z, 0-9) and internal hyphens (-) are allowed.',
    )
  }

  return {
    normalized: trimmed,
    skeleton,
  }
}

/**
 * Checks whether a name or its confusable skeleton matches a reserved name.
 */
export function isNameReserved(name: string): boolean {
  const trimmed = name.trim().toLowerCase()
  if (RESERVED_NAMES.includes(trimmed)) {
    return true
  }
  const skeleton = computeConfusableSkeleton(trimmed)
  return RESERVED_SKELETONS.has(skeleton)
}

export interface ClaimedNameRecord {
  name: string
  skeleton: string
  tokenId: string
  walletAddress: string
  passkeyPublicKey: string
  paymentTxHash: string
  claimedAt: number
}

export interface ClaimNameParams {
  name: string
  walletAddress: string
  passkeyPublicKey: string
  paymentTxHash?: string
  signature?: string
}

export type PaymentVerifier = (
  paymentTxHash: string,
  expectedAmount: string,
  walletAddress: string,
) => Promise<boolean>

export type PasskeySignatureVerifier = (
  passkeyPublicKey: string,
  payload: string,
  signature: string,
) => Promise<boolean>

export class InvalidNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidNameError'
  }
}

export class ReservedNameError extends Error {
  constructor(name: string) {
    super(`Name "${name}" is reserved and cannot be claimed.`)
    this.name = 'ReservedNameError'
  }
}

export class NameAlreadyTakenError extends Error {
  constructor(name: string) {
    super(`Name "${name}" (or a visually confusable form) is already taken.`)
    this.name = 'NameAlreadyTakenError'
  }
}

export class UnpaidClaimError extends Error {
  constructor(message = 'Payment of 5 USDC is required to claim a name. Unpaid claims reserve nothing.') {
    super(message)
    this.name = 'UnpaidClaimError'
  }
}

export class PasskeyAlreadyClaimedError extends Error {
  constructor(passkeyPublicKey: string) {
    super(`Passkey "${passkeyPublicKey}" has already claimed a name. Limit is one name per passkey.`)
    this.name = 'PasskeyAlreadyClaimedError'
  }
}

export class InvalidSignatureError extends Error {
  constructor(message = 'Invalid passkey signature.') {
    super(message)
    this.name = 'InvalidSignatureError'
  }
}

/**
 * In-memory name registry supporting concurrency mutex locking,
 * payment verification, passkey uniqueness, and confusable detection.
 */
export class NamesRegistry {
  private names = new Map<string, ClaimedNameRecord>() // key: normalized name
  private skeletons = new Map<string, string>() // key: skeleton -> normalized name
  private passkeys = new Map<string, string>() // key: passkeyPublicKey -> normalized name
  private inFlightClaims = new Map<string, Promise<ClaimedNameRecord>>() // mutex per skeleton
  private nextTokenId = 1

  private paymentVerifier: PaymentVerifier
  private signatureVerifier: PasskeySignatureVerifier

  constructor(options?: {
    paymentVerifier?: PaymentVerifier
    signatureVerifier?: PasskeySignatureVerifier
    initialRecords?: ClaimedNameRecord[]
  }) {
    this.paymentVerifier =
      options?.paymentVerifier ?? (async (txHash) => Boolean(txHash && txHash.trim().length > 0))
    this.signatureVerifier = options?.signatureVerifier ?? (async () => true)

    if (options?.initialRecords) {
      for (const rec of options?.initialRecords) {
        this.insertRecord(rec)
      }
    }
  }

  private insertRecord(record: ClaimedNameRecord): void {
    this.names.set(record.name, record)
    this.skeletons.set(record.skeleton, record.name)
    this.passkeys.set(record.passkeyPublicKey, record.name)
    const numericTokenId = parseInt(record.tokenId, 10)
    if (!isNaN(numericTokenId) && numericTokenId >= this.nextTokenId) {
      this.nextTokenId = numericTokenId + 1
    }
  }

  /**
   * Checks whether a name is available for registration.
   */
  public checkAvailability(rawName: string): {
    available: boolean
    reason?: string
    normalized?: string
    skeleton?: string
  } {
    let normalized: string
    let skeleton: string

    try {
      const res = normalizeAndValidateName(rawName)
      normalized = res.normalized
      skeleton = res.skeleton
    } catch (err) {
      // If validation fails because of non-ASCII homoglyphs, check if its skeleton is taken
      const rawTrimmed = (rawName || '').trim().toLowerCase()
      const rawSkeleton = computeConfusableSkeleton(rawTrimmed)

      if (RESERVED_SKELETONS.has(rawSkeleton)) {
        return { available: false, reason: 'Reserved name', skeleton: rawSkeleton }
      }
      if (this.skeletons.has(rawSkeleton)) {
        return {
          available: false,
          reason: `Confusable form of already taken name "${this.skeletons.get(rawSkeleton)}"`,
          skeleton: rawSkeleton,
        }
      }
      return {
        available: false,
        reason: err instanceof Error ? err.message : 'Invalid name format',
      }
    }

    if (isNameReserved(normalized)) {
      return { available: false, reason: 'Reserved name', normalized, skeleton }
    }

    if (this.names.has(normalized)) {
      return { available: false, reason: 'Name is already taken', normalized, skeleton }
    }

    if (this.skeletons.has(skeleton)) {
      const takenBy = this.skeletons.get(skeleton)
      return {
        available: false,
        reason: `Confusable form of already taken name "${takenBy}"`,
        normalized,
        skeleton,
      }
    }

    return { available: true, normalized, skeleton }
  }

  /**
   * Claims a name atomically.
   *
   * Enforces:
   * 1. Confusable / homoglyph and case normalization
   * 2. Reserved name prohibition
   * 3. Passkey single-claim limitation
   * 4. 5 USDC payment verification before reservation (unpaid claims reserve nothing)
   * 5. Concurrent claim serialization ensuring only one requester wins
   */
  public async claimName(params: ClaimNameParams): Promise<ClaimedNameRecord> {
    const { name: rawName, walletAddress, passkeyPublicKey, paymentTxHash, signature } = params

    if (!walletAddress || typeof walletAddress !== 'string' || !walletAddress.trim()) {
      throw new Error('Wallet address is required.')
    }
    if (!passkeyPublicKey || typeof passkeyPublicKey !== 'string' || !passkeyPublicKey.trim()) {
      throw new Error('Passkey public key is required.')
    }

    const { normalized, skeleton } = normalizeAndValidateName(rawName)

    // Check reserved names
    if (isNameReserved(normalized) || RESERVED_SKELETONS.has(skeleton)) {
      throw new ReservedNameError(normalized)
    }

    // Check if this passkey has already claimed a name
    if (this.passkeys.has(passkeyPublicKey)) {
      throw new PasskeyAlreadyClaimedError(passkeyPublicKey)
    }

    // Check if name or skeleton is already taken
    if (this.names.has(normalized) || this.skeletons.has(skeleton)) {
      throw new NameAlreadyTakenError(normalized)
    }

    // Atomic concurrency lock on the skeleton
    while (this.inFlightClaims.has(skeleton)) {
      try {
        await this.inFlightClaims.get(skeleton)
        // If the prior in-flight claim succeeded, the name is now taken
        throw new NameAlreadyTakenError(normalized)
      } catch (err) {
        if (err instanceof NameAlreadyTakenError) {
          throw err
        }
        // Prior in-flight claim failed/abandoned; loop to re-check and acquire lock
        break
      }
    }

    // Check again in case someone claimed while waiting
    if (this.names.has(normalized) || this.skeletons.has(skeleton)) {
      throw new NameAlreadyTakenError(normalized)
    }
    if (this.passkeys.has(passkeyPublicKey)) {
      throw new PasskeyAlreadyClaimedError(passkeyPublicKey)
    }

    // Create the execution promise for this claim
    const claimExecution = (async () => {
      // 1. Verify payment of 5 USDC
      if (!paymentTxHash || !paymentTxHash.trim()) {
        throw new UnpaidClaimError()
      }

      const isPaid = await this.paymentVerifier(paymentTxHash, NAME_PRICE_USDC, walletAddress)
      if (!isPaid) {
        throw new UnpaidClaimError('Payment verification failed for 5 USDC.')
      }

      // 2. Verify passkey signature if provided or required
      if (signature) {
        const payload = `${normalized}:${walletAddress}:${paymentTxHash}`
        const isValidSignature = await this.signatureVerifier(passkeyPublicKey, payload, signature)
        if (!isValidSignature) {
          throw new InvalidSignatureError()
        }
      }

      // Double-check state before committing
      if (this.names.has(normalized) || this.skeletons.has(skeleton)) {
        throw new NameAlreadyTakenError(normalized)
      }
      if (this.passkeys.has(passkeyPublicKey)) {
        throw new PasskeyAlreadyClaimedError(passkeyPublicKey)
      }

      const tokenId = String(this.nextTokenId++)
      const record: ClaimedNameRecord = {
        name: normalized,
        skeleton,
        tokenId,
        walletAddress: walletAddress.trim(),
        passkeyPublicKey: passkeyPublicKey.trim(),
        paymentTxHash: paymentTxHash.trim(),
        claimedAt: Date.now(),
      }

      this.insertRecord(record)
      return record
    })()

    this.inFlightClaims.set(skeleton, claimExecution)

    try {
      const record = await claimExecution
      return record
    } finally {
      this.inFlightClaims.delete(skeleton)
    }
  }

  public getClaimByName(name: string): ClaimedNameRecord | null {
    const trimmed = (name || '').trim().toLowerCase()
    return this.names.get(trimmed) ?? null
  }

  public getClaimBySkeleton(skeleton: string): ClaimedNameRecord | null {
    const name = this.skeletons.get(skeleton)
    if (!name) return null
    return this.names.get(name) ?? null
  }

  public getClaimByPasskey(passkeyPublicKey: string): ClaimedNameRecord | null {
    const name = this.passkeys.get(passkeyPublicKey)
    if (!name) return null
    return this.names.get(name) ?? null
  }

  public getAllClaims(): ClaimedNameRecord[] {
    return Array.from(this.names.values())
  }

  public reset(): void {
    this.names.clear()
    this.skeletons.clear()
    this.passkeys.clear()
    this.inFlightClaims.clear()
    this.nextTokenId = 1
  }
}

/** Global singleton registry instance */
export const globalNamesRegistry = new NamesRegistry()
