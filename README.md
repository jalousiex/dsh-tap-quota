# dsh-tap-quota

Sidebar quota card for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai): a compact
**2-row** block showing the fixed `总消耗` plus up to three account channels
(CodeBuddy / TraeWork CN / Qoder CN) — remaining amount, unit and a 2px progress bar.

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

Trae has no direct adapter (it needs dsh-tap's device fingerprint headers); that channel is
simply absent when dsh-tap is gone. `sources[]` in the payload says which adapters answered.

Each upstream call carries `AbortSignal.timeout`; the route serves a 30s cache, falls back to
the last good snapshot (`stale: true`), and never throws into the response.

## Card layout rules

- grid, 2 columns, **at most 4 cells**;
- first cell is always `总消耗` (today's share as the bar, totals in the tooltip);
- then up to three channels that have a number **or an `error`**; a channel with no data and
  no error is skipped (no empty placeholders);
- entry order: channel of the model in use (`focus`) → exceeded → lowest remaining ratio →
  most recently called → fixed order `codebuddy/trae/qoder`;
- each cell = one text line (`dot label value unit`) + one 2px bar; limits, pools, update time
  and source live in the cell tooltip;
- CodeBuddy in api-key mode has no numeric quota upstream: it shows `已用 N credits`, or a bar
  when `manualQuotaTotal` is configured (remaining = max(0, manual − consumed));
- the whole card is clickable (force refresh); hidden while the sidebar is collapsed to the rail.

## Routes

- `GET /dsh-tap-quota/snapshot` — `{ ok, at, stale, sources:[{id,ok,ms,error?}], usage:{totalCredit,totalRequests,today,recentModels:[{model,lastTs,calls,credit}]}, channels:[...], focus:{model,channel}|null }`
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
| `diagnostics` | `true` | accept client diagnostic reports |

## Dev

```bash
node --check index.js && node --check lib/client.js
node test/run.mjs     # channel normalization, recentModels, buildSnapshot, pickEntries, DOM-discipline asserts
```

## License

MIT
