# dsh-tap-quota

Sidebar quota card for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai): a compact
**2-row** block showing the fixed `总消耗` plus up to three account channels
(CodeBuddy / TraeWork CN / Qoder CN) — remaining amount, unit and a 2px progress bar —
followed by one full-width row with **DSH's own built-in balance** (充值余额 / 赠金余额).

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
| `account` | host service `deepseekAccount.getBalance(client)` — the same read behind **设置 → 账号与余额** | when `accountBalance` is on and the service is composed; absent service just hides the row |

Trae has no direct adapter (it needs dsh-tap's device fingerprint headers); that channel is
simply absent when dsh-tap is gone. `sources[]` in the payload says which adapters answered.

The built-in balance is **not** re-derived: `wallet.balance` is a decimal string and it is
passed through untouched (the built-in `formatBalance` rounds *down* with Big; converting to
`Number` first turns `12.34` into `12.339999`). Recharge wallets and bonus wallets stay
separate — they are never summed. `getBalance` only wants ClientMetadata
(`version`/`locale`/`timezoneOffsetSeconds`), which becomes the `x-client-*` identity headers,
never an authorization decision.

Each upstream call carries `AbortSignal.timeout`; the route serves a 30s cache, falls back to
the last good snapshot (`stale: true`), and never throws into the response.

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
- then up to three channels that have a number **or an `error`**; a channel with no data and
  no error is skipped (no empty placeholders);
- entry order: channel of the model in use (`focus`) → exceeded → lowest remaining ratio →
  most recently called → fixed order `codebuddy/trae/qoder`;
- each cell = one text line (`dot label value unit`) + one 2px bar; limits, pools, update time
  and source live in the cell tooltip;
- CodeBuddy in api-key mode has no numeric quota upstream: it shows `已用 N credits`, or a bar
  when `manualQuotaTotal` is configured (remaining = max(0, manual − consumed));
- **one extra full-width row** (`qw-row`, spanning both columns) for DSH's built-in balance:
  `DSH ¥12.34 ·赠 ¥5.00`; only wallets with a non-zero amount are shown, a signed-out account
  reads `未登录`, a failed read reads `—` with the reason in the tooltip. It is hidden entirely
  when the snapshot carries no `account` (older host half or `accountBalance: false`);
- the whole card is clickable (force refresh); hidden while the sidebar is collapsed to the rail.

## Routes

- `GET /dsh-tap-quota/snapshot` — `{ ok, at, stale, sources:[{id,ok,ms,version?,error?}], usage:{totalCredit,totalRequests,today,recentModels,todayUpstream:{requests,truncated,serverTotal,credit,models[]}|null}, channels:[...], focus:{model,channel}|null, account:{ok,wallets:[{currency,balance}],bonusWallets:[...],error?}|null }`
  - `sources[].version` is the DSH version this host sent as `x-client-version` (empty service → no `account` source at all).
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
| `accountBalance` | `true` | read DSH's built-in account balance (`deepseekAccount.getBalance`); `false` hides the extra row |
| `diagnostics` | `true` | accept client diagnostic reports |

## Dev

```bash
node --check index.js && node --check lib/client.js
node test/run.mjs     # channel normalization, recentModels, buildSnapshot, pickEntries, DOM-discipline asserts
```

## License

MIT
