# CLAUDE.md — comp_intel_monitor

The clean, agent-native build for **Competitor Intel**. Read this before doing any work in this repo.

## What we're building

A system that automatically detects when FieldPulse's top 15 FMS competitors ship **new AI features** and posts each one to a dedicated `#competitor-ai` Slack channel.

Two decoupled systems: **Firecrawl `/monitor`** (the eyes — daily scrape, diff-only, permissive "judge" pre-filter, runs on Firecrawl's own infra) → signed webhook → a **Claude Managed Agent** (the brain — web-verifies the launch, classifies SIGNIFICANT/MINOR/UNCLEAR, dedups against a Memory Store, writes a brief, posts to Slack).

**Source of truth:** the [Competitor Intel MVP write-up](https://linear.app/fieldpulse/document/competitor-intel-mvp-write-up-source-of-truth-fd7e4a879726) in Linear (local copy lives in the parent workspace as `Competitor-Intel-MVP.md`). If anything here conflicts with the spec, **the spec wins** — update both.

**Scope discipline:** MVP only — 15 competitors, **batched daily** processing, **AI-related pricing changes only**, the `#competitor-ai` channel. Anything beyond the spec's MVP (dashboard/UI, manual intel entry, broader pricing/review monitoring, 75-competitor expansion, event-driven triggers) is **out of scope** until we explicitly decide otherwise.

## Architecture (one-liner)

Firecrawl `/monitor` (runs on Firecrawl infra — we don't schedule scrapes) → signed webhook (`monitor.page`, `monitor.check.completed`) → **our** receiver/queue → daily Managed Agent session drains the batch → verify / classify / dedup → post to `#competitor-ai`.

The **only thing we host/run** is the webhook receiver + queue + the daily session trigger. The spec calls this "a small endpoint" — keep it minimal. Stack is **TBD**; deployment target **TBD (likely Railway)**. Decide both before building AIO-162.

> Do **not** reuse the old, deprecated comp-intel app (archived at https://github.com/fp-evan/competitor-intel). This is a clean rebuild — no Supabase / Inngest / Vercel / Next.js patterns carried over.

## How we work — the per-issue loop

Everything is **one Linear issue → one feature branch → one PR**. Never commit straight to `main` (the only exception was the initial bootstrap commit).

For each issue in the **Comp Intel MVP** milestone:

1. **Pick & open** the issue; move it to **In Progress** in Linear.
2. **Branch off `main`** using Linear's auto-generated branch name (`feature/aio-<n>-<slug>`, copyable from the issue). Using this exact name links the PR back to the issue.
3. **Plan in plan mode** and get approval before writing any code.
4. **Execute** the change on the feature branch.
5. **Test / verify** it actually works — run it, not just a typecheck.
6. **Commit & push** to the feature branch.
7. **Open a draft PR** into `main`. Include the issue ID in the title (e.g. `feat(monitor): pilot setup (AIO-154)`).
8. **Mark ready → merge** into `main` once it's verified (squash merge).
9. **Delete** the feature branch.
10. The issue **auto-moves to Done** on merge (Linear ↔ GitHub). Confirm it landed.

**Definition of Done = the PR is merged to `main`.** Nothing is Done until then.

## Git / PR conventions

- Default branch: `main`. Only ever update it via a merged PR.
- One feature branch per issue: `feature/aio-<n>-<slug>` (use the Linear-provided name so the PR auto-links).
- PRs start as **draft**; flip to ready only after testing.
- Always reference the issue ID (`AIO-###`) in the PR title or body → auto-links the PR and auto-moves the issue to Done on merge.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:` …). Commits Claude makes end with a `Co-Authored-By: Claude` trailer; PR bodies end with the "Generated with Claude Code" line.
- **Squash-merge** to keep `main` history clean, then delete the branch.
- Commit / push / merge **only when Hamza gives the go-ahead** for that step.

## Linear quick reference

- Team **Ai Ops** (`AIO`) · Project **Competitor Intel** · Milestone **Comp Intel MVP**
- Numbering mirrors the milestone: `X.1` = parent issue, `X.2+` = its sub-issues.
- **Issue 1 (Firecrawl, the eyes):** AIO-154 (parent) → AIO-156, AIO-157, AIO-158
- **Issue 2 (Managed Agent, the brain):** AIO-155 (parent) → AIO-159, AIO-160, AIO-161, AIO-162
