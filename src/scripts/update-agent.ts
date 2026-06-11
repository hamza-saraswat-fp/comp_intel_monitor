// Applies agent.yaml to the LIVE agent (agents.update) — cuts a new version.
//
//   npm run update-agent
//
// agent.yaml is the source of truth; edit it, run this, and the live agent gets a new
// version (the Console shows the version history). Array fields (tools/mcp_servers/skills)
// are fully replaced by what's in the YAML — an absent mcp_servers key clears them.
//
// Required env: ANTHROPIC_API_KEY, AGENT_ID

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import Anthropic from '@anthropic-ai/sdk';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

interface AgentYaml {
  name: string;
  description?: string;
  model: string;
  system?: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
  metadata?: Record<string, string>;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const agentId = requireEnv('AGENT_ID');
  const yamlPath = resolve('agent.yaml');
  const config = parse(readFileSync(yamlPath, 'utf8')) as AgentYaml;

  const client = new Anthropic({ apiKey });
  const current = await client.beta.agents.retrieve(agentId);
  console.log(
    `current: "${current.name}" v${current.version} — ` +
      `mcp_servers=${(current.mcp_servers ?? []).length}, tools=${(current.tools ?? []).length}`,
  );

  const updated = await client.beta.agents.update(agentId, {
    version: current.version,
    name: config.name,
    description: config.description ?? null,
    system: config.system ?? null,
    model: config.model as never,
    tools: (config.tools ?? []) as never,
    mcp_servers: (config.mcp_servers ?? []) as never,
    metadata: config.metadata ?? {},
  });

  if (updated.version === current.version) {
    console.log(`no change — still v${current.version}`);
  } else {
    console.log(
      `✓ updated to v${updated.version} — ` +
        `mcp_servers=${(updated.mcp_servers ?? []).length}, tools=${(updated.tools ?? []).length}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
