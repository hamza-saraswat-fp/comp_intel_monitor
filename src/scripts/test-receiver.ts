// Receiver verification (AIO-162): spawns the REAL server on a test port and replays
// the captured sample payloads against it with valid + tampered signatures.
//
//   npm run test:receiver                  # signature/filter/dedupe cases — NO agent sessions
//   npm run test:receiver -- --with-session  # + replays the Atlas fixture → real agent session
//                                            #   (expect MINOR/no post: Atlas is in Memory)
//
// Requires the agent env vars in .env (the server fail-fasts at boot without them).
// Slack env is overridden with dummies so nothing can post during the default cases.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';

const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-secret-for-replay';
const withSession = process.argv.includes('--with-session');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function post(body: string, signature?: string): Promise<number> {
  const res = await fetch(`${BASE}/webhooks/firecrawl`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature ? { 'X-Firecrawl-Signature': signature } : {}),
    },
    body,
  });
  return res.status;
}

async function healthz(): Promise<Record<string, number>> {
  const res = await fetch(`${BASE}/healthz`);
  return (await res.json()) as Record<string, number>;
}

function loadSample(name: string): string {
  return readFileSync(resolve('docs/samples', name), 'utf8');
}

async function main(): Promise<void> {
  // Spawn the real server. Dummy Slack creds in the default run so nothing can post;
  // --with-session uses the real .env Slack values (Atlas should be MINOR → no post anyway).
  const env = {
    ...process.env,
    PORT: String(PORT),
    FIRECRAWL_WEBHOOK_SECRET: SECRET,
    ...(withSession
      ? {}
      : { SLACK_BOT_TOKEN: 'xoxb-dummy-test-token', SLACK_CHANNEL: '#dummy-test' }),
  };
  const server = spawn('npx', ['tsx', 'src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d: Buffer) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', (d: Buffer) => process.stdout.write(`  [server!] ${d}`));

  try {
    // Wait for boot.
    let up = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const h = await healthz();
        if (h.ok) {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
    }
    check('server boots and /healthz responds', up);
    if (!up) return;

    const baseline = loadSample('monitor.page.example.json'); // status:new, no judgment
    const notMeaningful = loadSample('monitor.page.changed.example.json'); // judge filtered

    // 1. Valid signature, baseline `new` → 200, no session.
    check('valid signature + baseline `new` → 200', (await post(baseline, sign(baseline))) === 200);

    // 2. Tampered/missing signatures → 401.
    check('tampered signature → 401', (await post(baseline, sign(baseline, 'wrong-secret'))) === 401);
    check('tampered body → 401', (await post(baseline.replace('"new"', '"changed"'), sign(baseline))) === 401);
    check('missing signature header → 401', (await post(baseline)) === 401);
    check('malformed signature header → 401', (await post(baseline, 'sha256=zzzz')) === 401);

    // 3. Not-meaningful change → 200, no session.
    check('not-meaningful `changed` → 200', (await post(notMeaningful, sign(notMeaningful))) === 200);

    // 4. Duplicate webhookId → counted as duplicate (baseline + notMeaningful were first sends).
    await post(notMeaningful, sign(notMeaningful));
    await sleep(300);
    let h = await healthz();
    check('duplicate webhookId skipped', h.duplicateWebhooks >= 1);
    check('no agent session started by any of the above', h.sessionsStarted === 0);
    check(`signature rejections counted (${h.rejectedSignature})`, h.rejectedSignature === 4);

    // 5. Optional: full path with a REAL agent session (Atlas → expect MINOR, no post).
    if (withSession) {
      const atlas = loadSample('monitor.page.atlas.example.json');
      check('atlas fixture → 200', (await post(atlas, sign(atlas))) === 200);
      console.log('  … agent session running (web-verify + Memory dedup take ~1-3 min)');
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await sleep(10_000);
        h = await healthz();
        if (h.sessionsStarted >= 1 && h.sessionsRunning === 0 && h.pending === 0) break;
      }
      h = await healthz();
      check('atlas session started', h.sessionsStarted === 1);
      check('atlas session completed', h.sessionsRunning === 0 && h.pending === 0);
      console.log('  → check the [server] log above: expect "servicetitan: MINOR → no alert" (dedup)');
    }

    console.log(failures === 0 ? '\nAll receiver checks passed.' : `\n${failures} check(s) FAILED.`);
  } finally {
    server.kill('SIGTERM');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
