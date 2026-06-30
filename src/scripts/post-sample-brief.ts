// Posts ONE sample SIGNIFICANT brief to #competitor-ai — proves the Slack wiring +
// brief format render (AIO-161 acceptance: "Brief template renders cleanly in Slack
// from a sample significant item").
//
//   npm run post-sample-brief
//
// Required env: SLACK_BOT_TOKEN (xoxb-… with chat:write; bot invited to the channel)
// Optional env: SLACK_CHANNEL (default #competitor-ai)

import 'dotenv/config';
import { postBriefToSlack } from '../agent/slack';
import type { FeatureRecord } from '../agent/types';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ Missing required env var: ${name} (add it to .env)`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const token = requireEnv('SLACK_BOT_TOKEN');
  const channel = process.env.SLACK_CHANNEL?.trim() || '#competitor-ai';

  // Illustrative SIGNIFICANT record — what a real alert looks like rendered in Slack.
  const sample: FeatureRecord = {
    competitor: 'servicetitan',
    competitorName: 'ServiceTitan',
    what: 'Launched "Contact Center Pro AI" — AI voice agents that answer inbound calls and book jobs 24/7',
    kind: 'new',
    sourceUrl: 'https://www.servicetitan.com/products/contact-center-pro',
    significance: 'high',
    classification: 'SIGNIFICANT',
    firstSeen: new Date().toISOString().slice(0, 10),
    capability: 'customer-contact-agent',
    capabilityConfidence: 'high',
    suggestedStatus: 'shipped',
  };

  const result = await postBriefToSlack(sample, { token, channel });
  if (result.ok) {
    console.log(`✓ posted sample brief to ${result.channel ?? channel} (ts=${result.ts})`);
  } else {
    console.error(`✖ Slack error: ${result.error}`);
    if (result.error === 'not_in_channel' || result.error === 'channel_not_found') {
      console.error('  → invite the bot to the channel:  /invite @Comp-Intel  (then retry)');
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
