# Signal validation — go / no-go (AIO-158)

**Verdict: GO** — proceed to build the Managed Agent (2.x).

Rather than wait the MVP's nominal Week-1 window, we validated the pipeline mechanically and with a retro sanity-check against known launches. (Decision made with Hamza on 2026-06-08.)

## What's proven

| Check | Result |
|---|---|
| Monitors live | 3 (ServiceTitan, Jobber, Housecall Pro), daily, scrape mode |
| Capture → delivery | ✅ real checks fired; webhook payloads + email both delivered (PR #1 + this PR) |
| Judge configured | ✅ permissive/high-recall goal per discovery (pre-announcements in, pricing AI-only, expansions in, known products anchored) |
| Agent context | ✅ rich `metadata` (competitor, tier, category, known products, surfaces) echoed in every payload — verified live |
| Payload shape | ✅ documented as the agent input contract — see [`firecrawl-payloads.md`](./firecrawl-payloads.md) |
| Cost | ✅ ~600 credits/mo for the pilot — well within budget |

## Retro sanity-check (substitute for the week)

Confirmed that known competitor AI lives on the surfaces we monitor and matches the judge goal (fetched 2026-06-08):

- **ServiceTitan** `/features/titan-intelligence` (monitored `ai` surface) — concrete AI products present: **Atlas** (AI sidekick), **Job Value Predictor**, **Second Chance Leads**, **Risky Driver Detection** (Fleet Pro), Marketing Pro generators, plus a **"Coming Soon"** list (TI Chat Assistant, Email Content Generator, …). The "Coming Soon" section directly validates our decision to **pass pre-announcements**.
- **Jobber** `/features/ai/` (monitored `ai` surface) — **AI Voice and Chat**, **Rewrite**, **AI Receptionist**, **Automations**, all concrete features the goal marks meaningful.

Conclusion: when these competitors ship or expand AI, it surfaces on a page we watch, and the goal language matches the kind of content present. The mechanism will catch the signal that matters.

## What we'll watch once real diffs arrive

- **False positives / negatives** — first real `status: "changed"` judgments (today everything is baseline `new`). Tune the goal if noisy or missing.
- **Judge confidence calibration** — whether `high/medium/low` tracks reality.
- **Housecall Pro changelog gap** — no stable changelog URL yet; relying on AI Team + newsroom. Revisit `whatsnew.housecallpro.com`.
- **Pricing-page noise** — confirm "AI-related only" holds up vs. routine price edits.

## Next

Agent build (AIO-155 / 2.x) starts next (planned for the following day). The payload contract above is the handoff.
