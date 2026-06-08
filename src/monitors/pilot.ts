// Pilot competitor monitor definitions for the Competitor Intel MVP (AIO-154).
//
// One Firecrawl monitor per competitor; each scrapes that competitor's surfaces
// (changelog / blog / AI page / pricing) on a daily cadence and judges every
// change against JUDGE_GOAL. See ../scripts/create-monitors.ts.

/** The judge `goal` from the MVP write-up §4 (Stage 1 — coarse, permissive filter). */
export const JUDGE_GOAL =
  'Mark a change meaningful ONLY if it suggests a competitor shipped, launched, or ' +
  'expanded a real AI/automation feature — e.g. AI dispatch/scheduling, AI voice/call ' +
  'handling, AI estimating/quoting, an AI assistant/copilot, or a new AI add-on or plan. ' +
  'NOT meaningful: marketing copy that just mentions "AI" with no concrete feature, ' +
  'industry/thought-leadership blog posts, "coming soon"/waitlist teasers, and ' +
  'layout/wording/testimonial/navigation changes. When unsure, lean toward meaningful.';

/** Prefix for every monitor name so the create script can find/own them (idempotency). */
export const MONITOR_NAME_PREFIX = 'comp-intel/';

export interface PilotCompetitor {
  /** kebab slug; the monitor is named `${MONITOR_NAME_PREFIX}${slug}`. */
  slug: string;
  name: string;
  /** Surfaces to scrape — changelog/release notes, blog/news, AI/product page, pricing. */
  urls: string[];
}

export const PILOT_COMPETITORS: PilotCompetitor[] = [
  {
    slug: 'servicetitan',
    name: 'ServiceTitan',
    urls: [
      'https://help.servicetitan.com/landing-page/release-notes-home', // release notes
      'https://www.servicetitan.com/features/titan-intelligence', // AI suite
      'https://www.servicetitan.com/blog/product-announcements', // announcements
      'https://www.servicetitan.com/pricing', // pricing
    ],
  },
  {
    slug: 'jobber',
    name: 'Jobber',
    urls: [
      'https://productupdates.getjobber.com/', // product updates / changelog
      'https://www.getjobber.com/features/ai/', // AI features
      'https://www.getjobber.com/pricing/', // pricing
    ],
  },
  {
    slug: 'housecall-pro',
    name: 'Housecall Pro',
    urls: [
      'https://www.housecallpro.com/features/ai-team/', // AI Team
      'https://www.housecallpro.com/about/newsroom/', // newsroom
      'https://www.housecallpro.com/pricing/', // pricing
      // Changelog: no stable URL. Candidate https://whatsnew.housecallpro.com/en (Beamer)
      // was flaky — verify before adding. Tracked in AIO-156.
    ],
  },
];
