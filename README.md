# comp_intel_monitor

Agent-native system that detects when FieldPulse's top 15 FMS competitors ship **new AI features** and posts each one to a dedicated `#competitor-ai` Slack channel — fast enough for Product and Sales to react.

## How it works

**Firecrawl `/monitor` (the eyes)** watches ~45–60 competitor URLs on its own daily schedule (scrape mode, diff-only) and runs a permissive "judge" pre-filter so only AI-relevant changes pass through → signed webhook → **our receiver/queue** → a daily **Claude Managed Agent** session (the brain) web-verifies the launch, classifies it (SIGNIFICANT / MINOR / UNCLEAR), dedups against a Memory Store, writes a short brief, and posts to Slack.

Capture and reporting are decoupled: Firecrawl checks continuously and cheaply; the agent runs only when there's something to think about. The only thing **we** host is the webhook receiver + queue + the daily session trigger.

## Pilot monitors (AIO-154)

The first step stands up Firecrawl monitors on a 3-competitor pilot. One monitor per competitor, daily cadence, scrape mode, judged against the MVP write-up §4 goal. Delivery is **email** (Week-1 signal validation) plus an optional **webhook.site** sink to capture real payloads.

Surfaces monitored:

| Competitor | URLs |
|---|---|
| ServiceTitan | release notes · Titan Intelligence · product announcements · pricing |
| Jobber | product updates · AI features · pricing |
| Housecall Pro | AI Team · newsroom · pricing (changelog URL TBD — see `src/monitors/pilot.ts`) |

The exact URLs live in [`src/monitors/pilot.ts`](src/monitors/pilot.ts).

### Run it

```bash
npm install
cp .env.example .env     # then fill in FIRECRAWL_API_KEY, ALERT_EMAIL, (optional) WEBHOOK_SITE_URL
npm run create-monitors
```

The script is **idempotent** — it skips monitors that already exist (matched by name `comp-intel/<slug>`), so it's safe to re-run after editing the URL list.

**Verify:** set `RUN_NOW=true` in `.env` and run `npm run create-monitors` — it triggers an immediate check on each monitor (no need to wait for the daily schedule). Confirm an email and a `webhook.site` POST arrive within a couple of minutes, then unset `RUN_NOW` for normal runs.

**Credits:** ~10 URLs × 1 credit × 30 daily checks ≈ ~300 credits/mo + 1 per changed page judged — small vs. the ~$30–40/mo full-15 budget.

## Status

MVP in progress. **Source of truth:** the [Competitor Intel MVP write-up](https://linear.app/fieldpulse/document/competitor-intel-mvp-write-up-source-of-truth-fd7e4a879726) and the **Competitor Intel** project (team Ai Ops) in Linear.

Tech stack: Node/TS (Firecrawl JS SDK). The webhook receiver/queue and deployment target (likely Railway) are **TBD** — built in AIO-162.

## Working in this repo

See [`CLAUDE.md`](./CLAUDE.md) for the development workflow (one Linear issue → one feature branch → one PR; Done = merged to `main`).
