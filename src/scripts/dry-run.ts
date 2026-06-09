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
import type { AgentChangeInput, MonitorPagePayload } from '../agent/types';

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
    'web-verify → classify (SIGNIFICANT/MINOR/UNCLEAR) → check Memory → if SIGNIFICANT and',
    'genuinely new, post the brief to #competitor-ai and append to Memory. After handling',
    'all of them, print a short summary line per change with its final classification and kind.',
    '',
    '```json',
    JSON.stringify(changes, null, 2),
    '```',
  ].join('\n');
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

  for await (const event of stream) {
    switch (event.type) {
      case 'agent.message': {
        const text = messageText(event).trim();
        if (text) console.log(`\n🧠 agent: ${text}\n`);
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
      case 'session.error':
        console.error('✖ session error:', JSON.stringify(event, null, 2));
        return;
      case 'session.status_idle':
        console.log('\n✓ session idle — turn complete.');
        return;
      case 'session.status_terminated':
        console.log('\n✓ session terminated.');
        return;
      default:
        break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
