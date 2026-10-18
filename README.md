# dsh-tap-quota

Sidebar quota card for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai): a compact
**2-row** block showing the fixed `总消耗` plus up to three account channels
(CodeBuddy / TraeWork CN / Qoder CN) — remaining amount, unit and a 2px progress bar — only.
The DSH built-in balance line lives in `dsh-tweaks` (`sidebarBalance`) instead, because it comes
from a different service; see "Balance moved out" below.

## CodeBuddy numbers: the two accounting scopes (read this before trusting the bar)

`get-user-resource` publishes **two mutually incompatible ledgers**. Mixing them makes the card
look permanently full:

| field | scope | measured behaviour (2026-10-18) |
| --- | --- | --- |
| `cycleRemain` / `cycleUsed` / `cycleSize` | **current cycle** — how much is left this period | live: 529.20 → 455.19 → 249.18 → 235.28 |
| `TotalDosage` (= Σ `CapacityRemain`) | **total per pack** — each pack's remaining grant | live too: 1000 → 955 → 749 → 735 |

Both ledgers move. The gap between them comes from a pack whose current cycle is spent but whose
grant is not: on 2026-10-18 13:44 the 体验版 pack reported `cycleRemain = 0` (500/500 used in the
10-01→10-31 cycle) yet `capacityRemain = 500`, so `TotalDosage` still counted those 500.

The old `codebuddyChannel` took `remain` from the total scope and `limit`/`used` from the cycle
scope. Result on the live account: `remain + used = 1499.82` against `limit = 1000`, so the bar
was always 100 % and the remaining read roughly triple the truth.

**Rule: `remain`, `limit` and `used` must share one scope.** All three now come from the cycle
scope, which answers "how much can I use right now" and is self-consistent
(`cycleRemain + cycleUsed === cycleSize`). A regression test asserts `remain + used === limit`.

The total scope is still reported, as `totalRemain`, **in the tooltip only** — both figures move,
so neither alone is enough: the cycle figure resets (体验版 on 10-31, 裂变包 on 11-17) and the
total figure counts a grant that the current cycle has not touched. Neither is a permanent balance.
`cycleRemain` absent → derive it as `cycleSize - cycleUsed`; cycle scope entirely absent → fall
back to `totalRemain` for older upstreams.

### Tooltips are multi-line, and why they stay native `title`

Every `title` joins its parts with `\n`, so the native tooltip breaks into one item per line.
The previous ` · `-joined single line crammed a dozen fields together and the numbers glued to
their labels; one-per-line is simply readable.

We deliberately do **not** draw our own hover card. Checking the official surfaces: the Slot
catalogue has no tooltip/popover seat at all (only `shell.overlay`, `shell.quota-notice`,
`workspace.toast`), and `sidebar.session.row.hover` — the seat behind the two-line Session rows in
the screenshot — is a *private* occupant of the `ui-workspace` package that you can only fill
inside a card it already owns. It is not a reusable component, and on this machine that package
is not even composed (`status: absent`). So a prettier bubble would have to be hand-built, which
is exactly the surface `dsh-model-info` already got burned by (it needed a global singleton node
filled via `textContent` for XSS safety). Native `title` costs nothing and breaks no DOM
discipline.

### Card layout: two columns, fully transparent

The grid is 2×2: the fixed `总消耗` cell first, then up to three channels. This was briefly
changed to a single-column stack and then reverted — the "wrap" that was wanted is inside the
tooltip, not in the card.

The card has **no background at all** (`background: transparent`, and no hover fill): it sits in
the sidebar where a tinted block just adds visual weight, and a hover fill on a non-interactive
wrapper is a false affordance. The old separator rule above the balance line was dropped for the
same reason.

## Why there is no "今日消耗" number, and why the 用量 button is gone

**设置 → 账号与用量 → 用量明细 is not a readable API, and it cannot be opened from a plugin.**
The shipped `dsh-client-ui-settings-account` README states that Usage uses the Host-provided
`usageUrl` to open a native Platform view authenticated by **the browser's own Platform session**,
and that "the links never carry a DSH token". That view is requested through `PlatformPages`,
which the same README calls *its* private request channel ("its PlatformPages request channel") —
not a public slot and not a Host service. `deepseekAccount` exposes only `getProfile` /
`getBalance` plus sign-in methods; there is no "open page" method in the whole service catalogue,
and the one reachable slot (`account.platform-page`) is that package's **private** occupant —
registering the same id would **replace** the official entry and break the Settings page.

So the only non-destructive route was a plain new tab, i.e. "just opening a web page". The `用量`
button was removed on 2026-10-18 for that reason. `links.usageUrl` is still served so the card
tooltip can point at 设置 → 账号 → 用量, and a future change can reuse it.

The card therefore **never invents a "今日消耗" figure**: the only number available is CodeBuddy's
own ledger, which is a different account than the official DeepSeek bill.

### Balance moved out (2026-10-18)

The DSH built-in balance line is **no longer rendered by this package** — it moved to `dsh-tweaks`
(`sidebarBalance`), which reads it from `deepseekAccount.getBalance` and shows it in the sidebar on
its own line with a right-aligned `⟳`.

Why the split: that balance comes from **DSH's own account service**, while everything on this card
comes from **upstream providers** (CodeBuddy / Trae / Qoder) via dsh-tap's `/settings` route. Two
different services, two different lifetimes — one plugin owning both meant this package was reading
DSH account data it had no business reading. After the split this package touches **no** account
data at all: the snapshot has no `account` or `links` field, and a test asserts those fields and
the related helpers (`getBalance`, `fmtMoney`, `accountRow`, …) never come back.

## Design: one route, adapters, no hard plugin dependency

The browser makes **one** request per poll to `/dsh-tap-quota/snapshot`; the host half fans
out and normalizes. It used to fire three POSTs straight at dsh-tap's private route with no
backoff — a failing or absent dsh-tap left the card blank and every poll burned a connection.

Sources are probed at runtime, per channel:

| adapter | reads | used when |
| --- | --- | --- |
| `tap-route` | `POST /dsh-tap/settings` actions `usage` / `trae-quota` / `qoder-quota` | preferred (reuses dsh-tap's upstream dialects + usage meter) |
| `tap-files` | `~/.dsh/codebuddy-plugin-usage.json` directly | route missing/failing — still shows `总消耗` |
| `direct` | Qoder `GET /api/v2/quota/usage`; CodeBuddy `POST /billing/meter/get-user-resource` (OAuth only) | route missing/failing — credential files read by us |
| `today-usage` | CodeBuddy `POST /billing/meter/get-user-request-usage` (OAuth only) | **always**, alongside whichever source won — this endpoint is not reachable via dsh-tap's route, so it is fetched independently. It also stands on its own: when the local usage meter (`tap-route` / `tap-files`) is missing entirely, the snapshot still carries `usage.todayUpstream` and the card shows `— ·今日 N` instead of dropping the number |

Trae has no direct adapter (it needs dsh-tap's device fingerprint headers); that channel is
simply absent when dsh-tap is gone. `sources[]` in the payload says which adapters answered.

not take the usage link with it.

Each upstream call carries `AbortSignal.timeout`. The route serves a 30s cache and never throws
into the response. `stale: true` now means exactly one thing: **this refresh failed and you are
looking at the previous snapshot.** The old code marked every cache expiry stale and shipped the
old copy while refreshing in the background; since `cacheMs` (30s) is shorter than the client poll
(60s), that fired on 57 of 59 observed polls and the card wore a permanent, misleading 旧数据
badge.

### The route must never outlast the client fetch (8s)

Waiting for a refresh only stays safe if two numbers are kept in order, and both are asserted by a
behavioural test (`上游挂死时仍在客户端 8s 超时内返回`):

1. **all sources are dispatched concurrently.** They used to run in sequence — `viaTapRoute`
   first, then the `parallel` batch — so the worst case was `6s + 6s = 12s`, which always
   exceeded the client's 8s `AbortSignal.timeout`. One hung upstream then turned into a
   `poll-error` and an exponential backoff instead of a quiet stale snapshot. Dispatching
   together makes the worst case the *maximum* of the sources, not the sum.
2. **the wait is hard-bounded** by `DEADLINE_MS` (5000), leaving room for serialisation. On
   expiry the previous snapshot goes out marked `stale: true`. Measured: ~5.0s with every fetch
   hanging.

A static regex over the source can only prove a deadline was *written*; the test hangs `fetch`
and measures the real wall clock, which is how the 12s regression above was caught.

## Card layout rules

- grid, 2 columns, **at most 4 cells**;
- first cell is always `总消耗` (today's share as the bar, totals in the tooltip);
  its visible value now also carries **today's request count** (e.g. `1.6K ·今日 70`),
  and the tooltip reports two counts that must never be merged:
  - **服务端口径** (`get-user-request-usage`) — every request under the account, including
    other clients (IDE plugin, WorkBuddy app). Marked `≥` when the page was truncated
    (`serverTotal > rows.length`); one page of **500** is fetched, never paginated
    (measured 2026-10-18: `pageSize` 200/500/1000 all returned the full day; only 100 truncated),
    so a day beyond 500 requests shows `≥500` rather than pretending the number is complete.
    The tooltip also lists the day's top three models (`今日模型 hy4-preview×135`).
  - **本进程口径** (dsh-tap's usage meter) — only requests this DSH process sent and that
    returned a billing `usage`. The difference between the two is other clients, not a bug.
- then up to three channels that have a number, an `error`, **or a `used` total**; only a
  channel with all three absent is skipped (no empty placeholders). `used` matters because
  api-key mode has no numeric quota upstream (`get-user-resource` is OAuth-only — measured
  `numericQuota: false`), so CodeBuddy would otherwise vanish from the card entirely and show
  only `已用 N`;
- entry order: channel of the model in use (`focus`) → exceeded → lowest remaining ratio →
  most recently called → fixed order `codebuddy/trae/qoder`;
- each cell = one text line (`dot label value unit`) + one 2px bar; limits, pools, update time
  and source live in the cell tooltip;
- CodeBuddy in api-key mode has no numeric quota upstream: it shows `已用 N credits`, or a bar
  when `manualQuotaTotal` is configured (remaining = max(0, manual − consumed));
- the whole card is clickable (force refresh); hidden while the sidebar is collapsed to the rail.

### The card's own refresh button

A small `⟳` sits in the card's **bottom-right corner**, absolutely positioned so it never takes a
grid cell, and it is **hidden until the card is hovered** (`.qw-wrap:hover .qw-refresh`; it also
reveals on `:focus-visible` for keyboard users). Clicking it forces `?refresh=1` and spins the glyph
while the request is in flight.

It deliberately does **not** look like the always-visible `⟳` on the `dsh-tweaks` balance line:
that one belongs to the DSH account balance row, this one only re-reads the upstream channel
quotas. Different owner, different position, different reveal rule — so the two are not confused.
Its click stops propagation so the card-wide handler does not fire a second request.

## Routes

- `GET /dsh-tap-quota/snapshot` — `{ ok, at, stale, sources:[{id,ok,ms,version?,error?}], usage:{totalCredit,totalRequests,today,recentModels,todayUpstream:{requests,truncated,serverTotal,credit,models[]}|null}, channels:[...], focus:{model,channel}|null }`
  - **No `account` / `links` fields**: the built-in balance row moved to `dsh-tweaks`
    (`sidebarBalance`); this snapshot carries upstream channel quotas and the usage meter only.
  - `sources[].version` is the DSH version reported for diagnostics.
  - `stale: true` means **this refresh failed** — you are seeing the previous snapshot.
  - `?refresh=1` bypasses the 30s cache.
- `POST /dsh-tap-quota/diag` — client reports (including a composer focus probe) →
  `~/.dsh/.cache/dsh-tap-quota-client.json` (ring, 60 entries / 64KB). This is how a
  browser-only symptom ("input cannot be focused") gets diagnosed without DevTools:
  `focus.top` / `focus.chain` name the element under the composer centre.

## DOM discipline

The widget is a sibling block injected before the sidebar's `_footArea` (no slot fits:
`sidebar.footer.action` is a flex row shared with dsh-mobile's button). Mounting is
structural and idempotent:

- one bounded structural query to find the foot area; a `childList`-only observer on its
  parent; a `ResizeObserver` for the collapsed rail (width threshold, not class names);
- no class-attribute observation, no whole-document scans, no feedback loop;
- retry with backoff when the sidebar is not mounted yet; `dispose` removes the card and
  every observer/timer.

## Config

| key | default | meaning |
| --- | --- | --- |
| `requestTimeoutMs` | `6000` | hard deadline per source call |
| `cacheMs` | `30000` | snapshot cache lifetime (client polls every 60s) |
| `manualQuotaTotal` | `0` | api-key mode estimate budget (0 = no estimate) |
| `includeDisabledChannels` | `true` | include channels that report an error (signed out / disabled) |
| `todayUsage` | `true` | query the server-side today request log (`get-user-request-usage`) |
| `diagnostics` | `true` | accept client diagnostic reports |

## Dev

```bash
node --check index.js && node --check lib/client.js
node test/run.mjs     # channel normalization, recentModels, buildSnapshot, pickEntries, DOM-discipline asserts,
                      # and the route-deadline behavioural check (hangs fetch, measures wall clock)
```

## License

MIT
