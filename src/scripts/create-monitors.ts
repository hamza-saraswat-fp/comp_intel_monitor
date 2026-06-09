// Upserts the pilot Firecrawl monitors (AIO-154 / 156 / 157), one per competitor.
//
// Idempotent: lists existing monitors first; updates the ones we already own
// (matched by name `comp-intel/<slug>`) and creates the rest. Both paths send the
// SAME full config (goal + schedule + notification + webhook{+metadata} + targets),
// so updateMonitor never wipes a field regardless of patch/replace semantics.
//
//   npm run create-monitors
//
// Required env: FIRECRAWL_API_KEY, ALERT_EMAIL
// Optional env: WEBHOOK_SITE_URL (capture payloads + carry metadata), MONITOR_SCHEDULE,
//               MONITOR_TIMEZONE, RUN_NOW=true (trigger an immediate check for verification).
//
// Note: the Firecrawl plan rate-limits the monitor API (~3 req/min), so every API
// call is wrapped in withRateLimitRetry, which honors the server's "retry after Ns".

import 'dotenv/config';
import Firecrawl from '@mendable/firecrawl-js';
import {
  PILOT_COMPETITORS,
  buildGoal,
  buildMetadata,
  monitorName,
  type PilotCompetitor,
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
      const is429 = err?.status === 429 || /rate limit/i.test(`${err?.message ?? ''}`);
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

  // The full monitor config — identical for create and update so nothing is wiped.
  const buildConfig = (c: PilotCompetitor) => ({
    name: monitorName(c),
    schedule: { text: schedule, timezone },
    goal: buildGoal(c),
    notification: {
      email: { enabled: true, recipients: [alertEmail], includeDiffs: true },
    },
    ...(webhookUrl
      ? {
          webhook: {
            url: webhookUrl,
            events: ['monitor.page', 'monitor.check.completed'],
            metadata: buildMetadata(c),
          },
        }
      : {}),
    targets: [{ type: 'scrape' as const, urls: c.urls.map((u) => u.url) }],
  });

  // Idempotency: find monitors we already own (name `comp-intel/<slug>`).
  const existing = toMonitorArray(
    await withRateLimitRetry('listMonitors', () => firecrawl.listMonitors()),
  );
  const idByName = new Map<string, string>();
  for (const m of existing) {
    if (m.name) idByName.set(m.name, m.id ?? '');
  }

  console.log(
    `Found ${existing.length} existing monitor(s). Upserting ${PILOT_COMPETITORS.length} pilot ` +
      `monitor(s): schedule="${schedule}" (${timezone}), ` +
      `${webhookUrl ? 'email + webhook(+metadata)' : 'email only'} delivery.\n`,
  );

  const owned: Array<{ name: string; id: string }> = [];

  for (const competitor of PILOT_COMPETITORS) {
    const name = monitorName(competitor);
    const config = buildConfig(competitor);
    const existingId = idByName.get(name);

    if (existingId) {
      const updated: any = await withRateLimitRetry(`updateMonitor ${name}`, () =>
        firecrawl.updateMonitor(existingId, config),
      );
      console.log(`~ updated ${name} — id=${existingId} status=${updated?.status ?? 'ok'}`);
      owned.push({ name, id: existingId });
      continue;
    }

    const created: any = await withRateLimitRetry(`createMonitor ${name}`, () =>
      firecrawl.createMonitor(config),
    );
    console.log(
      `+ created ${name} — id=${created.id} status=${created.status ?? '?'} ` +
        `nextRunAt=${created.nextRunAt ?? '?'} estCredits/mo=${created.estimatedCreditsPerMonth ?? '?'}`,
    );
    owned.push({ name, id: created.id });
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
        console.log(`  ▶ ${name} — check triggered (id=${res?.id ?? '?'} status=${res?.status ?? '?'})`);
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
