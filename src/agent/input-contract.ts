// The agent INPUT contract, in code. Mirrors docs/firecrawl-payloads.md §"Agent
// input contract" exactly. Pure functions, no API calls — so it can be unit-tested
// offline (see src/scripts/test-input-contract.ts) and reused verbatim by Bundle 2's
// webhook receiver (AIO-162) to decide which entries are worth a session.

import type {
  AgentChangeInput,
  MonitorMetadata,
  MonitorPageEntry,
  MonitorPagePayload,
} from './types';

/**
 * Act-on rule: process an entry ONLY when the page changed AND the Stage-1 judge
 * marked it meaningful. Ignores `same` and baseline `new` (no diff/judgment), and
 * not-meaningful changes. `removed`/`error` are not actionable here (logged by the
 * receiver for ops, per the payload doc).
 */
export function isActionable(entry: MonitorPageEntry): boolean {
  return entry.status === 'changed' && entry.judgment?.meaningful === true;
}

/** Resolve the surface (changelog/ai/pricing/…) for a URL from metadata.surfaces. */
export function surfaceFor(metadata: MonitorMetadata, url: string): string {
  if (metadata.surfaces) {
    try {
      const map = JSON.parse(metadata.surfaces) as Record<string, string>;
      if (map[url]) return map[url];
    } catch {
      // fall through to URL inference
    }
  }
  // Fallback: infer from the URL path.
  const u = url.toLowerCase();
  if (/release|changelog|whats-?new|updates/.test(u)) return 'changelog';
  if (/pricing|plans/.test(u)) return 'pricing';
  if (/news|press|newsroom/.test(u)) return 'newsroom';
  if (/\bai\b|copilot|intelligence|assistant/.test(u)) return 'ai';
  if (/blog/.test(u)) return 'blog';
  return 'unknown';
}

/** Normalize one actionable entry into the structured input the agent receives. */
export function toAgentInput(
  entry: MonitorPageEntry,
  metadata: MonitorMetadata,
  webhookId?: string,
): AgentChangeInput {
  const judgment = entry.judgment!; // guaranteed by isActionable
  return {
    competitor: metadata.competitor,
    competitorName: metadata.competitorName,
    surface: surfaceFor(metadata, entry.url),
    url: entry.url,
    tier: metadata.tier,
    category: metadata.category,
    knownAiProducts: metadata.knownAiProducts,
    diffText: entry.diff?.text ?? '',
    judgment,
    webhookId,
    suspectLowConfidence: judgment.meaningful && judgment.confidence === 'low',
  };
}

/**
 * Extract every actionable change from a `monitor.page` payload. A baseline `new`
 * or a not-meaningful change yields an empty array — i.e. no agent session.
 */
export function actionableInputs(payload: MonitorPagePayload): AgentChangeInput[] {
  if (payload.type !== 'monitor.page' || !Array.isArray(payload.data)) return [];
  return payload.data
    .filter(isActionable)
    .map((entry) => toAgentInput(entry, payload.metadata, payload.webhookId));
}
