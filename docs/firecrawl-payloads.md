# Firecrawl monitor payloads — reference & agent input contract (AIO-156)

What Firecrawl sends our webhook, and exactly what the Managed Agent (2.x) should read out of it. Real captured samples live in [`samples/`](./samples/).

## Delivery

Each monitor (one per competitor) delivers two ways:

- **Email** — `notification.email` (Week-1 signal validation; `includeDiffs: true`).
- **Webhook** — `POST` to our endpoint for events `monitor.page` and `monitor.check.completed`. Today that endpoint is a webhook.site sink; the real receiver/queue is AIO-162.

Firecrawl runs the scrape schedule on its own infrastructure (daily) — we host nothing for capture.

## Events

| Event | Fires | Carries |
|---|---|---|
| `monitor.page` | once per scraped page as the check runs | per-page status, `diff`, and `judgment` |
| `monitor.check.completed` | once after the whole check reconciles | summary counts only |

### `monitor.page` (the one the agent cares about)

Top-level: `success`, `type`, `id` (checkId), `webhookId` (unique per delivery — use to dedupe), `data[]`, `metadata` (see contract below).

Each `data[]` page entry:

| Field | Meaning |
|---|---|
| `monitorId` | the monitor (competitor) — but prefer `metadata.competitor` for identity |
| `checkId` | the check this page belongs to |
| `url` | the scraped URL |
| `status` | `same` \| `new` \| `changed` \| `removed` \| `error` |
| `previousScrapeId` / `currentScrapeId` | snapshot ids |
| `error` | null unless `status: "error"` |
| `isMeaningful` | mirrors `judgment.meaningful` (present only when judged) |
| `judgment` | present **only** when `status: "changed"` and judging ran (see below) |
| `diff` | present **only** when `status: "changed"` |

> First-ever check of a URL is `status: "new"` (baseline) — **no `diff`, no `judgment`**. Diffs/judgments appear on the *next* check when content actually changes. Our captured [`samples/monitor.page.example.json`](./samples/monitor.page.example.json) is a baseline `new`.

**`diff`** — `diff.text` is a unified git-style markdown diff (a `diff.json` AST may also be present). Real captured example — Housecall Pro newsroom, judged **not meaningful** (the judge correctly filtering noise); full payload in [`samples/monitor.page.changed.example.json`](./samples/monitor.page.changed.example.json):

```json
{
  "status": "changed",
  "judgment": {
    "meaningful": false,
    "confidence": "high",
    "reason": "Updated session/tracking parameters in URLs and removal of external press links — e.g. 'How Good Guy Plumbing Uses AI to Enhance Customer Care' — are industry thought-leadership / social-proof items which the goal explicitly states are not meaningful. No new AI features or product expansions were announced."
  },
  "diff": { "text": "--- previous\n+++ current\n-[Get TradeWire](https://…?hcp_session_uuid=e8a2a01f…)\n+[Get TradeWire](https://…?hcp_session_uuid=32c680dc…)\n…" }
}
```

> A genuine `meaningful: true` example will be dropped in when a real AI launch lands — our first scheduled run produced no true-positive (see [`signal-validation.md`](./signal-validation.md)).

**Observed in practice (first scheduled checks, 2026-06-09):**
- **Tracking-param churn is the dominant noise.** Pages flip to `changed` every check purely from rotating `hcp_session_uuid` / `anonymous_id` in signup links. The judge filters these as not-meaningful (high confidence), but each still costs a judge credit. Future tweak: strip query params / exclude those blocks via scrape options.
- **Judge reliability.** One judge call failed transiently and **defaulted to `meaningful: true` with `confidence: low`** ("Judge call failed — defaulting to meaningful"). The agent should treat **low-confidence `meaningful`** as suspect and rely on its web-verify step.

**`judgment`** (Stage-1 judge output — fixed schema):
- `meaningful` (bool), `confidence` (`high` \| `medium` \| `low`), `reason` (free text — per our goal it states **net-new vs expansion vs pre-announcement**), `meaningfulChanges[]` (`{ type: added|changed|removed, before?, after?, reason }`).

### `monitor.check.completed`

`data[].summary`: `{ totalPages, same, changed, new, removed, error }`. Good as the trigger boundary for the daily batch. Sample: [`samples/monitor.check.completed.example.json`](./samples/monitor.check.completed.example.json).

## Metadata contract (what we attach)

We attach `webhook.metadata` per monitor; Firecrawl echoes it verbatim in **both** events' top-level `metadata`. Firecrawl documents only flat string values, so maps/lists are encoded as strings.

| Key | Example | Notes |
|---|---|---|
| `source` | `comp-intel` | namespacing |
| `schemaVersion` | `1` | bump if these keys change |
| `competitor` | `housecall-pro` | **canonical competitor id** |
| `competitorName` | `Housecall Pro` | display name |
| `tier` | `Major` | from MVP §5 |
| `category` | `FSM Platform` | from MVP §5 |
| `knownAiProducts` | `CSR AI, AI Team, …` | CSV |
| `surfaces` | `{"https://…/pricing/":"pricing", …}` | **JSON string** url→surface |

Defined in [`../src/monitors/pilot.ts`](../src/monitors/pilot.ts) (`buildMetadata`).

## Agent input contract (for 2.x)

When the agent drains the queue, per `monitor.page` entry:

1. **Identify competitor** → `metadata.competitor` / `metadata.competitorName` (do **not** rely on `monitorId`).
2. **Identify surface** → `JSON.parse(metadata.surfaces)[entry.url]` (e.g. `changelog`, `ai`, `pricing`); fall back to inferring from the URL.
3. **Act-on rule** → process an entry only when `status === "changed"` **and** `judgment.meaningful === true`. Ignore `same` and baseline `new`. Treat `removed` as a possible signal (page/section pulled); log `error` for ops.
4. **Read** → `url`, `diff.text`, `judgment.{confidence,reason,meaningfulChanges}`, plus `metadata.{tier,category,knownAiProducts}` for context.
5. **Then** (agent's job, §4): web-verify, dedupe against Memory, and record the structured tag **new / expansion / rebrand / announcement-only** (the judge only hints at this in `reason`), significance, and source URL.

**Not in the payload:** monitor `name`, timestamps, the monitor's `goal`. If needed, fetch via `GET /v2/monitor/{monitorId}` or `GET /v2/monitor/{monitorId}/checks/{checkId}`; otherwise use the webhook receipt time.

## Credit cost

Scrape monitor = 1 credit / URL / check; judge = +1 / changed page judged. Observed per manual check: ServiceTitan **8**, Jobber **6**, Housecall Pro **6**. Estimated/month at daily cadence: **240 / 180 / 180** (~600 total for the 3-competitor pilot) — comfortably inside the MVP's ~$30–40/mo target, which is scoped for all 15. Per-check actuals are visible via `GET /v2/monitor/{id}/checks/{checkId}` and the dashboard.
