// Pilot competitor monitor definitions for the Competitor Intel MVP (AIO-154 / 157).
//
// One Firecrawl monitor per competitor; each scrapes that competitor's surfaces
// (changelog / blog / AI page / pricing) on a daily cadence and judges every
// change against a permissive, high-recall goal. The judge is the coarse Stage-1
// filter; the Managed Agent (2.x) is the strict, stateful Stage-2 decision.

export type Surface = 'changelog' | 'blog' | 'ai' | 'pricing' | 'newsroom';

export interface MonitoredUrl {
  url: string;
  surface: Surface;
}

export interface PilotCompetitor {
  /** kebab slug; the monitor is named `${MONITOR_NAME_PREFIX}${slug}`. */
  slug: string;
  name: string;
  /** From the MVP write-up §5 watchlist. */
  tier: 'Major' | 'Moderate' | 'SMB add';
  category: string;
  /** Known AI products — named in the goal to boost the judge's recall. */
  knownAiProducts: string[];
  urls: MonitoredUrl[];
}

/** Prefix for every monitor name so the upsert can find/own them (idempotency). */
export const MONITOR_NAME_PREFIX = 'comp-intel/';

/** Version of the metadata contract documented in docs/firecrawl-payloads.md. */
export const METADATA_SCHEMA_VERSION = '1';

/**
 * Shared judge goal (Stage 1 — permissive / high-recall). Per-competitor known
 * AI products are appended by buildGoal(). Decisions locked in AIO-157 discovery:
 * pass pre-announcements, pricing = AI-related only, pass expansions, and ask the
 * judge to label net-new vs expansion vs pre-announcement in its free-text reason.
 */
export const JUDGE_GOAL_BASE =
  'Mark a change meaningful if it suggests this competitor shipped, launched, ' +
  'expanded, or publicly pre-announced (including "coming soon", waitlist, or beta) ' +
  'a real AI or automation feature — e.g. AI dispatch/scheduling, AI voice/call ' +
  'handling or receptionist, AI estimating/quoting, an AI assistant/copilot, AI ' +
  'reporting/analytics, or a new AI add-on or plan. Treat BOTH brand-new AI features ' +
  'AND expansions of existing ones (general availability, a new trade/vertical/segment, ' +
  'or a new sub-capability) as meaningful. In your reason, state whether it looks ' +
  'net-new, an expansion, or a pre-announcement. For PRICING pages, only mark ' +
  'meaningful when the change is AI-related (a new AI add-on, AI tier, or AI pricing ' +
  'line); ignore non-AI price or packaging changes. NOT meaningful: marketing copy ' +
  'that merely mentions "AI" with no concrete feature, industry/thought-leadership ' +
  'posts, testimonials or social proof, and layout/navigation/wording changes. When ' +
  'unsure, lean toward meaningful.';

export const PILOT_COMPETITORS: PilotCompetitor[] = [
  {
    slug: 'servicetitan',
    name: 'ServiceTitan',
    tier: 'Major',
    category: 'FSM Platform',
    knownAiProducts: ['Titan Intelligence', 'Dispatch Pro', 'Marketing Pro', 'Fleet Pro'],
    urls: [
      { url: 'https://help.servicetitan.com/landing-page/release-notes-home', surface: 'changelog' },
      { url: 'https://www.servicetitan.com/features/titan-intelligence', surface: 'ai' },
      { url: 'https://www.servicetitan.com/blog/product-announcements', surface: 'blog' },
      { url: 'https://www.servicetitan.com/pricing', surface: 'pricing' },
    ],
  },
  {
    slug: 'jobber',
    name: 'Jobber',
    tier: 'Major',
    category: 'FSM Platform',
    knownAiProducts: ['AI Receptionist', 'Jobber Copilot'],
    urls: [
      { url: 'https://productupdates.getjobber.com/', surface: 'changelog' },
      { url: 'https://www.getjobber.com/features/ai/', surface: 'ai' },
      { url: 'https://www.getjobber.com/pricing/', surface: 'pricing' },
    ],
  },
  {
    slug: 'housecall-pro',
    name: 'Housecall Pro',
    tier: 'Major',
    category: 'FSM Platform',
    knownAiProducts: ['CSR AI', 'AI Team', 'Analyst AI', 'Coach AI', 'Marketing AI'],
    urls: [
      { url: 'https://www.housecallpro.com/features/ai-team/', surface: 'ai' },
      { url: 'https://www.housecallpro.com/about/newsroom/', surface: 'newsroom' },
      { url: 'https://www.housecallpro.com/pricing/', surface: 'pricing' },
      // Changelog: no stable URL. Candidate https://whatsnew.housecallpro.com/en (Beamer)
      // was flaky — verify before adding. Tracked for follow-up.
    ],
  },
];

export function monitorName(c: PilotCompetitor): string {
  return `${MONITOR_NAME_PREFIX}${c.slug}`;
}

/** Full judge goal for a competitor: shared base + its known AI products. */
export function buildGoal(c: PilotCompetitor): string {
  return (
    `${JUDGE_GOAL_BASE}\nKnown AI products to watch (treat changes around these as ` +
    `high-priority): ${c.knownAiProducts.join(', ')}.`
  );
}

/**
 * Webhook metadata echoed verbatim in every payload, so the agent can identify
 * the competitor and surface without a separate lookup. Firecrawl only documents
 * flat string values, so the url→surface map is encoded as a JSON string.
 */
export function buildMetadata(c: PilotCompetitor): Record<string, string> {
  const surfaces = Object.fromEntries(c.urls.map((u) => [u.url, u.surface]));
  return {
    source: 'comp-intel',
    schemaVersion: METADATA_SCHEMA_VERSION,
    competitor: c.slug,
    competitorName: c.name,
    tier: c.tier,
    category: c.category,
    knownAiProducts: c.knownAiProducts.join(', '),
    surfaces: JSON.stringify(surfaces),
  };
}
