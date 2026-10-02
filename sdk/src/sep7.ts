/**
 * SEP-7 "pay" request links (Stellar URI scheme).
 *
 * Build shareable `web+stellar:pay?…` URIs (amount, asset, memo, callback) for
 * payment requests, and safely parse inbound links back into structured,
 * validated fields that can pre-fill a send flow.
 *
 * Security: inbound URIs are untrusted input. {@link parseSep7PayUri} validates
 * and normalises every field — rejecting malformed amounts, bad addresses,
 * oversized inputs, and hostile callbacks (e.g. `javascript:`/`data:` URLs) —
 * so callers never act on an unchecked value.
 *
 * Reference: https://stellar.org/protocol/sep-7
 */

import { StrKey } from '@stellar/stellar-sdk';

// ── Constants ────────────────────────────────────────────────────────────────────

/** The SEP-7 URI scheme, including the colon. */
export const SEP7_SCHEME = 'web+stellar:';

/**
 * Hard cap on the length of an inbound URI. SEP-7 has no formal limit; we cap to
 * keep parsing of hostile input bounded. Generous enough for any real request.
 */
export const MAX_SEP7_URI_LENGTH = 7168;

/** Max bytes for a `text` memo (Stellar protocol limit). */
const MAX_MEMO_TEXT_BYTES = 28;
/** Max length for the human-readable `msg` field (SEP-7 recommendation). */
const MAX_MSG_LENGTH = 300;
/** Largest amount, in stroops, representable on Stellar (int64 max). */
const MAX_STROOPS = 9_223_372_036_854_775_807n;
/** Largest value for an `id` memo (uint64 max). */
const MAX_MEMO_ID = 18_446_744_073_709_551_615n;

export type Sep7MemoType = 'text' | 'id' | 'hash' | 'return';

/** The validated, normalised fields of a SEP-7 `pay` request. */
export type Sep7PayRequest = {
    /** Stellar account (`G…`), muxed account (`M…`), or contract (`C…`) to pay. */
    destination: string;
    /** Decimal amount string (≤ 7 dp), if the request fixes an amount. */
    amount?: string;
    /** Asset code (1–12 alphanumerics). Absent means native XLM. */
    assetCode?: string;
    /** Asset issuer (`G…`). Required for any non-native asset. */
    assetIssuer?: string;
    /** Memo value, interpreted per {@link Sep7PayRequest.memoType}. */
    memo?: string;
    /** Memo type; defaults to `text` when a memo is present. */
    memoType?: Sep7MemoType;
    /** Callback URL the wallet should POST the signed tx to (without the `url:` prefix). */
    callback?: string;
    /** Free-text message describing the request (≤ 300 chars). */
    msg?: string;
    /** Network passphrase, if the request pins a specific network. */
    networkPassphrase?: string;
    /** Fully-qualified domain that produced the request (for SEP-7 signing). */
    originDomain?: string;
};

/** Thrown when an inbound SEP-7 URI is malformed, unsupported, or hostile. */
export class Sep7Error extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'Sep7Error';
    }
}

// ── Validation helpers ─────────────────────────────────────────────────────────────

/** True for a valid Stellar destination: account, muxed account, or contract. */
export function isValidDestination(value: string): boolean {
    return (
        StrKey.isValidEd25519PublicKey(value) ||
        StrKey.isValidMed25519PublicKey(value) ||
        StrKey.isValidContract(value)
    );
}

// Positive decimal: optional integer part, optional fractional part, no sign,
// no exponent, no surrounding whitespace.
const AMOUNT_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const ORIGIN_DOMAIN_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

function normalizeAmount(raw: string): string {
    const amount = raw.trim();
    if (!AMOUNT_RE.test(amount)) {
        throw new Sep7Error(`Invalid amount: "${raw}"`);
    }
    const [intPart, fracPart = ''] = amount.split('.');
    if (fracPart.length > 7) {
        throw new Sep7Error('Amount has more than 7 decimal places');
    }
    // Range-check by converting to stroops without floating point.
    const stroops = BigInt(intPart || '0') * 10_000_000n + BigInt((fracPart + '0000000').slice(0, 7));
    if (stroops <= 0n) throw new Sep7Error('Amount must be greater than zero');
    if (stroops > MAX_STROOPS) throw new Sep7Error('Amount exceeds the maximum supported value');
    return amount;
}

function validateMemo(memo: string, memoType: Sep7MemoType): void {
    switch (memoType) {
        case 'text':
            if (new TextEncoder().encode(memo).length > MAX_MEMO_TEXT_BYTES) {
                throw new Sep7Error(`Text memo exceeds ${MAX_MEMO_TEXT_BYTES} bytes`);
            }
            return;
        case 'id':
            if (!/^\d+$/.test(memo) || BigInt(memo) > MAX_MEMO_ID) {
                throw new Sep7Error('Id memo must be an unsigned 64-bit integer');
            }
            return;
        case 'hash':
        case 'return': {
            // SEP-7 transmits hash/return memos base64-encoded; must decode to 32 bytes.
            let decodedLen: number;
            try {
                const normalized = memo.replace(/-/g, '+').replace(/_/g, '/');
                const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
                decodedLen = atob(padded).length;
            } catch {
                throw new Sep7Error(`${memoType} memo is not valid base64`);
            }
            if (decodedLen !== 32) {
                throw new Sep7Error(`${memoType} memo must decode to 32 bytes`);
            }
            return;
        }
        default:
            throw new Sep7Error(`Unsupported memo type: "${memoType}"`);
    }
}

// Only http(s) callbacks are honoured. This is the main guard against hostile
// schemes such as javascript:, data:, file:, or vbscript: smuggled in a link.
function normalizeCallback(raw: string): string {
    const withoutPrefix = raw.startsWith('url:') ? raw.slice('url:'.length) : raw;
    let parsed: URL;
    try {
        parsed = new URL(withoutPrefix);
    } catch {
        throw new Sep7Error('Callback is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Sep7Error(`Unsupported callback scheme: "${parsed.protocol}"`);
    }
    return withoutPrefix;
}

// ── Parsing ──────────────────────────────────────────────────────────────────────

/**
 * Parse and validate an inbound SEP-7 `pay` URI into normalised fields.
 *
 * @throws {Sep7Error} if the input is not a `web+stellar:pay` URI, is too long,
 *         or any field fails validation.
 */
export function parseSep7PayUri(input: string): Sep7PayRequest {
    if (typeof input !== 'string') throw new Sep7Error('URI must be a string');
    const raw = input.trim();
    if (!raw) throw new Sep7Error('URI is empty');
    if (raw.length > MAX_SEP7_URI_LENGTH) throw new Sep7Error('URI exceeds maximum length');

    if (!raw.toLowerCase().startsWith(SEP7_SCHEME)) {
        throw new Sep7Error(`Not a ${SEP7_SCHEME} URI`);
    }

    // Strip scheme, then split "<operation>?<query>".
    const afterScheme = raw.slice(SEP7_SCHEME.length);
    const qIndex = afterScheme.indexOf('?');
    const operation = (qIndex === -1 ? afterScheme : afterScheme.slice(0, qIndex)).toLowerCase();
    const query = qIndex === -1 ? '' : afterScheme.slice(qIndex + 1);

    if (operation !== 'pay') {
        throw new Sep7Error(`Unsupported SEP-7 operation: "${operation || '(none)'}" (only "pay" is supported)`);
    }

    let params: URLSearchParams;
    try {
        params = new URLSearchParams(query);
    } catch {
        throw new Sep7Error('Malformed query string');
    }

    const get = (key: string): string | undefined => {
        const v = params.get(key);
        if (v == null) return undefined;
        const t = v.trim();
        return t ? t : undefined;
    };

    const destination = get('destination');
    if (!destination) throw new Sep7Error('Missing required field: destination');
    if (!isValidDestination(destination)) throw new Sep7Error(`Invalid destination address: "${destination}"`);

    const result: Sep7PayRequest = { destination };

    const amount = get('amount');
    if (amount !== undefined) result.amount = normalizeAmount(amount);

    const assetCode = get('asset_code');
    const assetIssuer = get('asset_issuer');
    if (assetCode !== undefined) {
        if (!ASSET_CODE_RE.test(assetCode)) throw new Sep7Error(`Invalid asset_code: "${assetCode}"`);
        const isNative = assetCode.toUpperCase() === 'XLM' && assetIssuer === undefined;
        if (!isNative) {
            if (assetIssuer === undefined) throw new Sep7Error('asset_issuer is required for a non-native asset');
            if (!StrKey.isValidEd25519PublicKey(assetIssuer)) {
                throw new Sep7Error(`Invalid asset_issuer: "${assetIssuer}"`);
            }
            result.assetCode = assetCode;
            result.assetIssuer = assetIssuer;
        }
    } else if (assetIssuer !== undefined) {
        throw new Sep7Error('asset_issuer provided without asset_code');
    }

    const memo = get('memo');
    if (memo !== undefined) {
        const memoType = (get('memo_type') ?? 'text') as Sep7MemoType;
        validateMemo(memo, memoType);
        result.memo = memo;
        result.memoType = memoType;
    } else if (get('memo_type') !== undefined) {
        throw new Sep7Error('memo_type provided without memo');
    }

    const callback = get('callback');
    if (callback !== undefined) result.callback = normalizeCallback(callback);

    const msg = get('msg');
    if (msg !== undefined) {
        if (msg.length > MAX_MSG_LENGTH) throw new Sep7Error(`msg exceeds ${MAX_MSG_LENGTH} characters`);
        result.msg = msg;
    }

    const networkPassphrase = get('network_passphrase');
    if (networkPassphrase !== undefined) result.networkPassphrase = networkPassphrase;

    const originDomain = get('origin_domain');
    if (originDomain !== undefined) {
        if (!ORIGIN_DOMAIN_RE.test(originDomain)) throw new Sep7Error(`Invalid origin_domain: "${originDomain}"`);
        result.originDomain = originDomain;
    }

    return result;
}

/**
 * Parse a scanned QR value that may be either a bare Stellar address or a SEP-7
 * `pay` URI. Returns normalised pay fields.
 *
 * @throws {Sep7Error} if the value is neither a valid address nor a valid URI.
 */
export function parseSep7QrValue(value: string): Sep7PayRequest {
    const v = (value ?? '').trim();
    if (!v) throw new Sep7Error('Empty QR value');
    if (isValidDestination(v)) return { destination: v };
    return parseSep7PayUri(v);
}

// ── Building ────────────────────────────────────────────────────────────────────

/** Fields accepted when constructing a SEP-7 `pay` request. */
export type Sep7PayParams = {
    destination: string;
    amount?: string | number;
    assetCode?: string;
    assetIssuer?: string;
    memo?: string;
    memoType?: Sep7MemoType;
    /** Plain http(s) callback URL; the required `url:` prefix is added for you. */
    callback?: string;
    msg?: string;
    networkPassphrase?: string;
    originDomain?: string;
};

// RFC 3986-safe component encoding (encodeURIComponent leaves a few sub-delims;
// also escape them so the value survives any conformant SEP-7 parser).
function encode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
}

/**
 * Build a validated SEP-7 `pay` URI. The same validation as {@link parseSep7PayUri}
 * is applied, so a builder can never emit a link the parser would reject.
 *
 * @throws {Sep7Error} if any field is invalid.
 */
export function buildSep7PayUri(params: Sep7PayParams): string {
    if (!params.destination || !isValidDestination(params.destination)) {
        throw new Sep7Error(`Invalid destination address: "${params.destination}"`);
    }

    const pairs: Array<[string, string]> = [['destination', params.destination]];

    if (params.amount !== undefined && params.amount !== '') {
        pairs.push(['amount', normalizeAmount(String(params.amount))]);
    }

    if (params.assetCode !== undefined) {
        if (!ASSET_CODE_RE.test(params.assetCode)) throw new Sep7Error(`Invalid asset_code: "${params.assetCode}"`);
        const isNative = params.assetCode.toUpperCase() === 'XLM' && !params.assetIssuer;
        if (!isNative) {
            if (!params.assetIssuer || !StrKey.isValidEd25519PublicKey(params.assetIssuer)) {
                throw new Sep7Error('A valid asset_issuer is required for a non-native asset');
            }
            pairs.push(['asset_code', params.assetCode]);
            pairs.push(['asset_issuer', params.assetIssuer]);
        }
    } else if (params.assetIssuer !== undefined) {
        throw new Sep7Error('asset_issuer provided without asset_code');
    }

    if (params.memo !== undefined) {
        const memoType = params.memoType ?? 'text';
        validateMemo(params.memo, memoType);
        pairs.push(['memo', params.memo]);
        if (memoType !== 'text') pairs.push(['memo_type', memoType]);
    } else if (params.memoType !== undefined) {
        throw new Sep7Error('memoType provided without memo');
    }

    if (params.callback !== undefined) {
        const normalized = normalizeCallback(params.callback);
        pairs.push(['callback', `url:${normalized}`]);
    }

    if (params.msg !== undefined) {
        if (params.msg.length > MAX_MSG_LENGTH) throw new Sep7Error(`msg exceeds ${MAX_MSG_LENGTH} characters`);
        pairs.push(['msg', params.msg]);
    }

    if (params.networkPassphrase !== undefined) pairs.push(['network_passphrase', params.networkPassphrase]);

    if (params.originDomain !== undefined) {
        if (!ORIGIN_DOMAIN_RE.test(params.originDomain)) throw new Sep7Error(`Invalid origin_domain: "${params.originDomain}"`);
        pairs.push(['origin_domain', params.originDomain]);
    }

    const query = pairs.map(([k, v]) => `${k}=${encode(v)}`).join('&');
    return `${SEP7_SCHEME}pay?${query}`;
}

