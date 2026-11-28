#!/usr/bin/env node
/**
 * CLI interface for Expo Push API sender, receipts and token pruning (#1275).
 * Runnable via `npm --prefix services/push-sender run cli -- <command>`
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExpoClient } from './expoClient.js';
import { redactText } from './redact.js';
import { JsonFilePushStore } from './store.js';
import type { ExpoPushMessage } from './types.js';

export interface CliParsedArgs {
  command?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  project?: string;
  tokens: string[];
  storePath: string;
  dryRun: boolean;
  once: boolean;
}

export function parseCliArgs(args: string[]): CliParsedArgs {
  const result: CliParsedArgs = {
    tokens: [],
    storePath: process.env['PUSH_STORE_PATH'] ?? './data/push-store.json',
    dryRun: false,
    once: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--once') {
      result.once = true;
    } else if (arg === '--title' && i + 1 < args.length) {
      result.title = args[++i];
    } else if (arg === '--body' && i + 1 < args.length) {
      result.body = args[++i];
    } else if (arg === '--project' && i + 1 < args.length) {
      result.project = args[++i];
    } else if (arg === '--store' && i + 1 < args.length) {
      result.storePath = args[++i];
    } else if (arg === '--data' && i + 1 < args.length) {
      const rawData = args[++i];
      try {
        result.data = JSON.parse(rawData);
      } catch {
        throw new Error(`Invalid JSON passed to --data: ${rawData}`);
      }
    } else if (arg === '--token' && i + 1 < args.length) {
      result.tokens.push(args[++i]);
    } else if (arg.startsWith('--token=')) {
      result.tokens.push(arg.slice('--token='.length));
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  result.command = positional[0];
  return result;
}

export async function runCli(
  args: string[],
  output: { log: (msg: string) => void; error: (msg: string) => void } = console,
): Promise<number> {
  try {
    const parsed = parseCliArgs(args);

    if (!parsed.command || (parsed.command !== 'send' && parsed.command !== 'poll-receipts')) {
      output.log('Usage: push-sender <command> [options]');
      output.log('');
      output.log('Commands:');
      output.log('  send           Send push notification(s) or run a dry-run preview');
      output.log('  poll-receipts  Poll due receipts and prune unregistered tokens');
      output.log('');
      output.log('Options for `send`:');
      output.log('  --title <text>           Notification title');
      output.log('  --body <text>            Notification body');
      output.log('  --data <json>            Custom data payload JSON');
      output.log('  --project <id>           Expo project ID');
      output.log('  --token <tok>            Target device push token (can repeat)');
      output.log('  --store <path>           Path to push store JSON file');
      output.log('  --dry-run                Validate and preview batches without network calls');
      output.log('');
      output.log('Options for `poll-receipts`:');
      output.log('  --store <path>           Path to push store JSON file');
      output.log('  --once                   Poll once and exit');
      return 1;
    }

    const store = new JsonFilePushStore(parsed.storePath);
    const client = new ExpoClient({
      store,
      expoAccessToken: process.env['EXPO_ACCESS_TOKEN'],
    });

    if (parsed.command === 'send') {
      if (!parsed.title && !parsed.body) {
        output.error('Error: Either --title or --body must be specified.');
        return 1;
      }

      let targetTokens = parsed.tokens;
      if (targetTokens.length === 0) {
        const stored = await store.listTokens(parsed.project);
        targetTokens = stored.map((t) => t.token);
      }

      if (targetTokens.length === 0) {
        output.error('Error: No target tokens provided via --token or found in push store.');
        return 1;
      }

      const messages: ExpoPushMessage[] = targetTokens.map((tok) => ({
        to: tok,
        title: parsed.title,
        body: parsed.body,
        data: parsed.data,
        projectId: parsed.project,
      }));

      const report = await client.sendNotifications(messages, { dryRun: parsed.dryRun });

      if ('dryRun' in report) {
        output.log('=== DRY-RUN PLAN ===');
        output.log(`Total messages : ${report.totalMessages}`);
        output.log(`Total devices  : ${report.totalDevices}`);
        output.log(`HTTP batches   : ${report.batches}`);
        output.log(`Project split  : ${JSON.stringify(report.projectBreakdown)}`);
        output.log(`Sample payload : ${JSON.stringify(report.samplePayload, null, 2)}`);
        output.log('Zero network calls were made. Zero tickets were written.');
        return 0;
      }

      output.log('=== SEND REPORT ===');
      output.log(`Messages sent       : ${report.totalMessages}`);
      output.log(`Tickets generated   : ${report.sentTickets}`);
      output.log(`Immediate errors    : ${report.immediateErrors}`);
      output.log(`Pruned tokens       : ${report.prunedTokens.length}`);
      output.log(`Batches processed   : ${report.batches}`);
      output.log(`Scheduled for retry : ${report.retriedMessages}`);

      return report.immediateErrors > 0 ? 1 : 0;
    }

    if (parsed.command === 'poll-receipts') {
      output.log('Polling due push receipts from Expo...');
      const report = await client.pollReceipts();

      output.log('=== RECEIPT POLL REPORT ===');
      output.log(`Due tickets polled     : ${report.polledTickets}`);
      output.log(`Tickets resolved       : ${report.resolvedTickets}`);
      output.log(`Tokens pruned          : ${report.prunedTokens.length}`);
      output.log(`Tickets rescheduled    : ${report.rescheduledTickets}`);
      output.log(`Expired tickets (24h)  : ${report.expiredTickets}`);
      output.log(`Pending tickets        : ${report.pendingTickets}`);
      output.log(`Delivery errors        : ${report.deliveryErrors.length}`);

      if (report.deliveryErrors.length > 0) {
        output.error('\nDelivery error diagnostics:');
        for (const err of report.deliveryErrors) {
          output.error(
            `  Ticket: ${err.ticketId} | Token: ${redactText(err.token)} | Error: ${err.error} | Message: ${err.message ?? 'none'}`,
          );
        }
        return 1;
      }

      return 0;
    }

    return 0;
  } catch (err) {
    output.error(`Error: ${redactText((err as Error).message)}`);
    return 1;
  }
}

// Direct CLI execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
