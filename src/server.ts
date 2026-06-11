// The webhook receiver (AIO-162) — the only thing we host.
//
// Event-driven: each Firecrawl `monitor.page` webhook with an actionable change
// (status==="changed" && judgment.meaningful===true) starts one Managed Agent
// session immediately. No queue, no scheduler. SIGNIFICANT records are posted to
// Slack by this process (the agent has no Slack tool — see docs/agent.md).
//
//   npm start          (Railway runs this; PORT is injected)
//
// Endpoints:
//   POST /webhooks/firecrawl — signed Firecrawl webhook in; 200 ACK immediately
//                              (Firecrawl requires 2xx within 10s), processing async
//   GET  /healthz            — liveness + sessions-in-flight
//
// Required env: ANTHROPIC_API_KEY, AGENT_ID, ENVIRONMENT_ID, MEMORY_STORE_ID,
//               FIRECRAWL_WEBHOOK_SECRET, SLACK_BOT_TOKEN, SLACK_CHANNEL
// Optional env: PORT (default 3000), MAX_CONCURRENT_SESSIONS (default 3)

import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { actionableInputs } from './agent/input-contract';
import { postBriefToSlack } from './agent/slack';
import { runChanges } from './agent/run-session';
import type { AgentChangeInput, MonitorPagePayload } from './agent/types';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const WEBHOOK_SECRET = requireEnv('FIRECRAWL_WEBHOOK_SECRET');
const SLACK_TOKEN = requireEnv('SLACK_BOT_TOKEN');
const SLACK_CHANNEL = requireEnv('SLACK_CHANNEL');
// Fail fast at boot on missing agent env (runChanges would throw later otherwise).
for (const name of ['ANTHROPIC_API_KEY', 'AGENT_ID', 'ENVIRONMENT_ID', 'MEMORY_STORE_ID']) {
  requireEnv(name);
}
const PORT = Number(process.env.PORT) || 3000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_SESSIONS) || 3;

const startedAt = Date.now();

// Counters surfaced on /healthz (also what the replay test asserts against).
const stats = {
  receivedWebhooks: 0,
  rejectedSignature: 0,
  duplicateWebhooks: 0,
  sessionsStarted: 0,
};

// ── webhookId dedupe (in-memory; Firecrawl retries are minutes apart). The agent's
// Memory Store dedup is the durable backstop, so restart amnesia is acceptable. ──
const seenWebhookIds = new Set<string>();
const SEEN_CAP = 5000;
function seenBefore(id: string | undefined): boolean {
  if (!id) return false;
  if (seenWebhookIds.has(id)) return true;
  seenWebhookIds.add(id);
  if (seenWebhookIds.size > SEEN_CAP) {
    // Drop the oldest half (Sets iterate in insertion order).
    let i = 0;
    for (const v of seenWebhookIds) {
      seenWebhookIds.delete(v);
      if (++i >= SEEN_CAP / 2) break;
    }
  }
  return false;
}

// ── tiny in-process FIFO with a concurrency cap (bounds session cost) ─────────
let sessionsRunning = 0;
const pending: Array<() => Promise<void>> = [];
function enqueue(job: () => Promise<void>): void {
  pending.push(job);
  drain();
}
function drain(): void {
  while (sessionsRunning < MAX_CONCURRENT && pending.length > 0) {
    const job = pending.shift()!;
    sessionsRunning++;
    job()
      .catch((err) => console.error('✖ job failed:', err))
      .finally(() => {
        sessionsRunning--;
        drain();
      });
  }
}

/** Verify `X-Firecrawl-Signature: sha256=<hex>` = HMAC-SHA256(raw body, secret). */
export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const match = header.match(/^sha256=([0-9a-f]+)$/i);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = match[1]!.toLowerCase();
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

/** The §4 flow for one webhook's actionable changes — runs in the background. */
async function processChanges(changes: AgentChangeInput[], webhookId: string): Promise<void> {
  const tag = `[${webhookId.slice(0, 8)}]`;
  const log = (line: string) => console.log(`${tag} ${line}`);
  try {
    const { records, sessionId } = await runChanges(changes, { log });
    if (!records.length) {
      log(`✖ session ${sessionId} returned no parseable records`);
      return;
    }
    for (const record of records) {
      if (record.classification !== 'SIGNIFICANT') {
        log(`${record.competitor}: ${record.classification} → no alert`);
        continue;
      }
      const result = await postBriefToSlack(record, { token: SLACK_TOKEN, channel: SLACK_CHANNEL });
      log(
        result.ok
          ? `${record.competitor}: SIGNIFICANT → posted to Slack (ts=${result.ts})`
          : `✖ ${record.competitor}: SIGNIFICANT but Slack post failed: ${result.error}`,
      );
    }
  } catch (err) {
    // No retry: if the change persists, the next daily check re-detects it.
    console.error(`${tag} ✖ session failed:`, err);
  }
}

function readBody(req: IncomingMessage, limitBytes = 5 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      respond(res, 200, {
        ok: true,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        sessionsRunning,
        pending: pending.length,
        ...stats,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/webhooks/firecrawl') {
      const rawBody = await readBody(req);
      stats.receivedWebhooks++;
      const signature = req.headers['x-firecrawl-signature'];
      if (!verifySignature(rawBody, typeof signature === 'string' ? signature : undefined, WEBHOOK_SECRET)) {
        stats.rejectedSignature++;
        console.log('✖ rejected webhook: bad or missing X-Firecrawl-Signature');
        respond(res, 401, { ok: false, error: 'invalid signature' });
        return;
      }

      let payload: MonitorPagePayload;
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as MonitorPagePayload;
      } catch {
        respond(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }

      // ACK inside Firecrawl's 10-second window; everything below is async.
      respond(res, 200, { ok: true });

      const webhookId = payload.webhookId ?? 'unknown';
      if (payload.type !== 'monitor.page') {
        console.log(`[${webhookId.slice(0, 8)}] ${payload.type} — logged, no action`);
        return;
      }
      if (seenBefore(payload.webhookId)) {
        stats.duplicateWebhooks++;
        console.log(`[${webhookId.slice(0, 8)}] duplicate webhookId — skipped`);
        return;
      }

      const statuses = (payload.data ?? [])
        .map((e) => `${e.status}${e.judgment ? (e.judgment.meaningful ? '/MEANINGFUL' : '/not-meaningful') : ''}`)
        .join(', ');
      const changes = actionableInputs(payload);
      console.log(
        `[${webhookId.slice(0, 8)}] monitor.page competitor=${payload.metadata?.competitor} ` +
          `pages=[${statuses}] actionable=${changes.length}`,
      );
      if (changes.length > 0) {
        stats.sessionsStarted++;
        enqueue(() => processChanges(changes, webhookId));
      }
      return;
    }

    respond(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.error('✖ request error:', err);
    if (!res.headersSent) respond(res, 500, { ok: false, error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(
    `comp-intel receiver listening on :${PORT} ` +
      `(max ${MAX_CONCURRENT} concurrent sessions; Slack → ${SLACK_CHANNEL})`,
  );
});
