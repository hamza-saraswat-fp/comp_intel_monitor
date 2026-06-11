// Shared Managed Agent session runner — the single implementation behind the
// receiver (src/server.ts), dry-run.ts, and live-run.ts.
//
// Creates one session against the live agent (AGENT_ID + ENVIRONMENT_ID) with the
// Memory Store attached, sends the batch of actionable changes, streams to idle,
// and returns the per-item FeatureRecords parsed from the agent's final reply.
// The CALLER posts SIGNIFICANT records to Slack (see src/agent/slack.ts) — the
// agent itself has no Slack tool (the hosted Slack MCP can't do headless auth).

import Anthropic from '@anthropic-ai/sdk';
import type { AgentChangeInput, FeatureRecord } from './types';

export interface RunChangesResult {
  records: FeatureRecord[];
  sessionId: string;
  /** The agent's final message text (for logs/traces). */
  finalText: string;
}

export interface RunChangesOptions {
  /** Called for streamed progress (tool names, agent messages). Defaults to console.log. */
  log?: (line: string) => void;
}

const MEMORY_INSTRUCTIONS =
  'Per-competitor known-AI-feature records at /competitors/<slug>.md. Read the ' +
  'matching file before alerting; append after alerting on a genuinely new feature.';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function buildUserText(changes: AgentChangeInput[]): string {
  return [
    'Process the following competitor page change(s) exactly per your instructions:',
    'web-verify → classify (SIGNIFICANT/MINOR/UNCLEAR) → check Memory → for SIGNIFICANT',
    'and genuinely new items, append to Memory.',
    '',
    'END your reply with a fenced ```json code block containing an ARRAY of the',
    'per-item records (the schema from your instructions) for ALL changes processed —',
    'the runner posts SIGNIFICANT ones to Slack on your behalf.',
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

/** Pull the last fenced ```json block out of the agent's final message. */
export function parseRecords(text: string): FeatureRecord[] {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return [];
  try {
    const parsed = JSON.parse(blocks[blocks.length - 1]!.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * Run one agent session over a batch of actionable changes and return the parsed
 * per-item records. Throws on missing env or session-creation failure; a session
 * that completes without parseable records returns `records: []`.
 */
export async function runChanges(
  changes: AgentChangeInput[],
  opts: RunChangesOptions = {},
): Promise<RunChangesResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

  const session = await client.beta.sessions.create({
    agent: requireEnv('AGENT_ID'),
    environment_id: requireEnv('ENVIRONMENT_ID'),
    resources: [
      {
        type: 'memory_store',
        memory_store_id: requireEnv('MEMORY_STORE_ID'),
        access: 'read_write',
        instructions: MEMORY_INSTRUCTIONS,
      },
    ],
  });
  log(`session ${session.id} created`);

  // Open the stream before sending so no early events are missed.
  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: buildUserText(changes) }] }],
  });

  let finalText = '';
  let done = false;
  for await (const event of stream) {
    switch (event.type) {
      case 'agent.message': {
        const text = messageText(event).trim();
        if (text) {
          finalText = text;
          log(`🧠 agent: ${text}`);
        }
        break;
      }
      case 'agent.tool_use':
      case 'agent.mcp_tool_use': {
        const name = (event as { tool_use?: { name?: string } }).tool_use?.name ?? event.type;
        log(`🔧 tool: ${name}`);
        break;
      }
      case 'session.error': {
        // Non-fatal per the MCP connector docs — the session continues without
        // the affected tool. Log and keep streaming.
        const err = (event as {
          error?: { type?: string; mcp_server_name?: string; message?: string };
        }).error;
        log(
          `⚠️ session.error${err?.mcp_server_name ? ` [${err.mcp_server_name}]` : ''}: ` +
            `${err?.type ?? ''} — ${err?.message ?? ''} (continuing)`,
        );
        break;
      }
      case 'session.status_idle':
      case 'session.status_terminated':
        done = true;
        break;
      default:
        break;
    }
    if (done) break;
  }

  return { records: parseRecords(finalText), sessionId: session.id, finalText };
}
