/**
 * Core type definitions for Expo Push API sender, receipts and store (#1275).
 */

export interface ExpoPushMessage {
  to: string | string[];
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null | string;
  badge?: number;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
  ttl?: number;
  projectId?: string;
  categoryId?: string;
  mutableContent?: boolean;
}

export type ExpoTicketStatus = 'ok' | 'error';

export interface ExpoTicketDetails {
  error?:
    | 'DeviceNotRegistered'
    | 'MessageTooBig'
    | 'MessageRateExceeded'
    | 'MismatchSenderId'
    | 'InvalidCredentials'
    | 'InvalidProviderToken'
    | string;
  [key: string]: unknown;
}

export interface ExpoPushTicket {
  status: ExpoTicketStatus;
  id?: string;
  message?: string;
  details?: ExpoTicketDetails;
}

export interface ExpoPushReceipt {
  status: ExpoTicketStatus;
  message?: string;
  details?: ExpoTicketDetails;
}

export interface ExpoPushSendResponse {
  data: ExpoPushTicket[];
  errors?: Array<{
    code: string;
    message: string;
    details?: unknown;
  }>;
}

export interface ExpoPushReceiptsResponse {
  data: Record<string, ExpoPushReceipt>;
  errors?: Array<{
    code: string;
    message: string;
    details?: unknown;
  }>;
}

export interface DeviceTokenRecord {
  token: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export type StoredTicketStatus = 'pending' | 'resolved' | 'expired';

export interface StoredPushTicket {
  ticketId: string;
  token: string;
  projectId?: string;
  sentAt: number; // Unix timestamp in ms
  readyAt: number; // Unix timestamp in ms (sentAt + 15 min)
  expiresAt: number; // Unix timestamp in ms (sentAt + 24 hours)
  attempts: number;
  status: StoredTicketStatus;
}

export interface DeliveryError {
  ticketId: string;
  token: string;
  error: string;
  message?: string;
}

export interface SendReport {
  totalMessages: number;
  sentTickets: number;
  immediateErrors: number;
  prunedTokens: string[];
  ticketIds: string[];
  batches: number;
  retriedMessages: number;
}

export interface ReceiptPollReport {
  polledTickets: number;
  resolvedTickets: number;
  pendingTickets: number;
  expiredTickets: number;
  prunedTokens: string[];
  rescheduledTickets: number;
  deliveryErrors: DeliveryError[];
}

export interface DryRunPlan {
  dryRun: true;
  totalMessages: number;
  totalDevices: number;
  projectBreakdown: Record<string, number>;
  batches: number;
  samplePayload: {
    title?: string;
    body?: string;
    dataPreview?: unknown;
    projectId?: string;
  };
}
