// IAI-231 — the OKF writer. Turns a verified-SIGNIFICANT FeatureRecord into a REVIEWED
// pull request in the dashboard repo (Comp_Intel_Dashboard): a detection feed record
// plus a *conservative* auto-drafted edit to the matching matrix cell. A human approves
// the PR; project_okf.py then loads it into Supabase. The monitor never writes Supabase
// (or the matrix) directly — OKF + human review is the safety gate.
//
// Zero-dep: raw fetch to the GitHub REST API. Called best-effort by the receiver after the
// Slack post; any failure is logged and swallowed so it can never affect detection/Slack.

import type { FeatureRecord } from '../agent/types';
import { CAPABILITY_IDS, capabilityLabel } from '../taxonomy';

const GH = 'https://api.github.com';

export interface WriterConfig {
  token: string; // GITHUB_TOKEN — fine-grained PAT, contents + pull-requests: write on the dashboard repo
  owner: string; // hamza-saraswat-fp
  repo: string; // Comp_Intel_Dashboard
  base?: string; // default 'main'
}

export interface WriterResult {
  ok: boolean;
  prUrl?: string;
  error?: string;
  matrixEdit?: string; // human note on what happened to the cell
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'feature';
}
function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

async function gh(cfg: WriterConfig, path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${GH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'comp-intel-monitor',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${data?.message ?? 'error'}`);
  return data;
}

/** The detection feed record (knowledge/detections/<id>.md). `type: Detection`. */
export function detectionMd(r: FeatureRecord, id: string): string {
  const cap = CAPABILITY_IDS.includes(r.capability) ? r.capability : '';
  return [
    '---',
    'type: Detection',
    `id: ${id}`,
    `competitor: ${r.competitor}`,
    `capability: ${cap}`, // empty = uncategorized (flagged for triage)
    `what: ${r.what.replace(/\n/g, ' ')}`,
    `kind: ${r.kind}`,
    `significance: ${r.significance}`,
    `source_url: ${r.sourceUrl}`,
    `first_seen: ${r.firstSeen}`,
    '---',
    '',
    `Detected by comp-intel monitor. ${r.what}`,
    cap ? '' : '\n_Uncategorized — fits none of the 7 capabilities; flagged for human triage._',
  ].join('\n');
}

/**
 * Conservative edit of the matching offering cell: bump as_of, flag needs_verification,
 * append a dated update line + a citation, and apply the agent's suggested status/depth
 * (flagged for human confirm). NEVER rewrites the researched # Assessment. On any
 * unexpected structure, returns the original unchanged (the detection record is still the value).
 */
export function editCell(current: string, r: FeatureRecord, today: string): string {
  const fmEnd = current.indexOf('\n---', 3);
  if (!current.startsWith('---') || fmEnd === -1) return current; // safety: don't mangle

  let fm = current.slice(0, fmEnd); // '---\n<fields>'
  let body = current.slice(fmEnd); // '\n---\n<marker>\n...'

  const setFm = (block: string, key: string, val: string): string => {
    const re = new RegExp(`^${key}:.*$`, 'm');
    return re.test(block) ? block.replace(re, `${key}: ${val}`) : `${block}\n${key}: ${val}`;
  };
  fm = setFm(fm, 'as_of', today);
  fm = setFm(fm, 'needs_verification', 'true');
  if (r.suggestedStatus) fm = setFm(fm, 'status', r.suggestedStatus);
  if (r.suggestedDepth) fm = setFm(fm, 'depth', r.suggestedDepth);

  const updateLine = `**Update ${today}:** detected — ${r.what} (${r.sourceUrl})`;
  const citeLine = `[+] [${r.competitorName ?? r.competitor}: ${r.what}](${r.sourceUrl})`;
  if (body.includes('# Citations')) {
    // update line at the end of # Detail (just before # Citations); citation at the end.
    body = body.replace(/\n#\s+Citations/, `\n\n${updateLine}\n\n# Citations`);
    body = `${body.replace(/\s+$/, '')}\n${citeLine}\n`;
  } else {
    body = `${body.replace(/\s+$/, '')}\n\n${updateLine}\n`;
  }
  return fm + body;
}

/** PR body for a detection. */
function prBody(r: FeatureRecord, id: string, matrixNote: string): string {
  const status = r.suggestedStatus ? `\`${r.suggestedStatus}\`` : '(none suggested)';
  const depth = r.suggestedDepth ? `\`${r.suggestedDepth}\`` : '(none suggested)';
  return [
    `**Detection** (auto-opened by comp-intel monitor): \`${id}\``,
    '',
    `- **Competitor:** ${r.competitorName ?? r.competitor}`,
    `- **Capability:** ${capabilityLabel(r.capability)}${CAPABILITY_IDS.includes(r.capability) ? '' : ' — uncategorized, triage'}`,
    `- **What:** ${r.what}`,
    `- **Kind / significance:** ${r.kind} / ${r.significance}`,
    `- **Source:** ${r.sourceUrl}`,
    '',
    `**Matrix edit:** ${matrixNote}`,
    `**Suggested cell change (confirm before merging):** status → ${status}, depth → ${depth}. The cell is flagged \`needs_verification: true\`; the researched \`# Assessment\` is untouched.`,
    '',
    'Review the cell edit, confirm/adjust the status & depth, then merge — `project_okf.py` projects it into Supabase.',
  ].join('\n');
}

/** Open a reviewed detection PR in the dashboard repo. Best-effort; returns ok:false on any failure. */
export async function openDetectionPr(r: FeatureRecord, cfg: WriterConfig): Promise<WriterResult> {
  const base = cfg.base ?? 'main';
  const today = new Date().toISOString().slice(0, 10);
  const id = `${today}-${r.competitor}-${slugify(r.what)}`;
  const branch = `detect/${id}`;
  try {
    const ref = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${base}`, 'GET');
    const baseSha = ref.object.sha;
    await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: baseSha });

    await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/knowledge/detections/${id}.md`, 'PUT', {
      message: `detect: ${r.competitor} — ${r.what}`.slice(0, 72),
      content: b64(detectionMd(r, id)),
      branch,
    });

    let matrixNote = 'none (uncategorized — feed record only)';
    if (CAPABILITY_IDS.includes(r.capability)) {
      const cellPath = `knowledge/offerings/${r.competitor}/${r.capability}.md`;
      try {
        const file = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${cellPath}?ref=${base}`, 'GET');
        const current = Buffer.from(file.content, 'base64').toString('utf8');
        const edited = editCell(current, r, today);
        if (edited !== current) {
          await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${cellPath}`, 'PUT', {
            message: `detect: draft cell update ${r.competitor}/${r.capability}`.slice(0, 72),
            content: b64(edited),
            sha: file.sha,
            branch,
          });
          matrixNote = `drafted a conservative edit to \`${cellPath}\``;
        } else {
          matrixNote = `cell unchanged (unexpected structure) — review \`${cellPath}\` manually`;
        }
      } catch (e) {
        matrixNote = `cell edit skipped: ${(e as Error).message}`;
      }
    }

    const pr = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/pulls`, 'POST', {
      title: `detect: ${r.competitorName ?? r.competitor} — ${r.what}`.slice(0, 120),
      head: branch,
      base,
      draft: true,
      body: prBody(r, id, matrixNote),
    });
    return { ok: true, prUrl: pr.html_url, matrixEdit: matrixNote };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
