// LIVE end-to-end test: real Firecrawl checks → real webhook payloads → real agent
// session → Slack post for SIGNIFICANT items.
//
//   npm run live-run
//
// What it does, in order:
//   1. Triggers an immediate check on every comp-intel/* Firecrawl monitor.
//   2. Polls webhook.site (our current webhook sink) until the checks complete.
//   3. Applies the act-on filter to the REAL monitor.page payloads that arrived.
//   4. If anything is actionable: runs the Managed Agent session on it (verify →
//      classify → Memory dedup), then posts every SIGNIFICANT record to Slack.
//   5. If nothing is actionable: says so — that's the judge correctly filtering noise.
//
// This is Bundle 2's receiver flow, run by hand. The receiver (AIO-162) automates
// exactly this when a webhook arrives.
//
// Required env: FIRECRAWL_API_KEY, WEBHOOK_SITE_URL, ANTHROPIC_API_KEY, AGENT_ID,
//               ENVIRONMENT_ID, MEMORY_STORE_ID, SLACK_BOT_TOKEN, SLACK_CHANNEL

import 'dotenv/config';
import Firecrawl from '@mendable/firecrawl-js';
import Anthropic from '@anthropic-ai/sdk';
import { MONITOR_NAME_PREFIX } from '../monitors/pilot';
import { actionableInputs } from '../agent/input-contract';
import { briefText } from '../agent/brief';
import { postBriefToSlack } from '../agent/slack';
import type { AgentChangeInput, FeatureRecord, MonitorPagePayload } from '../agent/types';

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

function userText(changes: AgentChangeInput[]): string {
  return [
    'Process the following REAL competitor page change(s) exactly per your instructions:',
    'web-verify → classify (SIGNIFICANT/MINOR/UNCLEAR) → check Memory → for SIGNIFICANT',
    'and genuinely new items, append to Memory.',
    '',
    'Your Slack tool is unavailable in this run — the runner posts for you. Instead,',
    'END your reply with a fenced ```json code block containing an ARRAY of the',
    'per-item records (the schema from your instructions) for ALL changes processed.',
    '',
    '```json',
    JSON.stringify(changes, null, 2),
    '```',
  ].join('\n');
}

function messageText(event: unknown): string {
  const e = event as { message?: { content?: unknown }; content?: unknown };
  const content = e.message?.content ?? e.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

/** Pull the last fenced ```json block out of the agent's final message. */
function parseRecords(text: string): FeatureRecord[] {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return [];
  try {
    const parsed = JSON.parse(blocks[blocks.length - 1]!.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const noSlack = process.argv.includes('--no-slack');
  const firecrawlKey = requireEnv('FIRECRAWL_API_KEY');
  const sinkUrl = requireEnv('WEBHOOK_SITE_URL');
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const agentId = requireEnv('AGENT_ID');
  const environmentId = requireEnv('ENVIRONMENT_ID');
  const memoryStoreId = requireEnv('MEMORY_STORE_ID');
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
  const client = new Anthropic({ apiKey });
  const session = await client.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    resources: [
      {
        type: 'memory_store',
        memory_store_id: memoryStoreId,
        access: 'read_write',
        instructions:
          'Per-competitor known-AI-feature records at /competitors/<slug>.md. Read the ' +
          'matching file before alerting; append after alerting on a genuinely new feature.',
      },
    ],
  });
  console.log(`\nSession ${session.id} created. Streaming…\n`);

  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: userText(changes) }] }],
  });

  let finalText = '';
  for await (const event of stream) {
    switch (event.type) {
      case 'agent.message': {
        const text = messageText(event).trim();
        if (text) {
          finalText = text;
          console.log(`\n🧠 agent: ${text}\n`);
        }
        break;
      }
      case 'agent.thinking':
        process.stdout.write('·');
        break;
      case 'agent.tool_use':
      case 'agent.mcp_tool_use': {
        const name =
          (event as { tool_use?: { name?: string } }).tool_use?.name ?? event.type;
        console.log(`🔧 tool: ${name}`);
        break;
      }
      case 'session.error': {
        const err = (event as { error?: { type?: string; mcp_server_name?: string; message?: string } }).error;
        console.log(`⚠️  session.error${err?.mcp_server_name ? ` [${err.mcp_server_name}]` : ''}: ${err?.type ?? ''} (continuing)`);
        break;
      }
      case 'session.status_idle':
      case 'session.status_terminated':
        console.log('\n✓ session complete.');
        // exit the loop via stream end below
        break;
      default:
        break;
    }
    if (event.type === 'session.status_idle' || event.type === 'session.status_terminated') break;
  }

  // ── 5. Post SIGNIFICANT records to Slack ──────────────────────────────────
  const records = parseRecords(finalText);
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
