// Dry-run the Managed Agent against a sample payload (AIO-155 acceptance:
// "dry-run on a sample diff classifies correctly").
//
//   npm run dry-run                                                      # synthesized SIGNIFICANT sample
//   npm run dry-run -- docs/samples/monitor.page.changed.example.json    # not-meaningful → skipped
//   npm run dry-run -- <sample> --no-slack                               # print briefs instead of posting
//
// Applies the SAME act-on filter the receiver uses, runs a real agent session via
// the shared runner, and posts SIGNIFICANT records to Slack (the runner posts —
// the agent has no Slack tool; see docs/agent.md "Why the runner posts").
//
// Required env: ANTHROPIC_API_KEY, AGENT_ID, ENVIRONMENT_ID, MEMORY_STORE_ID
// Optional env: SLACK_BOT_TOKEN + SLACK_CHANNEL (omit or pass --no-slack to print)

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { actionableInputs } from '../agent/input-contract';
import { briefText } from '../agent/brief';
import { postBriefToSlack } from '../agent/slack';
import { runChanges } from '../agent/run-session';
import type { MonitorPagePayload } from '../agent/types';

const DEFAULT_SAMPLE = 'docs/samples/monitor.page.significant.example.json';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--no-slack');
  const samplePath = args[0] || DEFAULT_SAMPLE;
  const payload = JSON.parse(readFileSync(resolve(samplePath), 'utf8')) as MonitorPagePayload;
  const changes = actionableInputs(payload);

  console.log(`Sample: ${samplePath}`);
  console.log(`Actionable change(s) after the act-on filter: ${changes.length}`);
  if (changes.length === 0) {
    console.log('Nothing actionable (baseline `new` or judged not-meaningful) — no session. ✓');
    return;
  }
  for (const c of changes) {
    console.log(
      `  • ${c.competitor} [${c.surface}] ${c.url}${c.suspectLowConfidence ? ' (LOW-confidence judge — suspect)' : ''}`,
    );
  }
  console.log('');

  const { records } = await runChanges(changes);
  console.log('\n✓ session complete.');

  if (!records.length) {
    console.log('(no per-item record JSON found in the agent reply — nothing to post)');
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
