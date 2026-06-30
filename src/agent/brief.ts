// The Slack brief format (AIO-161), in code. This is the CANONICAL template a
// SIGNIFICANT find is delivered in. The same format is described in agent.yaml's
// system prompt (the agent composes the message and posts it via the Slack MCP);
// this module is the single source of truth for the shape, used by the dry-run to
// render a record locally and available to Bundle 2 if it ever formats host-side.

import type { FeatureRecord, FeatureKind, Significance } from './types';
import { capabilityLabel } from '../taxonomy';

const KIND_LABEL: Record<FeatureKind, string> = {
  new: 'New feature',
  expansion: 'Expansion',
  rebrand: 'Rebrand',
  'announcement-only': 'Announcement only',
};

const SIGNIFICANCE_EMOJI: Record<Significance, string> = {
  high: '🔴',
  med: '🟠',
  low: '🟡',
};

/** One-line plain-text brief — also the Slack notification/fallback text. */
export function briefText(r: FeatureRecord): string {
  const sig = `${SIGNIFICANCE_EMOJI[r.significance]} ${r.significance.toUpperCase()}`;
  const name = r.competitorName ?? r.competitor;
  return `${name} — ${r.what} (${KIND_LABEL[r.kind]}, ${sig}) ${r.sourceUrl}`;
}

/**
 * Slack Block Kit blocks for a SIGNIFICANT brief. Renders:
 *   competitor · what shipped · new/expansion/rebrand/announcement-only · source · significance
 */
export function buildSlackBlocks(r: FeatureRecord): unknown[] {
  const name = r.competitorName ?? r.competitor;
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🆕 ${name}: new AI feature`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${r.what}*` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Type:*\n${KIND_LABEL[r.kind]}` },
        {
          type: 'mrkdwn',
          text: `*Significance:*\n${SIGNIFICANCE_EMOJI[r.significance]} ${r.significance.toUpperCase()}`,
        },
        { type: 'mrkdwn', text: `*Competitor:*\n${name}` },
        { type: 'mrkdwn', text: `*Capability:*\n${capabilityLabel(r.capability)}` },
        { type: 'mrkdwn', text: `*Source:*\n<${r.sourceUrl}|announcement / docs>` },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Detected by comp-intel · first seen ${r.firstSeen} · classification *${r.classification}*`,
        },
      ],
    },
  ];
}
