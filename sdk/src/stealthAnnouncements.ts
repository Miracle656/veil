import { nativeToScVal, rpc, scValToNative } from '@stellar/stellar-sdk';

export const STEALTH_ANNOUNCEMENT_VERSION = 1;

const ANNOUNCEMENT_TOPIC = 'announce';
const PAGE_LIMIT = 100;

export interface StealthAnnouncement {
  id: string;
  ledger: number;
  txHash: string;
  version: 1;
  ephemeralPublicKey: Uint8Array;
  viewTag: number;
  sealedNote: Uint8Array;
}

export interface ReadStealthAnnouncementsOptions {
  rpcUrl: string;
  contractId: string;
  startLedger: number;
  viewTag: number;
}

function parseAnnouncement(
  event: rpc.Api.EventResponse,
  expectedViewTag: number,
): StealthAnnouncement {
  if (event.topic.length !== 2) {
    throw new Error('Invalid stealth announcement topics');
  }

  const topicName = scValToNative(event.topic[0]);
  const topicViewTag = scValToNative(event.topic[1]);
  if (topicName !== ANNOUNCEMENT_TOPIC ||
    !(topicViewTag instanceof Uint8Array) ||
    topicViewTag.length !== 1 ||
    topicViewTag[0] !== expectedViewTag) {
    throw new Error('Invalid stealth announcement topics');
  }

  const data = scValToNative(event.value) as unknown;
  if (!Array.isArray(data) || data.length !== 3) {
    throw new Error('Invalid stealth announcement payload');
  }
  const [version, ephemeralPublicKey, sealedNote] = data;
  if (version !== STEALTH_ANNOUNCEMENT_VERSION) {
    throw new Error(`Unsupported stealth announcement version: ${String(version)}`);
  }
  if (
    !(ephemeralPublicKey instanceof Uint8Array) ||
    ephemeralPublicKey.length !== 32 ||
    !(sealedNote instanceof Uint8Array)
  ) {
    throw new Error('Invalid stealth announcement bytes');
  }

  return {
    id: event.id,
    ledger: event.ledger,
    txHash: event.txHash,
    version: STEALTH_ANNOUNCEMENT_VERSION,
    ephemeralPublicKey,
    viewTag: expectedViewTag,
    sealedNote,
  };
}

/**
 * Reads versioned announcements matching a receiver's one-byte view tag.
 * The RPC node retains only a bounded event history; `startLedger` must be
 * inside that node's current retention window.
 */
export async function readStealthAnnouncements(
  options: ReadStealthAnnouncementsOptions,
): Promise<StealthAnnouncement[]> {
  const { rpcUrl, contractId, startLedger, viewTag } = options;
  if (!Number.isSafeInteger(startLedger) || startLedger < 1) {
    throw new RangeError('startLedger must be a positive safe integer');
  }
  if (!Number.isInteger(viewTag) || viewTag < 0 || viewTag > 255) {
    throw new RangeError('viewTag must be an integer from 0 to 255');
  }

  const server = new rpc.Server(rpcUrl);
  const topics = [
    nativeToScVal(ANNOUNCEMENT_TOPIC, { type: 'symbol' }).toXDR('base64'),
    nativeToScVal(Uint8Array.of(viewTag), { type: 'bytes' }).toXDR('base64'),
  ];
  const filters = [{ type: 'contract' as const, contractIds: [contractId], topics: [topics] }];
  const announcements: StealthAnnouncement[] = [];

  let response = await server.getEvents({ filters, startLedger, limit: PAGE_LIMIT });
  while (true) {
    announcements.push(...response.events.map((event) => parseAnnouncement(event, viewTag)));
    if (!response.cursor) break;

    const cursor = response.cursor;
    response = await server.getEvents({ filters, cursor, limit: PAGE_LIMIT });
    if (response.cursor === cursor) break;
  }

  return announcements;
}
