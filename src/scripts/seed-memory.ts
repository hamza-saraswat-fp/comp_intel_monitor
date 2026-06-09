// Seeds the Managed Agent's Memory Store (AIO-160) with one baseline record per pilot
// competitor, so day one the agent already knows the existing AI features and won't
// re-alert on them. Reuses PILOT_COMPETITORS (the same list that drives the monitors)
// as the single source of truth.
//
//   npm run seed-memory
//
// Required env: ANTHROPIC_API_KEY
// Optional env: MEMORY_STORE_ID   (reuse an existing store; otherwise one is created)
//               MEMORY_STORE_NAME (name for a newly created store; default "competitor-intel")
//
// Idempotent: never overwrites an existing /competitors/<slug>.md (so a re-seed can't
// clobber features the agent has appended since). Creates only the missing ones.
//
// NOTE: targets @anthropic-ai/sdk's managed-agents beta surface (client.beta.memoryStores).
// The SDK sets the `managed-agents-2026-04-01` beta header automatically. Verify your
// workspace has beta access before first run.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { PILOT_COMPETITORS, type PilotCompetitor } from '../monitors/pilot';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ Missing required env var: ${name} (copy .env.example → .env)`);
    process.exit(1);
  }
  return value;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** Baseline Memory file for a competitor — its known AI features, seeded as already-known. */
function seedContent(c: PilotCompetitor): string {
  const date = today();
  const bullets = c.knownAiProducts
    .map(
      (p) =>
        `- ${p} — kind: baseline; significance: high; firstSeen: ${date}; source: seeded from knownAiProducts`,
    )
    .join('\n');
  return [
    `# ${c.name} — known AI features`,
    '',
    `Competitor: \`${c.slug}\` · tier: ${c.tier} · category: ${c.category}`,
    '',
    'Baseline AI features already known as of seeding. Do NOT re-alert on these — a',
    'change that merely re-announces one of them is MINOR. Append a bullet below each',
    'time a genuinely new feature is verified and alerted.',
    '',
    '## Known features',
    bullets,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const client = new Anthropic({ apiKey });

  // Reuse an existing store if MEMORY_STORE_ID is set; else create one.
  let storeId = process.env.MEMORY_STORE_ID?.trim();
  if (!storeId) {
    const name = process.env.MEMORY_STORE_NAME?.trim() || 'competitor-intel';
    const store = await client.beta.memoryStores.create({
      name,
      description:
        'Per-competitor records of known AI features. Read /competitors/<slug>.md before ' +
        'alerting; append a feature after alerting on it. Used to avoid re-alerting.',
    });
    storeId = store.id;
    console.log(`+ created memory store "${name}" — id=${storeId}`);
    console.log(`  → add this to .env:  MEMORY_STORE_ID=${storeId}\n`);
  } else {
    console.log(`Using existing memory store ${storeId}\n`);
  }

  // Existing memory paths (so we never overwrite agent-appended history on re-seed).
  const existing = new Set<string>();
  for await (const mem of client.beta.memoryStores.memories.list(storeId)) {
    if (mem.path) existing.add(mem.path);
  }

  for (const competitor of PILOT_COMPETITORS) {
    const path = `/competitors/${competitor.slug}.md`;
    if (existing.has(path)) {
      console.log(`~ skip ${path} (already exists)`);
      continue;
    }
    await client.beta.memoryStores.memories.create(storeId, {
      path,
      content: seedContent(competitor),
    });
    console.log(`+ seeded ${path} — ${competitor.knownAiProducts.length} known feature(s)`);
  }

  console.log('\nDone. Verify with the agent: it should read these before alerting.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
