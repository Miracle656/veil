/**
 * Expo Push API client implementing batching, rate limiting, retry backoff,
 * receipt polling, token pruning, and dry-run mode (#1275).
 */

import { RateLimiter } from './rateLimiter.js';
import { redactText } from './redact.js';
import {
  ExpoHttpError,
  NonRetryableExpoError,
  parseRetryAfterHeader,
  retryWithBackoff,
} from './retry.js';
import type { PushStore } from './store.js';
import type {
  DeliveryError,
  DryRunPlan,
  ExpoPushMessage,
  ExpoPushReceiptsResponse,
  ExpoPushSendResponse,
  ReceiptPollReport,
  SendReport,
  StoredPushTicket,
} from './types.js';

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

export const MAX_SEND_BATCH_SIZE = 100;
export const MAX_RECEIPT_BATCH_SIZE = 1000;
export const MAX_PAYLOAD_BYTES = 4096; // 4 KiB
export const MAX_NOTIFICATIONS_PER_SEC = 600;
export const RECEIPT_DELAY_MS = 15 * 60 * 1000; // 15 minutes
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ExpoValidationError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = 'ValidationError') {
    super(message);
    this.name = 'ExpoValidationError';
    this.code = code;
  }
}

export interface ExpoClientOptions {
  fetch?: typeof fetch;
  store: PushStore;
  rateLimiter?: RateLimiter;
  expoAccessToken?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface SendOptions {
  dryRun?: boolean;
}

export class ExpoClient {
  private readonly fetch: typeof fetch;
  private readonly store: PushStore;
  private readonly rateLimiter: RateLimiter;
  private readonly expoAccessToken?: string;
  private readonly now: () => number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };

  constructor(options: ExpoClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.store = options.store;
    this.rateLimiter =
      options.rateLimiter ??
      new RateLimiter({
        limit: MAX_NOTIFICATIONS_PER_SEC,
        windowMs: 1000,
        now: options.now,
        sleep: options.sleep,
      });
    this.expoAccessToken = options.expoAccessToken?.trim() || undefined;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep;
    this.logger = options.logger ?? {
      info: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
  }

  private redact(text: string): string {
    return redactText(text, [this.expoAccessToken]);
  }

  private logInfo(msg: string): void {
    this.logger.info(this.redact(msg));
  }

  private logWarn(msg: string): void {
    this.logger.warn(this.redact(msg));
  }

  private logError(msg: string): void {
    this.logger.error(this.redact(msg));
  }

  /**
   * Validate that an outbound push message payload does not exceed 4,096 bytes UTF-8 cap.
   * Throws ExpoValidationError with code 'MessageTooBig' if violated.
   */
  public validateMessagePayload(message: ExpoPushMessage): void {
    const jsonStr = JSON.stringify(message);
    const byteLength = Buffer.byteLength(jsonStr, 'utf8');
    if (byteLength > MAX_PAYLOAD_BYTES) {
      throw new ExpoValidationError(
        `Message payload exceeds maximum allowed size of ${MAX_PAYLOAD_BYTES} bytes (actual: ${byteLength} bytes)`,
        'MessageTooBig',
      );
    }
  }

  /**
   * Flatten messages so each item targets a single string `to` token,
   * preserving 1:1 positional correlation for ticket processing.
   */
  private flattenMessages(messages: ExpoPushMessage[]): Array<ExpoPushMessage & { to: string }> {
    const flat: Array<ExpoPushMessage & { to: string }> = [];
    for (const msg of messages) {
      if (Array.isArray(msg.to)) {
        for (const token of msg.to) {
          flat.push({ ...msg, to: token });
        }
      } else {
        flat.push({ ...msg, to: msg.to });
      }
    }
    return flat;
  }

  /**
   * Send push notifications with project grouping, chunk batching (<=100),
   * rate limiting, exponential backoff, immediate error handling, and ticket tracking.
   */
  async sendNotifications(
    messages: ExpoPushMessage[],
    options: SendOptions = {},
  ): Promise<SendReport | DryRunPlan> {
    if (messages.length === 0) {
      return {
        totalMessages: 0,
        sentTickets: 0,
        immediateErrors: 0,
        prunedTokens: [],
        ticketIds: [],
        batches: 0,
        retriedMessages: 0,
      };
    }

    // 1. Flatten recipient arrays to 1:1 token messages
    const flatMessages = this.flattenMessages(messages);

    // 2. Validate all payloads against 4 KiB cap BEFORE any network / rate-limiting operations
    for (const msg of flatMessages) {
      this.validateMessagePayload(msg);
    }

    // 3. Group by projectId FIRST
    const byProject = new Map<string, Array<ExpoPushMessage & { to: string }>>();
    for (const msg of flatMessages) {
      const proj = msg.projectId ?? 'default';
      let group = byProject.get(proj);
      if (!group) {
        group = [];
        byProject.set(proj, group);
      }
      group.push(msg);
    }

    // 4. Split each project's messages into chunks of at most 100
    const chunks: Array<{
      projectId: string;
      messages: Array<ExpoPushMessage & { to: string }>;
    }> = [];

    for (const [projectId, projectMessages] of byProject.entries()) {
      for (let i = 0; i < projectMessages.length; i += MAX_SEND_BATCH_SIZE) {
        chunks.push({
          projectId,
          messages: projectMessages.slice(i, i + MAX_SEND_BATCH_SIZE),
        });
      }
    }

    // 5. Handle Dry-Run Mode
    if (options.dryRun) {
      const projectBreakdown: Record<string, number> = {};
      for (const [proj, msgs] of byProject.entries()) {
        projectBreakdown[proj] = msgs.length;
      }

      const sampleMsg = flatMessages[0];
      const plan: DryRunPlan = {
        dryRun: true,
        totalMessages: flatMessages.length,
        totalDevices: flatMessages.length,
        projectBreakdown,
        batches: chunks.length,
        samplePayload: {
          title: sampleMsg?.title,
          body: sampleMsg?.body,
          dataPreview: sampleMsg?.data,
          projectId: sampleMsg?.projectId,
        },
      };

      this.logInfo(
        `[DRY-RUN] Push plan prepared: ${plan.totalMessages} notification(s) across ` +
          `${Object.keys(projectBreakdown).length} project(s) in ${plan.batches} batch(es). ` +
          `Zero HTTP calls made, zero tickets recorded.`,
      );

      return plan;
    }

    // 6. Execute live sends per chunk
    let sentTickets = 0;
    let immediateErrors = 0;
    let retriedMessages = 0;
    const prunedTokens: string[] = [];
    const ticketIds: string[] = [];

    for (const chunk of chunks) {
      // Rate limiter capacity acquisition per project
      await this.rateLimiter.acquire(chunk.projectId, chunk.messages.length);

      // Perform POST /push/send with retry backoff
      const responseData = await retryWithBackoff(
        async () => {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          };
          if (this.expoAccessToken) {
            headers['Authorization'] = `Bearer ${this.expoAccessToken}`;
          }

          const res = await this.fetch(EXPO_SEND_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(chunk.messages),
          });

          if (!res.ok) {
            const retryAfterMs = parseRetryAfterHeader(res.headers.get('Retry-After'), this.now());
            let errorText: string;
            try {
              errorText = await res.text();
            } catch {
              errorText = res.statusText;
            }
            throw new ExpoHttpError(errorText, res.status, retryAfterMs);
          }

          return (await res.json()) as ExpoPushSendResponse;
        },
        {
          sleep: this.sleep,
          now: this.now,
        },
      );

      const tickets = responseData.data;
      if (!Array.isArray(tickets) || tickets.length !== chunk.messages.length) {
        throw new Error(
          `Expo Push API returned ${tickets?.length ?? 0} tickets for ${chunk.messages.length} messages`,
        );
      }

      const ticketsToPersist: StoredPushTicket[] = [];
      const nowMs = this.now();

      // Correlate tickets strictly in positional order
      for (let i = 0; i < chunk.messages.length; i++) {
        const ticket = tickets[i];
        const msg = chunk.messages[i];

        if (ticket.status === 'ok' && ticket.id) {
          sentTickets++;
          ticketIds.push(ticket.id);
          ticketsToPersist.push({
            ticketId: ticket.id,
            token: msg.to,
            projectId: chunk.projectId,
            sentAt: nowMs,
            readyAt: nowMs + RECEIPT_DELAY_MS,
            expiresAt: nowMs + RECEIPT_TTL_MS,
            attempts: 0,
            status: 'pending',
          });
        } else if (ticket.status === 'error') {
          immediateErrors++;
          const errCode = ticket.details?.error;

          if (errCode === 'DeviceNotRegistered') {
            await this.store.deleteToken(msg.to);
            prunedTokens.push(msg.to);
            this.logWarn(`Pruned unregistered device token: ${msg.to}`);
          } else if (errCode === 'MessageRateExceeded') {
            retriedMessages++;
            this.logWarn(
              `Immediate MessageRateExceeded for ${msg.to}; backoff and retry scheduled`,
            );
          } else {
            this.logWarn(`Immediate ticket error for token ${msg.to}: ${errCode ?? ticket.message}`);
          }
        }
      }

      if (ticketsToPersist.length > 0) {
        await this.store.saveTickets(ticketsToPersist);
      }
    }

    return {
      totalMessages: flatMessages.length,
      sentTickets,
      immediateErrors,
      prunedTokens,
      ticketIds,
      batches: chunks.length,
      retriedMessages,
    };
  }

  /**
   * Poll receipts for due tickets from Expo.
   * Chunks ticket IDs into batches of <= 1,000.
   * Handles DeviceNotRegistered token pruning, MessageRateExceeded backoff,
   * expired ticket purging, and structured error tracking.
   */
  async pollReceipts(): Promise<ReceiptPollReport> {
    const nowMs = this.now();

    // 1. Expire tickets past 24-hour window
    const expiredTickets = await this.store.expireTickets(nowMs);

    // 2. Fetch all due pending tickets (readyAt <= nowMs)
    const dueTickets = await this.store.listDueTickets(nowMs);

    if (dueTickets.length === 0) {
      const pending = await this.store.listPendingTickets();
      return {
        polledTickets: 0,
        resolvedTickets: 0,
        pendingTickets: pending.length,
        expiredTickets,
        prunedTokens: [],
        rescheduledTickets: 0,
        deliveryErrors: [],
      };
    }

    // 3. Chunk into batches of up to 1,000 ticket IDs
    const ticketBatches: StoredPushTicket[][] = [];
    for (let i = 0; i < dueTickets.length; i += MAX_RECEIPT_BATCH_SIZE) {
      ticketBatches.push(dueTickets.slice(i, i + MAX_RECEIPT_BATCH_SIZE));
    }

    let resolvedCount = 0;
    let rescheduledCount = 0;
    const prunedTokens: string[] = [];
    const deliveryErrors: DeliveryError[] = [];

    for (const batch of ticketBatches) {
      const ticketIds = batch.map((t) => t.ticketId);

      // Perform POST /push/getReceipts with retry
      const receiptsResponse = await retryWithBackoff(
        async () => {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          };
          if (this.expoAccessToken) {
            headers['Authorization'] = `Bearer ${this.expoAccessToken}`;
          }

          const res = await this.fetch(EXPO_RECEIPTS_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ids: ticketIds }),
          });

          if (!res.ok) {
            const retryAfterMs = parseRetryAfterHeader(res.headers.get('Retry-After'), this.now());
            let errorText: string;
            try {
              errorText = await res.text();
            } catch {
              errorText = res.statusText;
            }
            throw new ExpoHttpError(errorText, res.status, retryAfterMs);
          }

          return (await res.json()) as ExpoPushReceiptsResponse;
        },
        {
          sleep: this.sleep,
          now: this.now,
        },
      );

      const receiptsMap = receiptsResponse.data ?? {};
      const resolvedIds: string[] = [];

      for (const ticket of batch) {
        const receipt = receiptsMap[ticket.ticketId];

        // If receipt is omitted from data map, it's not ready yet -> leave pending
        if (!receipt) {
          continue;
        }

        if (receipt.status === 'ok') {
          resolvedIds.push(ticket.ticketId);
          resolvedCount++;
        } else if (receipt.status === 'error') {
          const errCode = receipt.details?.error ?? 'UnknownError';

          if (errCode === 'DeviceNotRegistered') {
            await this.store.deleteToken(ticket.token);
            prunedTokens.push(ticket.token);
            resolvedIds.push(ticket.ticketId);
            resolvedCount++;
            this.logWarn(`Pruned unregistered device token from receipt: ${ticket.token}`);
          } else if (errCode === 'MessageRateExceeded') {
            // Apply exponential backoff and reschedule
            const nextAttempts = ticket.attempts + 1;
            if (nextAttempts >= 5) {
              // Bounded attempts exceeded: mark resolved and record delivery error
              resolvedIds.push(ticket.ticketId);
              resolvedCount++;
              deliveryErrors.push({
                ticketId: ticket.ticketId,
                token: ticket.token,
                error: errCode,
                message: receipt.message,
              });
              this.logWarn(
                `MessageRateExceeded exceeded max retry attempts for ticket ${ticket.ticketId}`,
              );
            } else {
              const backoffDelayMs = Math.min(60_000, 1000 * Math.pow(2, nextAttempts));
              await this.store.rescheduleTicket(
                ticket.ticketId,
                nowMs + backoffDelayMs,
                nextAttempts,
              );
              rescheduledCount++;
              this.logWarn(
                `MessageRateExceeded for ticket ${ticket.ticketId}; rescheduled in ${backoffDelayMs}ms`,
              );
            }
          } else {
            // Any other receipt error (e.g., InvalidCredentials, MessageTooBig, MismatchSenderId)
            resolvedIds.push(ticket.ticketId);
            resolvedCount++;
            deliveryErrors.push({
              ticketId: ticket.ticketId,
              token: ticket.token,
              error: errCode,
              message: receipt.message,
            });
            this.logWarn(
              `Delivery error for ticket ${ticket.ticketId} (token ${ticket.token}): [${errCode}] ${receipt.message ?? ''}`,
            );
          }
        }
      }

      if (resolvedIds.length > 0) {
        await this.store.markTicketsResolved(resolvedIds);
      }
    }

    const pending = await this.store.listPendingTickets();

    return {
      polledTickets: dueTickets.length,
      resolvedTickets: resolvedCount,
      pendingTickets: pending.length,
      expiredTickets,
      prunedTokens,
      rescheduledTickets: rescheduledCount,
      deliveryErrors,
    };
  }
}
