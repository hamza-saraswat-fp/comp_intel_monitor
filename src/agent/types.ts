// Shared types for the Managed Agent (the "brain", Issue 2.x).
//
// Two halves:
//   1. The Firecrawl `monitor.page` payload shape (what the agent reads in) —
//      mirrors docs/firecrawl-payloads.md and the captured samples in docs/samples/.
//   2. The per-item feature record (what the agent writes out) — the §4 schema used
//      for both the Slack brief and the Memory Store entry.

// ── 1. Firecrawl monitor.page payload (agent INPUT) ──────────────────────────

export type PageStatus = 'same' | 'new' | 'changed' | 'removed' | 'error';
export type JudgeConfidence = 'high' | 'medium' | 'low';

export interface MeaningfulChange {
  type: 'added' | 'changed' | 'removed';
  before?: string;
  after?: string;
  reason?: string;
}

/** Stage-1 judge output (fixed schema). Present only on `status: "changed"`. */
export interface Judgment {
  meaningful: boolean;
  confidence: JudgeConfidence;
  reason: string;
  meaningfulChanges?: MeaningfulChange[];
}

export interface PageDiff {
  /** Unified git-style markdown diff. */
  text: string;
  /** Optional diff AST; we only consume `text`. */
  json?: unknown;
}

/** One scraped page in a `monitor.page` payload's `data[]`. */
export interface MonitorPageEntry {
  monitorId?: string;
  checkId?: string;
  url: string;
  status: PageStatus;
  previousScrapeId?: string | null;
  currentScrapeId?: string | null;
  error?: string | null;
  /** Mirrors `judgment.meaningful`; present only when judged. */
  isMeaningful?: boolean | null;
  /** Present only on `status: "changed"` when judging ran. */
  judgment?: Judgment | null;
  /** Present only on `status: "changed"`. */
  diff?: PageDiff | null;
}

/**
 * Metadata we attach per monitor; Firecrawl echoes it verbatim. Flat strings only
 * (maps are JSON-encoded). Defined by buildMetadata() in src/monitors/pilot.ts.
 */
export interface MonitorMetadata {
  source?: string;
  schemaVersion?: string;
  /** Canonical competitor id (slug) — the identity key. */
  competitor: string;
  competitorName?: string;
  tier?: string;
  category?: string;
  /** CSV of known AI products. */
  knownAiProducts?: string;
  /** JSON string: { url: surface }. */
  surfaces?: string;
  [key: string]: string | undefined;
}

export interface MonitorPagePayload {
  success?: boolean;
  type: string; // 'monitor.page'
  webhookId?: string;
  id?: string;
  data: MonitorPageEntry[];
  metadata: MonitorMetadata;
}

/**
 * One actionable change, normalized for the agent: the change passed the Stage-1
 * judge (`status: "changed"` && `judgment.meaningful === true`) and is ready for
 * the agent's Stage-2 §4 flow (web-verify → classify → dedup → brief → Slack → Memory).
 */
export interface AgentChangeInput {
  competitor: string; // slug, from metadata.competitor
  competitorName?: string;
  /** changelog | blog | ai | pricing | newsroom | unknown */
  surface: string;
  url: string;
  tier?: string;
  category?: string;
  knownAiProducts?: string;
  diffText: string;
  judgment: Judgment;
  webhookId?: string;
  /**
   * True when the judge said meaningful but with low confidence — the documented
   * transient-failure case. The agent must lean on web-verify before SIGNIFICANT.
   */
  suspectLowConfidence: boolean;
}

// ── 2. Per-item feature record (agent OUTPUT — §4 schema) ─────────────────────

export type FeatureKind = 'new' | 'expansion' | 'rebrand' | 'announcement-only';
export type Significance = 'high' | 'med' | 'low';
export type Classification = 'SIGNIFICANT' | 'MINOR' | 'UNCLEAR';

/**
 * The structured record the agent produces per change. Used verbatim as the Slack
 * brief payload (AIO-161) and as the Memory Store entry (AIO-160).
 */
export interface FeatureRecord {
  /** Competitor slug. */
  competitor: string;
  competitorName?: string;
  /** What the feature is, one concise line. */
  what: string;
  kind: FeatureKind;
  /** The announcement/docs URL the agent verified against. */
  sourceUrl: string;
  significance: Significance;
  classification: Classification;
  /** ISO-8601 date the feature was first recorded. */
  firstSeen: string;
}
