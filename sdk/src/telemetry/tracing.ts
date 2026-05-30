/**
 * sdk/src/telemetry/tracing.ts
 *
 * Optional OTLP tracing for the Veil SDK.
 * Gated behind a `tracing: { exporter, endpoint }` SDK option.
 * Defaults to a no-op — zero performance cost when not configured.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TracingConfig = {
    /** OTLP exporter type. Currently only 'otlp-http' is supported. */
    exporter: 'otlp-http';
    /** Full URL of your OTel collector endpoint, e.g. "http://localhost:4318/v1/traces" */
    endpoint: string;
};

type SimpleSpan = {
    setAttribute(key: string, value: string | number | boolean): void;
    setStatus(status: { code: number; message?: string }): void;
    recordException(err: Error): void;
    end(): void;
};

// ── Internal state ────────────────────────────────────────────────────────────

let _initialized = false;
let _endpoint    = '';

// ── Setup ─────────────────────────────────────────────────────────────────────

export async function initTracing(config: TracingConfig): Promise<void> {
    if (_initialized) return;
    _initialized = true;
    _endpoint    = config.endpoint;
}

// ── Span helpers ──────────────────────────────────────────────────────────────

/**
 * Wrap an async function in an OTLP trace span.
 * If tracing is not configured, calls fn() directly with zero overhead.
 */
export async function withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: SimpleSpan) => Promise<T>
): Promise<T> {
    // No-op fast path
    if (!_initialized || !_endpoint) {
        const noopSpan: SimpleSpan = {
            setAttribute: () => {},
            setStatus:    () => {},
            recordException: () => {},
            end:          () => {},
        };
        return fn(noopSpan);
    }

    const traceId  = randomHex(16);
    const spanId   = randomHex(8);
    const start    = Date.now();
    const spanAttrs = { ...attributes };
    let   statusCode = 1; // OK
    let   statusMsg  = '';
    let   errorEvent: { name: string; message: string } | null = null;

    const span: SimpleSpan = {
        setAttribute(key, value) { spanAttrs[key] = value; },
        setStatus({ code, message }) { statusCode = code; statusMsg = message ?? ''; },
        recordException(err) { errorEvent = { name: err.name, message: err.message }; },
        end() { /* flush handled after fn resolves */ },
    };

    try {
        const result = await fn(span);
        statusCode = 1; // OK
        return result;
    } catch (err: unknown) {
        statusCode = 2; // ERROR
        statusMsg  = err instanceof Error ? err.message : String(err);
        if (err instanceof Error) errorEvent = { name: err.name, message: err.message };
        throw err;
    } finally {
        const end = Date.now();
        flush({
            traceId, spanId, name, start, end,
            attributes: spanAttrs, statusCode, statusMsg, errorEvent,
        }).catch(() => { /* best-effort — never throw */ });
    }
}

// ── OTLP HTTP flush ───────────────────────────────────────────────────────────

type FlushArgs = {
    traceId: string;
    spanId: string;
    name: string;
    start: number;
    end: number;
    attributes: Record<string, string | number | boolean>;
    statusCode: number;
    statusMsg: string;
    errorEvent: { name: string; message: string } | null;
};

async function flush(args: FlushArgs): Promise<void> {
    const { traceId, spanId, name, start, end, attributes, statusCode, statusMsg, errorEvent } = args;

    const kvAttrs = Object.entries(attributes).map(([key, value]) => ({
        key,
        value: typeof value === 'string'
            ? { stringValue: value }
            : typeof value === 'number'
            ? { intValue: value }
            : { boolValue: value },
    }));

    if (errorEvent) {
        kvAttrs.push(
            { key: 'exception.type',    value: { stringValue: errorEvent.name } },
            { key: 'exception.message', value: { stringValue: errorEvent.message } },
        );
    }

    const body = {
        resourceSpans: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'invisible-wallet-sdk' } }] },
            scopeSpans: [{
                scope: { name: 'invisible-wallet-sdk', version: '0.1.0' },
                spans: [{
                    traceId,
                    spanId,
                    name,
                    kind: 3, // CLIENT
                    startTimeUnixNano: String(start * 1_000_000),
                    endTimeUnixNano:   String(end   * 1_000_000),
                    attributes: kvAttrs,
                    status: { code: statusCode, message: statusMsg },
                }],
            }],
        }],
    };

    await fetch(_endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

export async function shutdownTracing(): Promise<void> {
    _initialized = false;
    _endpoint    = '';
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}