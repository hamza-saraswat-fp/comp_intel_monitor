// Creates the pilot Firecrawl monitors (AIO-154), one per competitor.
//
// Idempotent: lists existing monitors first and skips any already created
// (matched by name `comp-intel/<slug>`). Re-run safely after editing the URL list.
//
//   npm run create-monitors
//
// Required env: FIRECRAWL_API_KEY, ALERT_EMAIL
// Optional env: WEBHOOK_SITE_URL (capture payloads), MONITOR_SCHEDULE, MONITOR_TIMEZONE,
//               RUN_NOW=true (trigger an immediate check on each monitor for verification).
//
// Note: the Firecrawl plan rate-limits the monitor API (e.g. 3 req/min), so every
// API call is wrapped in withRateLimitRetry, which honors the server's "retry after Ns".

import 'dotenv/config';
import Firecrawl from '@mendable/firecrawl-js';
import {
  PILOT_COMPETITORS,
  JUDGE_GOAL,
  MONITOR_NAME_PREFIX,
} from '../monitors/pilot';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ Missing required env var: ${name} (copy .env.example → .env)`);
    process.exit(1);
  }
  return value;
}

/** Run an API call, retrying on 429 using the server-provided "retry after Ns" hint. */
async function withRateLimitRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const is429 =
        err?.status === 429 || /rate limit/i.test(`${err?.message ?? ''}`);
      if (!is429 || attempt >= maxAttempts) throw err;
      const text = `${err?.message ?? ''} ${err?.details?.error ?? ''}`;
      const match = text.match(/retry after (\d+)\s*s/i);
      const waitSec = (match ? parseInt(match[1], 10) : 60) + 3;
      console.log(
        `  … ${label}: rate-limited, waiting ${waitSec}s (attempt ${attempt}/${maxAttempts})`,
      );
      await sleep(waitSec * 1000);
    }
  }
}

/** Normalize whatever listMonitors() returns into a flat array of monitor objects. */
function toMonitorArray(result: any): Array<{ id?: string; name?: string }> {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.monitors)) return result.monitors;
  return [];
}

async function main(): Promise<void> {
  const apiKey = requireEnv('FIRECRAWL_API_KEY');
  const alertEmail = requireEnv('ALERT_EMAIL');
  const webhookUrl = process.env.WEBHOOK_SITE_URL?.trim() || undefined;
  const schedule = process.env.MONITOR_SCHEDULE?.trim() || 'daily';
  const timezone = process.env.MONITOR_TIMEZONE?.trim() || 'UTC';
  const runNow = /^(1|true|yes)$/i.test(process.env.RUN_NOW?.trim() ?? '');

  const firecrawl = new Firecrawl({ apiKey });

  // Idempotency guard: find monitors we already own (name `comp-intel/<slug>`).
  const existing = toMonitorArray(
    await withRateLimitRetry('listMonitors', () => firecrawl.listMonitors()),
  );
  const idByName = new Map<string, string>();
  for (const m of existing) {
    if (m.name) idByName.set(m.name, m.id ?? '');
  }

  console.log(
    `Found ${existing.length} existing monitor(s) on the account. ` +
      `Ensuring ${PILOT_COMPETITORS.length} pilot monitor(s): schedule="${schedule}" (${timezone}), ` +
      `${webhookUrl ? 'email + webhook' : 'email only'} delivery.\n`,
  );

  const owned: Array<{ name: string; id: string }> = [];

  for (const competitor of PILOT_COMPETITORS) {
    const name = `${MONITOR_NAME_PREFIX}${competitor.slug}`;

    const existingId = idByName.get(name);
    if (existingId !== undefined) {
      console.log(`= skip    ${name} — already exists (id=${existingId || '?'})`);
      owned.push({ name, id: existingId });
      continue;
    }

    const monitor: any = await withRateLimitRetry(`createMonitor ${name}`, () =>
      firecrawl.createMonitor({
        name,
        schedule: { text: schedule, timezone },
        goal: JUDGE_GOAL,
        notification: {
          email: { enabled: true, recipients: [alertEmail], includeDiffs: true },
        },
        ...(webhookUrl
          ? { webhook: { url: webhookUrl, events: ['monitor.page', 'monitor.check.completed'] } }
          : {}),
        targets: [{ type: 'scrape', urls: competitor.urls }],
      }),
    );

    console.log(
      `+ created ${name} — id=${monitor.id} status=${monitor.status ?? '?'} ` +
        `nextRunAt=${monitor.nextRunAt ?? '?'} estCredits/mo=${monitor.estimatedCreditsPerMonth ?? '?'}`,
    );
    owned.push({ name, id: monitor.id });
  }

  if (runNow) {
    console.log('\nRUN_NOW set — triggering an immediate check on each monitor:');
    for (const { name, id } of owned) {
      if (!id) {
        console.log(`  ! ${name} — no id, cannot run`);
        continue;
      }
      try {
        const res: any = await withRateLimitRetry(`runMonitor ${name}`, () =>
          firecrawl.runMonitor(id),
        );
        console.log(`  ▶ ${name} — check triggered (${JSON.stringify(res)})`);
      } catch (err) {
        console.log(`  ! ${name} — runMonitor failed: ${(err as Error).message}`);
      }
    }
  }

  console.log(
    '\nDone. Watch the Firecrawl dashboard, your inbox, and webhook.site for results' +
      (runNow ? ' (a check is running now).' : '.'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
