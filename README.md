# comp_intel_monitor

Agent-native system that detects when FieldPulse's top 15 FMS competitors ship **new AI features** and posts each one to a dedicated `#competitor-ai` Slack channel — fast enough for Product and Sales to react.

## How it works

**Firecrawl `/monitor` (the eyes)** watches ~45–60 competitor URLs on its own daily schedule (scrape mode, diff-only) and runs a permissive "judge" pre-filter so only AI-relevant changes pass through → signed webhook → **our receiver/queue** → a daily **Claude Managed Agent** session (the brain) web-verifies the launch, classifies it (SIGNIFICANT / MINOR / UNCLEAR), dedups against a Memory Store, writes a short brief, and posts to Slack.

Capture and reporting are decoupled: Firecrawl checks continuously and cheaply; the agent runs only when there's something to think about. The only thing **we** host is the webhook receiver + queue + the daily session trigger.

## Status

MVP in progress. **Source of truth:** the [Competitor Intel MVP write-up](https://linear.app/fieldpulse/document/competitor-intel-mvp-write-up-source-of-truth-fd7e4a879726) and the **Competitor Intel** project (team Ai Ops) in Linear.

Tech stack for the receiver/queue is **TBD** — the spec calls it "a small endpoint"; keep it minimal. Deployment target TBD (likely Railway).

## Working in this repo

See [`CLAUDE.md`](./CLAUDE.md) for the development workflow (one Linear issue → one feature branch → one PR; Done = merged to `main`).
