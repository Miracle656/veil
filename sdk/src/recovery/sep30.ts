/**
 * SEP-30 (recoverysigner) client.
 *
 * A SEP-30 recovery server lets a user re-establish control of an account after
 * device loss without any single party holding the key. The account owner
 * registers a set of *identities* (phone, email, another Stellar address, …)
 * with one or more recovery servers; each server contributes a signer to the
 * account. After losing their device the user re-authenticates each identity
 * (via SEP-10, yielding a JWT), then asks the servers to sign a transaction that
 * installs a fresh signer — re-establishing access.
 *
 * Spec: https://stellar.org/protocol/sep-30
 *
 * This client is transport-only and dependency-free: it speaks the SEP-30 REST
 * API over `fetch` and deals in base64 transaction XDR strings, so it works
 * unchanged in the browser, React Native, and Node. SEP-10 authentication is out
 * of scope — supply the resulting JWT via `authToken`/`getAuthToken`.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single authentication method for an identity (SEP-30 §"auth_methods"). */
export interface Sep30AuthMethod {
    /** e.g. "stellar_address", "phone_number", "email". */
    type: string;
    value: string;
}

/** An identity that may authenticate to recover the account. */
export interface Sep30Identity {
    /** e.g. "owner" or "other". */
    role: string;
    auth_methods: Sep30AuthMethod[];
}

/** A signer the recovery server contributes to the account. */
export interface Sep30Signer {
    key: string;
    added_at?: string;
}

/** Recovery-server view of a registered account. */
export interface Sep30Account {
    address: string;
    identities: Array<{ role: string; authenticated?: boolean }>;
    signers: Sep30Signer[];
}

/** A signature returned by the recovery server for a submitted transaction. */
export interface Sep30Signature {
    /** Base64 signature to attach to the transaction. */
    signature: string;
    /** Network passphrase the signature is valid for. */
    network_passphrase: string;
}

export interface Sep30ClientOptions {
    /** Base URL of the recovery server, e.g. "https://recovery.example.com". */
    baseUrl: string;
    /** Static SEP-10 JWT. Prefer {@link getAuthToken} when the token rotates. */
    authToken?: string;
    /** Lazily resolve the current SEP-10 JWT (called before each request). */
    getAuthToken?: () => string | null | undefined | Promise<string | null | undefined>;
    /** Override the fetch implementation (defaults to the global `fetch`). */
    fetchImpl?: typeof fetch;
}

/** Thrown when the recovery server returns a non-2xx response. */
export class Sep30Error extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = 'Sep30Error';
    }
}

// ── Client ──────────────────────────────────────────────────────────────────

export class Sep30Client {
    private readonly baseUrl: string;
    private readonly opts: Sep30ClientOptions;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: Sep30ClientOptions) {
        if (!opts.baseUrl) throw new Error('Sep30Client requires a baseUrl');
        // Normalise a trailing slash so path joins are predictable.
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.opts = opts;
        const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
        if (!f) throw new Error('No fetch implementation available; pass fetchImpl');
        // Bind to avoid "Illegal invocation" when fetch is the global.
        this.fetchImpl = f.bind(globalThis);
    }

    private async authHeader(): Promise<Record<string, string>> {
        const token = this.opts.getAuthToken
            ? await this.opts.getAuthToken()
            : this.opts.authToken;
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...(await this.authHeader()),
        };
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const text = await res.text();
        let parsed: unknown = undefined;
        if (text) {
            try { parsed = JSON.parse(text); } catch { parsed = text; }
        }

        if (!res.ok) {
            const msg =
                parsed && typeof parsed === 'object' && 'error' in parsed
                    ? String((parsed as { error: unknown }).error)
                    : `Recovery server responded ${res.status}`;
            throw new Sep30Error(res.status, msg);
        }
        return parsed as T;
    }

    /**
     * Register (or replace) the account with this recovery server.
     *
     * @param address    The Stellar account address ("G..." or contract "C...").
     * @param identities The identities allowed to authenticate for recovery.
     * @returns The registered account, including the signer the server contributes.
     */
    registerAccount(address: string, identities: Sep30Identity[]): Promise<Sep30Account> {
        return this.request<Sep30Account>('POST', `/accounts/${address}`, { identities });
    }

    /** Update the identities on an already-registered account. */
    updateAccount(address: string, identities: Sep30Identity[]): Promise<Sep30Account> {
        return this.request<Sep30Account>('PUT', `/accounts/${address}`, { identities });
    }

    /** Fetch the recovery server's view of an account (signers, identity auth state). */
    getAccount(address: string): Promise<Sep30Account> {
        return this.request<Sep30Account>('GET', `/accounts/${address}`);
    }

    /** Remove the account's registration from this recovery server. */
    deleteAccount(address: string): Promise<Sep30Account> {
        return this.request<Sep30Account>('DELETE', `/accounts/${address}`);
    }

    /**
     * Ask the recovery server to sign a transaction with one of its signers.
     * The caller must already be authenticated (JWT) for an identity on the account.
     *
     * @param address        The account being recovered.
     * @param signingAddress The server signer key to sign with (from {@link getAccount}).
     * @param transactionXdr The base64-encoded transaction envelope to sign.
     */
    signTransaction(address: string, signingAddress: string, transactionXdr: string): Promise<Sep30Signature> {
        return this.request<Sep30Signature>(
            'POST',
            `/accounts/${address}/sign/${signingAddress}`,
            { transaction: transactionXdr },
        );
    }
}

// ── Multi-server helper ────────────────────────────────────────────────────────

/** One recovery server participating in a recovery, paired with its signer key. */
export interface RecoveryServer {
    client: Sep30Client;
    /** The server's signing address on the account (from {@link Sep30Client.getAccount}). */
    signerKey: string;
}

/** A signature collected from a recovery server, tagged with the signer it used. */
export interface CollectedSignature extends Sep30Signature {
    signerKey: string;
}

/**
 * Collect signatures for a transaction from every supplied recovery server.
 *
 * Requests run concurrently; if `requireAll` is true (default) any single
 * failure rejects, otherwise failures are skipped and whatever signatures
 * succeeded are returned (useful for an M-of-N recovery threshold).
 *
 * @returns The signatures gathered, each tagged with the server signer key.
 */
export async function collectRecoverySignatures(
    servers: RecoveryServer[],
    address: string,
    transactionXdr: string,
    opts: { requireAll?: boolean } = {},
): Promise<CollectedSignature[]> {
    const requireAll = opts.requireAll ?? true;

    const results = await Promise.allSettled(
        servers.map(async (s): Promise<CollectedSignature> => {
            const sig = await s.client.signTransaction(address, s.signerKey, transactionXdr);
            return { ...sig, signerKey: s.signerKey };
        }),
    );

    const signatures: CollectedSignature[] = [];
    for (const r of results) {
        if (r.status === 'fulfilled') signatures.push(r.value);
        else if (requireAll) throw r.reason;
    }
    return signatures;
}
