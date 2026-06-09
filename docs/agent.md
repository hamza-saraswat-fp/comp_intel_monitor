# The Managed Agent — the "brain" (Issue 2: AIO-155 / 159 / 160 / 161)

Stage-2 of the funnel. Firecrawl's judge (Stage 1) does coarse, high-recall filtering of
each page diff; this agent does the strict, stateful decision — web-verify the launch,
classify it (SIGNIFICANT / MINOR / UNCLEAR), dedup against a Memory Store, and post
SIGNIFICANT launches to `#competitor-ai`.

> **Trigger model: event-driven.** Each Firecrawl webhook starts one agent session for
> that change — no queue, no daily scheduler. (This overrides the spec's original
> "batched daily" call; the spec + AIO-162 are updated as part of Bundle 2.) The receiver
> that turns a webhook into a session is **Bundle 2 (AIO-162)** — not built yet.

## What's in this bundle

| File | Role |
|---|---|
| [`agent.yaml`](../agent.yaml) | **The agent definition** — model + §4 rubric system prompt + tools + Slack MCP. Source of truth; pasted into the Console to create the live agent. (AIO-155 + 159) |
| [`src/agent/types.ts`](../src/agent/types.ts) | Shared types: the Firecrawl `monitor.page` shape (input) + the `FeatureRecord` §4 schema (output). |
| [`src/agent/input-contract.ts`](../src/agent/input-contract.ts) | The act-on rule in code (`status==="changed" && judgment.meaningful===true`), competitor/surface resolution. Pure — reused by Bundle 2's receiver. |
| [`src/agent/brief.ts`](../src/agent/brief.ts) | Canonical Slack brief format (AIO-161) — Block Kit + plain-text. |
| [`src/scripts/seed-memory.ts`](../src/scripts/seed-memory.ts) | Creates + seeds the Memory Store, one baseline record per pilot competitor. (AIO-160) |
| [`src/scripts/dry-run.ts`](../src/scripts/dry-run.ts) | Runs the live agent against a sample payload and streams the result. (AIO-155 acceptance) |
| [`src/scripts/test-input-contract.ts`](../src/scripts/test-input-contract.ts) | **Offline** test of the filter against the samples — no API key. The merge gate. |
| [`samples/monitor.page.significant.example.json`](./samples/monitor.page.significant.example.json) | Synthesized `meaningful:true` fixture (no real true-positive landed during the pilot). |

## Agent vs. session (the mental model)

- **The agent** = the config in `agent.yaml`. Created **once**; lives in the Anthropic
  workspace with an `AGENT_ID` + version history. Dormant — creating it runs nothing.
- **A session** = one run that instantiates the agent to actually process a change.
  Sessions are what do work; the dry-run starts one by hand, Bundle 2 starts one per webhook.

## Input contract

Mirrors [`firecrawl-payloads.md`](./firecrawl-payloads.md). Per `monitor.page` entry: act
only on `status==="changed"` && `judgment.meaningful===true`; identify the competitor via
`metadata.competitor` and the surface via `JSON.parse(metadata.surfaces)[url]`; a
low-confidence `meaningful` is flagged `suspectLowConfidence` and must survive web-verify.
`actionableInputs()` is the single implementation, used by the dry-run, the offline test,
and (later) the receiver.

## Memory Store design (AIO-160)

One store (mounted under `/mnt/memory/<store>/`), one file per competitor keyed by the
canonical slug from [`pilot.ts`](../src/monitors/pilot.ts):

```
/competitors/servicetitan.md
/competitors/jobber.md
/competitors/housecall-pro.md
```

Each file lists that competitor's known AI features. The agent **reads** the matching file
before alerting and **appends** after alerting on a genuinely new feature. Dedup rule:

- feature already in the file (or in `knownAiProducts`) → **MINOR**, no alert.
- absent, expands a known feature → SIGNIFICANT `kind:"expansion"`, alert, append.
- absent and genuinely new → SIGNIFICANT `kind:"new"`, alert, append.
- "coming soon"/vaporware → **UNCLEAR**, no alert, **no** Memory write (re-evaluate if it ships).

`seed-memory.ts` pre-loads each pilot competitor's `knownAiProducts` as baseline entries,
so the agent won't re-alert on existing features on day one. Re-seeding never overwrites an
existing file (it won't clobber features the agent has appended).

## Output / brief format (AIO-161)

The per-item record (`FeatureRecord`) is the schema for both the Memory entry and the Slack
brief: `competitor · what · kind (new/expansion/rebrand/announcement-only) · sourceUrl ·
significance (high/med/low) · classification · firstSeen`. The agent composes the Slack
message itself (via the Slack MCP) in the format described in `agent.yaml`; `brief.ts` is
the canonical renderer for that shape.

## The launch path

1. **Author** `agent.yaml` (done — in git).
2. **Create the live agent**: Console → *Create agent* → YAML tab → paste `agent.yaml` →
   *Create agent*. (Or `ant beta:agents create`.) Save the `AGENT_ID`.
3. **Provision** the Memory Store (`npm run seed-memory`), an environment, and the Slack
   vault (below).
4. **Run**: `npm run dry-run` starts a session against the live agent and streams it. In
   production, Bundle 2's receiver starts a session per webhook.

## Verification

- **Offline (the merge gate, no API key):** `npm run typecheck` and `npm run
  test:input-contract` — proves baseline `new` and not-meaningful changes are skipped and a
  `meaningful` change is parsed correctly (competitor, surface, suspect flag). ✅ passing.
- **Live (needs provisioning):** `npm run dry-run` →
  - `monitor.page.significant.example.json` → agent web-verifies, classifies SIGNIFICANT/new,
    dedup miss, posts to Slack, appends to `/competitors/servicetitan.md`. Re-run → MINOR,
    no post (dedup).
  - `monitor.page.changed.example.json` → 0 actionable, no session (skip).

## ⚠️ Provisioning checklist (needs Hamza / external access — not doable from code alone)

The code is built and offline-verified, but the live dry-run needs these one-time setups:

1. **Anthropic Managed Agents beta access** on the workspace, + an **`ANTHROPIC_API_KEY`**.
   (SDK `@anthropic-ai/sdk@^0.104.0` is installed and exposes the beta surface.)
2. **Create the agent** from `agent.yaml` (Console paste or `ant beta:agents create`) → `AGENT_ID`.
3. **Create an environment** (cloud default is fine) → `ENVIRONMENT_ID`.
4. **Seed Memory**: `npm run seed-memory` → `MEMORY_STORE_ID` (printed; add to `.env`).
5. **Slack**: create `#competitor-ai`; create/install a Slack app (bot) scoped to
   `chat:write` (+ invite it to the channel); register a **vault** holding its credential
   → `SLACK_VAULT_ID`. Confirm whether the Slack MCP post tool needs a channel **id** vs
   name and bake it in if so.
6. **Run the live dry-run** and confirm classify → post → Memory append, then the dedup
   re-run.

Until 1–5 exist, `seed-memory.ts` / `dry-run.ts` will exit on the missing env var; the
offline test stands in as the merge gate.
