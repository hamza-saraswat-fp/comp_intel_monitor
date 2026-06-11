// Posts a brief to Slack via the Web API (chat.postMessage) using a bot token.
//
// Why our code posts (not the agent via MCP): the hosted Slack MCP (mcp.slack.com)
// uses interactive OAuth meant for Claude Desktop/Code and won't take a bot token, so
// it doesn't fit a headless agent. A bot token + chat.postMessage is the standard
// headless path. The dry-run posts a sample here; Bundle 2's receiver will post the
// agent's real SIGNIFICANT records the same way.

import type { FeatureRecord } from './types';
import { buildSlackBlocks, briefText } from './brief';

export interface SlackPostResult {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

/** Post a SIGNIFICANT brief to a channel. `channel` may be a name (#competitor-ai) or ID. */
export async function postBriefToSlack(
  record: FeatureRecord,
  opts: { token: string; channel: string },
): Promise<SlackPostResult> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({
      channel: opts.channel,
      text: briefText(record), // notification / fallback text
      blocks: buildSlackBlocks(record),
    }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
  return { ok: data.ok, error: data.error, ts: data.ts, channel: data.channel };
}
