/**
 * Store abstraction and persistence implementations for tokens and tickets (#1275).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DeviceTokenRecord, StoredPushTicket } from './types.js';

export interface PushStore {
  // Token management
  listTokens(projectId?: string): Promise<DeviceTokenRecord[]>;
  upsertToken(
    record: Omit<DeviceTokenRecord, 'createdAt' | 'updatedAt'> &
      Partial<Pick<DeviceTokenRecord, 'createdAt' | 'updatedAt'>>,
  ): Promise<void>;
  deleteToken(token: string): Promise<boolean>;

  // Ticket management
  saveTickets(tickets: StoredPushTicket[]): Promise<void>;
  listDueTickets(nowMs: number, limit?: number): Promise<StoredPushTicket[]>;
  markTicketsResolved(ticketIds: string[]): Promise<void>;
  rescheduleTicket(ticketId: string, nextReadyAtMs: number, attempts: number): Promise<void>;
  expireTickets(nowMs: number): Promise<number>;
  listPendingTickets(): Promise<StoredPushTicket[]>;
  clear?(): Promise<void>;
}

/**
 * Fast, in-memory implementation of PushStore for testing and ephemeral use.
 */
export class InMemoryPushStore implements PushStore {
  private readonly tokens = new Map<string, DeviceTokenRecord>();
  private readonly tickets = new Map<string, StoredPushTicket>();

  async listTokens(projectId?: string): Promise<DeviceTokenRecord[]> {
    const all = Array.from(this.tokens.values());
    if (!projectId) return all;
    return all.filter((t) => t.projectId === projectId);
  }

  async upsertToken(
    record: Omit<DeviceTokenRecord, 'createdAt' | 'updatedAt'> &
      Partial<Pick<DeviceTokenRecord, 'createdAt' | 'updatedAt'>>,
  ): Promise<void> {
    const existing = this.tokens.get(record.token);
    const nowIso = new Date().toISOString();
    const updated: DeviceTokenRecord = {
      token: record.token,
      projectId: record.projectId ?? existing?.projectId,
      createdAt: existing?.createdAt ?? record.createdAt ?? nowIso,
      updatedAt: record.updatedAt ?? nowIso,
    };
    this.tokens.set(record.token, updated);
  }

  async deleteToken(token: string): Promise<boolean> {
    return this.tokens.delete(token);
  }

  async saveTickets(newTickets: StoredPushTicket[]): Promise<void> {
    for (const t of newTickets) {
      this.tickets.set(t.ticketId, { ...t });
    }
  }

  async listDueTickets(nowMs: number, limit?: number): Promise<StoredPushTicket[]> {
    const due: StoredPushTicket[] = [];
    for (const ticket of this.tickets.values()) {
      if (ticket.status === 'pending' && ticket.readyAt <= nowMs && ticket.expiresAt > nowMs) {
        due.push({ ...ticket });
        if (typeof limit === 'number' && due.length >= limit) break;
      }
    }
    return due;
  }

  async markTicketsResolved(ticketIds: string[]): Promise<void> {
    const idSet = new Set(ticketIds);
    for (const id of idSet) {
      const ticket = this.tickets.get(id);
      if (ticket) {
        ticket.status = 'resolved';
      }
    }
  }

  async rescheduleTicket(ticketId: string, nextReadyAtMs: number, attempts: number): Promise<void> {
    const ticket = this.tickets.get(ticketId);
    if (ticket && ticket.status === 'pending') {
      ticket.readyAt = nextReadyAtMs;
      ticket.attempts = attempts;
    }
  }

  async expireTickets(nowMs: number): Promise<number> {
    let expiredCount = 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.status === 'pending' && ticket.expiresAt <= nowMs) {
        ticket.status = 'expired';
        expiredCount++;
      }
    }
    return expiredCount;
  }

  async listPendingTickets(): Promise<StoredPushTicket[]> {
    return Array.from(this.tickets.values())
      .filter((t) => t.status === 'pending')
      .map((t) => ({ ...t }));
  }

  async clear(): Promise<void> {
    this.tokens.clear();
    this.tickets.clear();
  }
}

interface JsonFileSchema {
  version: 1;
  tokens: Record<string, DeviceTokenRecord>;
  tickets: Record<string, StoredPushTicket>;
}

/**
 * Atomic JSON-file backed store with temp-file + rename persistence.
 */
export class JsonFilePushStore implements PushStore {
  private readonly filePath: string;
  private readonly memStore: InMemoryPushStore;
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded: boolean = false;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.memStore = new InMemoryPushStore();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw) as Partial<JsonFileSchema>;
        if (data.tokens) {
          for (const token of Object.values(data.tokens)) {
            void this.memStore.upsertToken(token);
          }
        }
        if (data.tickets) {
          void this.memStore.saveTickets(Object.values(data.tickets));
        }
      } catch (err) {
        console.error(`[PushStore] Failed to read ${this.filePath}, initializing fresh store:`, err);
      }
    }
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const allTokens = await this.memStore.listTokens();
      const allTickets = await this.memStore.listPendingTickets();

      // Read back all tickets including resolved/expired
      const payload: JsonFileSchema = {
        version: 1,
        tokens: Object.fromEntries(allTokens.map((t) => [t.token, t])),
        tickets: Object.fromEntries(allTickets.map((t) => [t.ticketId, t])),
      };

      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tmpPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, this.filePath);
    });

    await this.writeQueue;
  }

  async listTokens(projectId?: string): Promise<DeviceTokenRecord[]> {
    this.ensureLoaded();
    return this.memStore.listTokens(projectId);
  }

  async upsertToken(
    record: Omit<DeviceTokenRecord, 'createdAt' | 'updatedAt'> &
      Partial<Pick<DeviceTokenRecord, 'createdAt' | 'updatedAt'>>,
  ): Promise<void> {
    this.ensureLoaded();
    await this.memStore.upsertToken(record);
    await this.persist();
  }

  async deleteToken(token: string): Promise<boolean> {
    this.ensureLoaded();
    const result = await this.memStore.deleteToken(token);
    if (result) {
      await this.persist();
    }
    return result;
  }

  async saveTickets(tickets: StoredPushTicket[]): Promise<void> {
    this.ensureLoaded();
    await this.memStore.saveTickets(tickets);
    await this.persist();
  }

  async listDueTickets(nowMs: number, limit?: number): Promise<StoredPushTicket[]> {
    this.ensureLoaded();
    return this.memStore.listDueTickets(nowMs, limit);
  }

  async markTicketsResolved(ticketIds: string[]): Promise<void> {
    this.ensureLoaded();
    await this.memStore.markTicketsResolved(ticketIds);
    await this.persist();
  }

  async rescheduleTicket(ticketId: string, nextReadyAtMs: number, attempts: number): Promise<void> {
    this.ensureLoaded();
    await this.memStore.rescheduleTicket(ticketId, nextReadyAtMs, attempts);
    await this.persist();
  }

  async expireTickets(nowMs: number): Promise<number> {
    this.ensureLoaded();
    const count = await this.memStore.expireTickets(nowMs);
    if (count > 0) {
      await this.persist();
    }
    return count;
  }

  async listPendingTickets(): Promise<StoredPushTicket[]> {
    this.ensureLoaded();
    return this.memStore.listPendingTickets();
  }

  async clear(): Promise<void> {
    this.ensureLoaded();
    await this.memStore.clear();
    await this.persist();
  }
}
