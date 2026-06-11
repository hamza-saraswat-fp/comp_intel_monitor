// LIVE end-to-end test harness: real Firecrawl checks → real webhook payloads →
// real agent session → Slack post for SIGNIFICANT items.
//
// ⚠️ SUPERSEDED by the deployed receiver (src/server.ts, AIO-162). This script polls
// the webhook.site sink, which stops receiving once the monitors are repointed at
// the receiver. Kept for ad-hoc testing if the monitors are ever pointed back at a
// sink. Note: manually-triggered checks (runMonitor) proved slow/queued on Firecrawl's
// side (>10 min observed 2026-06-11); the scheduled daily checks deliver reliably.
//
//   npm run live-run               # full pipeline, posts SIGNIFICANT to Slack
//   npm run live-run -- --no-slack # print briefs instead of posting
//
// Required env: FIRECRAWL_API_KEY, WEBHOOK_SITE_URL, ANTHROPIC_API_KEY, AGENT_ID,
//               ENVIRONMENT_ID, MEMORY_STORE_ID (+ SLACK_BOT_TOKEN/SLACK_CHANNEL unless --no-slack)

import 'dotenv/config';
import Firecrawl from '@mendable/firecrawl-js';
import { MONITOR_NAME_PREFIX } from '../monitors/pilot';
import { actionableInputs } from '../agent/input-contract';
import { briefText } from '../agent/brief';
import { postBriefToSlack } from '../agent/slack';
import { runChanges } from '../agent/run-session';
import type { MonitorPagePayload } from '../agent/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function withRateLimitRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const is429 = err?.status === 429 || /rate limit/i.test(`${err?.message ?? ''}`);
      if (!is429 || attempt >= maxAttempts) throw err;
      const match = `${err?.message ?? ''}`.match(/retry after (\d+)\s*s/i);
      const waitSec = (match ? parseInt(match[1], 10) : 60) + 3;
      console.log(`  … ${label}: rate-limited, waiting ${waitSec}s`);
      await sleep(waitSec * 1000);
    }
  }
}

function toMonitorArray(result: any): Array<{ id?: string; name?: string }> {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.monitors)) return result.monitors;
  return [];
}

interface WebhookSiteRequest {
  uuid: string;
  content: string;
  created_at: string;
}

/** Fetch requests that arrived at the webhook.site sink since `sinceMs`. */
async function fetchSinkRequests(token: string, sinceMs: number): Promise<MonitorPagePayload[]> {
  const res = await fetch(
    `https://webhook.site/token/${token}/requests?sorting=newest&per_page=100`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`webhook.site fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: WebhookSiteRequest[] };
  const out: MonitorPagePayload[] = [];
  for (const req of body.data ?? []) {
    // webhook.site timestamps are UTC "YYYY-MM-DD HH:mm:ss"
    const createdMs = Date.parse(`${req.created_at.replace(' ', 'T')}Z`);
    if (Number.isNaN(createdMs) || createdMs < sinceMs) continue;
    try {
      out.push(JSON.parse(req.content) as MonitorPagePayload);
    } catch {
      // non-JSON request on the sink — ignore
    }
  }
  return out;
}

async function main(): Promise<void> {
  const noSlack = process.argv.includes('--no-slack');
  const firecrawlKey = requireEnv('FIRECRAWL_API_KEY');
  const sinkUrl = requireEnv('WEBHOOK_SITE_URL');
  requireEnv('ANTHROPIC_API_KEY');
  const slackToken = noSlack ? '' : requireEnv('SLACK_BOT_TOKEN');
  const slackChannel = noSlack ? '' : requireEnv('SLACK_CHANNEL');
  if (noSlack) console.log('— Slack posting DISABLED (--no-slack): briefs print to the terminal —\n');

  const sinkToken = sinkUrl.match(/webhook\.site\/([0-9a-f-]{36})/i)?.[1];
  if (!sinkToken) {
    console.error(`✖ Could not extract webhook.site token from WEBHOOK_SITE_URL=${sinkUrl}`);
    process.exit(1);
  }

  // ── 1. Trigger real checks ────────────────────────────────────────────────
  const firecrawl = new Firecrawl({ apiKey: firecrawlKey });
  const monitors = toMonitorArray(
    await withRateLimitRetry('listMonitors', () => firecrawl.listMonitors()),
  ).filter((m) => m.name?.startsWith(MONITOR_NAME_PREFIX) && m.id);

  if (!monitors.length) {
    console.error('✖ No comp-intel/* monitors found on Firecrawl.');
    process.exit(1);
  }

  const startedAtMs = Date.now() - 60_000; // 60s skew allowance
  console.log(`Triggering immediate checks on ${monitors.length} monitor(s):`);
  for (const m of monitors) {
    await withRateLimitRetry(`runMonitor ${m.name}`, () => firecrawl.runMonitor(m.id!));
    console.log(`  ▶ ${m.name}`);
  }

  // ── 2. Wait for the webhooks to land on the sink ──────────────────────────
  console.log('\nWaiting for checks to complete (scrapes + judge take a few minutes)…');
  const deadline = Date.now() + 10 * 60_000;
  let payloads: MonitorPagePayload[] = [];
  while (Date.now() < deadline) {
    await sleep(30_000);
    payloads = await fetchSinkRequests(sinkToken, startedAtMs);
    const completed = payloads.filter((p) => p.type === 'monitor.check.completed').length;
    const pages = payloads.filter((p) => p.type === 'monitor.page').length;
    process.stdout.write(`  sink: ${pages} monitor.page, ${completed}/${monitors.length} check.completed\r`);
    if (completed >= monitors.length) break;
  }
  console.log('\n');

  const pagePayloads = payloads.filter((p) => p.type === 'monitor.page');
  if (!pagePayloads.length) {
    console.log('✖ No monitor.page payloads arrived before the timeout — check the Firecrawl dashboard.');
    process.exit(1);
  }

  // ── 3. The act-on filter on REAL data ─────────────────────────────────────
  console.log('Real page results:');
  for (const p of pagePayloads) {
    for (const entry of p.data ?? []) {
      const judge = entry.judgment
        ? ` judge=${entry.judgment.meaningful ? 'MEANINGFUL' : 'not-meaningful'} (${entry.judgment.confidence})`
        : '';
      console.log(`  • [${p.metadata?.competitor}] ${entry.status}${judge} ${entry.url}`);
    }
  }

  const changes = pagePayloads.flatMap((p) => actionableInputs(p));
  console.log(`\nActionable after the act-on filter: ${changes.length}`);
  if (!changes.length) {
    console.log(
      '\nLive result: no meaningful AI changes detected in this check — the judge filtered ' +
        'everything as noise. No agent session, no alert. This is the correct behavior; ' +
        'an alert fires only when a competitor actually ships something.',
    );
    return;
  }

  // ── 4. The real agent session ─────────────────────────────────────────────
  console.log('');
  const { records } = await runChanges(changes);
  console.log('\n✓ session complete.');

  // ── 5. Post SIGNIFICANT records to Slack ──────────────────────────────────
  if (!records.length) {
    console.log('\n✖ Could not parse the per-item record JSON from the agent reply — nothing posted.');
    return;
  }
  console.log(`\nRecords: ${records.map((r) => `${r.competitor}=${r.classification}`).join(', ')}`);
  for (const record of records) {
    if (record.classification !== 'SIGNIFICANT') {
      console.log(`  — ${record.competitor}: ${record.classification} → no alert (correct)`);
      continue;
    }
    if (noSlack) {
      console.log(`  ✓ SIGNIFICANT → would post to Slack (--no-slack):\n    ${briefText(record)}`);
      continue;
    }
    const result = await postBriefToSlack(record, { token: slackToken, channel: slackChannel });
    console.log(
      result.ok
        ? `  ✓ SIGNIFICANT → posted to Slack (ts=${result.ts})`
        : `  ✖ Slack post failed: ${result.error}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
