// Dry-run the Managed Agent against a sample payload — the Bundle-1 verification
// (AIO-155 acceptance: "dry-run on a sample diff classifies correctly").
//
//   npm run dry-run                 # uses the synthesized SIGNIFICANT sample
//   npm run dry-run -- docs/samples/monitor.page.changed.example.json   # not-meaningful → skipped
//
// Loads a monitor.page payload, applies the SAME act-on filter the receiver will use,
// and (if there's an actionable change) opens a real agent session against the live
// agent + seeded Memory Store + Slack vault, streams the run, and prints the agent's
// messages, tool calls, and final classification. Posts go to whatever channel the
// Slack vault/bot is wired to — point at a scratch channel until you trust it.
//
// Required env: ANTHROPIC_API_KEY, AGENT_ID, ENVIRONMENT_ID, MEMORY_STORE_ID
// Optional env: SLACK_VAULT_ID (omit to run without Slack — classification still prints)
//
// NOTE: targets @anthropic-ai/sdk's managed-agents beta (client.beta.sessions). Confirm
// beta access + the exact field names against the live SDK before first run.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { actionableInputs } from '../agent/input-contract';
import { briefText } from '../agent/brief';
import { postBriefToSlack } from '../agent/slack';
import type { AgentChangeInput, FeatureRecord, MonitorPagePayload } from '../agent/types';

const DEFAULT_SAMPLE = 'docs/samples/monitor.page.significant.example.json';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ Missing required env var: ${name} (copy .env.example → .env)`);
    process.exit(1);
  }
  return value;
}

function userText(changes: AgentChangeInput[]): string {
  return [
    'Process the following competitor page change(s) exactly per your instructions:',
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

/** Best-effort text extraction from a streamed agent.message event. */
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

async function main(): Promise<void> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const agentId = requireEnv('AGENT_ID');
  const environmentId = requireEnv('ENVIRONMENT_ID');
  const memoryStoreId = requireEnv('MEMORY_STORE_ID');
  const slackVaultId = process.env.SLACK_VAULT_ID?.trim() || undefined;

  const samplePath = process.argv[2] || DEFAULT_SAMPLE;
  const payload = JSON.parse(readFileSync(resolve(samplePath), 'utf8')) as MonitorPagePayload;
  const changes = actionableInputs(payload);

  console.log(`Sample: ${samplePath}`);
  console.log(`Actionable change(s) after the act-on filter: ${changes.length}`);
  if (changes.length === 0) {
    console.log('Nothing actionable (baseline `new` or judged not-meaningful) — no session. ✓');
    return;
  }
  for (const c of changes) {
    console.log(`  • ${c.competitor} [${c.surface}] ${c.url}${c.suspectLowConfidence ? ' (LOW-confidence judge — suspect)' : ''}`);
  }

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
    ...(slackVaultId ? { vault_ids: [slackVaultId] } : {}),
  });
  console.log(`\nSession ${session.id} created. Streaming…\n`);

  // Open the stream before sending so no early events are missed.
  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: userText(changes) }] }],
  });

  let finalText = '';
  let done = false;
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
        const name = (event as { tool_use?: { name?: string }; name?: string }).tool_use?.name
          ?? (event as { name?: string }).name
          ?? event.type;
        console.log(`🔧 tool: ${name}`);
        break;
      }
      case 'session.error': {
        // Non-fatal per the MCP connector docs: the session keeps running without
        // that server's tools. Expected when an MCP (e.g. Slack) has no vault
        // credential yet — the agent still classifies, it just can't post.
        const err = (event as {
          error?: { type?: string; mcp_server_name?: string; message?: string };
        }).error;
        console.log(
          `⚠️  session.error${err?.mcp_server_name ? ` [${err.mcp_server_name}]` : ''}: ` +
            `${err?.type ?? ''} — ${err?.message ?? ''}`,
        );
        console.log('   (continuing — the agent runs without that tool)\n');
        break;
      }
      case 'session.status_idle':
        console.log('\n✓ session idle — turn complete.');
        done = true;
        break;
      case 'session.status_terminated':
        console.log('\n✓ session terminated.');
        done = true;
        break;
      default:
        break;
    }
    if (done) break;
  }

  // The runner posts SIGNIFICANT records (the agent's Slack MCP doesn't work headless).
  const records = parseRecords(finalText);
  if (!records.length) {
    console.log('\n(no per-item record JSON found in the agent reply — nothing to post)');
    return;
  }
  const slackToken = process.env.SLACK_BOT_TOKEN?.trim();
  const slackChannel = process.env.SLACK_CHANNEL?.trim() || '#competitor-ai';
  const noSlack = process.argv.includes('--no-slack') || !slackToken;
  console.log(`\nRecords: ${records.map((r) => `${r.competitor}=${r.classification}`).join(', ')}`);
  for (const record of records) {
    if (record.classification !== 'SIGNIFICANT') {
      console.log(`  — ${record.competitor}: ${record.classification} → no alert (correct)`);
      continue;
    }
    if (noSlack) {
      console.log(`  ✓ SIGNIFICANT → would post to Slack:\n    ${briefText(record)}`);
      continue;
    }
    const result = await postBriefToSlack(record, { token: slackToken!, channel: slackChannel });
    console.log(
      result.ok
        ? `  ✓ SIGNIFICANT → posted to Slack (ts=${result.ts})`
        : `  ✖ Slack post failed: ${result.error}${result.error === 'not_in_channel' ? ' → /invite the bot to the channel and rerun' : ''}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
