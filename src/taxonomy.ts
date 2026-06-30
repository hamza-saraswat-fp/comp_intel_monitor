// The 7-category AI capability taxonomy — VENDORED copy.
//
// CANONICAL SOURCE: Comp_Intel_Dashboard/taxonomy.json. The kebab-case `id` slugs are
// the contract between this monitor and the dashboard's OKF bundle (offerings/<comp>/<id>.md).
// Keep these in sync with taxonomy.json; if the dashboard adds/renames a capability,
// update this list (and re-deploy the agent so agent.yaml's prompt matches).

export const CAPABILITIES = [
  { id: 'customer-contact-agent', title: 'AI Customer-Contact Agent', def: 'Inbound calls AND chat/SMS handled by AI: receptionist, lead capture, 24/7 booking.' },
  { id: 'in-product-copilot', title: 'In-Product AI Copilot', def: 'In-app assistant to query your data, pull analytics, and get coaching in plain English.' },
  { id: 'dispatch-scheduling', title: 'AI Dispatch & Scheduling', def: 'ML technician assignment + schedule/route optimization (true ML, not just GPS/heuristics).' },
  { id: 'marketing-content', title: 'AI Marketing & Content', def: 'AI generation of marketing assets (email, SMS, social, campaigns) from the business data.' },
  { id: 'reputation-reviews', title: 'AI Reputation & Reviews', def: 'Automated review solicitation, AI-drafted responses, reputation monitoring.' },
  { id: 'back-office-automation', title: 'AI Back-Office Automation', def: 'AI for quoting/estimating AND document/data work (price books, estimates, invoice OCR, data entry).' },
  { id: 'agentic-workflow', title: 'Agentic Workflow Automation', def: 'Multi-step autonomous agents that run end-to-end office workflows (beyond answering questions).' },
] as const;

/** A real capability id, or an escape hatch: `none` (not an AI feature) / `uncertain` (ambiguous). */
export type CapabilityId = (typeof CAPABILITIES)[number]['id'] | 'none' | 'uncertain';

export const CAPABILITY_IDS: readonly string[] = CAPABILITIES.map((c) => c.id);

/** Human title for a tag (id slug → display), tolerant of the escape hatches. */
export function capabilityLabel(id: string): string {
  const hit = CAPABILITIES.find((c) => c.id === id);
  if (hit) return hit.title;
  if (id === 'uncertain') return 'Uncertain';
  return 'Uncategorized';
}
