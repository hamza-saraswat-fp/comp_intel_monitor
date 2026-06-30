// Operational introspection: what agent sessions have run, and what the Memory Store
// has actually recorded. Read-only.
//
//   npm run inspect
//
// Required env: ANTHROPIC_API_KEY, MEMORY_STORE_ID

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function collect<T>(iter: AsyncIterable<T>, cap = 40): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) {
    out.push(x);
    if (out.length >= cap) break;
  }
  return out;
}

async function main(): Promise<void> {
  const client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  const storeId = requireEnv('MEMORY_STORE_ID');
  const agentId = process.env.AGENT_ID;

  // ── Recent agent sessions ────────────────────────────────────────────────
  console.log('=== RECENT AGENT SESSIONS (newest first) ===');
  const sessions = await collect(client.beta.sessions.list({ limit: 40 } as never));
  const ours = agentId
    ? sessions.filter((s) => {
        const a = (s as { agent?: unknown }).agent;
        const id = typeof a === 'string' ? a : (a as { id?: string } | undefined)?.id;
        return id === agentId;
      })
    : sessions;
  if (!ours.length) console.log('  (none)');
  for (const s of ours) {
    const o = s as { id: string; created_at?: string; status?: string; title?: string };
    console.log(`  ${o.created_at ?? '?'}  ${o.status ?? '?'}  ${o.id}  ${o.title ?? ''}`);
  }

  // ── Memory Store contents ────────────────────────────────────────────────
  console.log('\n=== MEMORY STORE (what has been recorded per competitor) ===');
  const mems = await collect(client.beta.memoryStores.memories.list(storeId), 100);
  for (const m of mems) {
    const path = (m as { path?: string }).path;
    if (!path?.startsWith('/competitors/')) continue;
    const full = await client.beta.memoryStores.memories.retrieve((m as { id: string }).id, {
      memory_store_id: storeId,
    } as never);
    const content = (full as { content?: string }).content ?? '';
    console.log(`\n── ${path} ──`);
    console.log(content.trim());
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
