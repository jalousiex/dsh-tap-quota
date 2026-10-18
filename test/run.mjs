/**
 * Standalone checks for dsh-tap-quota (no deps; runs outside a dsh profile).
 *
 *   node test/run.mjs
 *
 * Host pure helpers (channel normalization, recent-model ranking) are read out
 * of index.js with its imports stripped; the browser half's entry picker is
 * read out of lib/client.js through a fake window.__ModuleLoader__.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
  }
}
function ok(name, cond) {
  check(name, cond === true, true)
}

// ── host half ────────────────────────────────────────────────────────────
const hostSource = readFileSync(join(root, 'index.js'), 'utf8')
  .replace(
    /^import z from '@deepseek-ai\/schemastery'$/m,
    'const z = new Proxy(function () {}, { get: () => z, apply: () => z })',
  )
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')

const hostCtx = {
  console,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  // 宿主半的 import 被剥掉了，这里补上顶层求值会用到的几个：
  join: (...parts) => parts.join('/'),
  dirname: (p) => p,
  readFileSync: () => {
    throw new Error('no-fs-in-harness')
  },
}
vm.createContext(hostCtx)
vm.runInContext(
  hostSource +
    '\n;globalThis.__host = { recentModels, codebuddyChannel, traeChannel, qoderChannel, focusOf, buildSnapshot, parseTodayUsage, stampLocal, startOfDay };',
  hostCtx,
)
const {
  recentModels,
  codebuddyChannel,
  traeChannel,
  qoderChannel,
  focusOf,
  buildSnapshot,
  parseTodayUsage,
  stampLocal,
  startOfDay,
} = hostCtx.__host

const NOW = 1792207310000
const usage = {
  totalCredit: 1568.5883,
  totalRequests: 1830,
  today: { credit: 267.7985, requests: 1147 },
  recent: [
    { ts: NOW - 5 * 60000, kind: 'chat', model: 'step-5-preview', credit: 0 },
    { ts: NOW - 2 * 60000, kind: 'chat', model: 'step-5-preview', credit: 0 },
    { ts: NOW - 1 * 60000, kind: 'title', model: 'qfmodel', credit: 0 },
    { ts: NOW - 60000, kind: 'chat', model: 'hy3', credit: 1.5 },
  ],
}

console.log('recentModels:')
check('groups chat rows, newest first', recentModels(usage).map((r) => [r.model, r.calls]), [
  ['hy3', 1],
  ['step-5-preview', 2],
])
check('title rows ignored', recentModels(usage).find((r) => r.model === 'qfmodel'), undefined)
check('limit applied', recentModels(usage, 1).length, 1)

console.log('focus:')
check('latest chat model', focusOf(usage, NOW), { model: 'hy3', channel: 'codebuddy' })
check('stale usage -> no focus', focusOf(usage, NOW + 30 * 60000), null)

console.log('codebuddyChannel:')
// 口径锁（2026-10-18 修）：remain/limit/used 必须同口径，都取周期口径 CycleCapacity*。
check('numeric resource（周期口径）', codebuddyChannel({ numericQuota: true, resource: { totalRemain: 1000, cycleRemain: 100, cycleSize: 400, cycleUsed: 300 } }, usage, 0), {
  id: 'codebuddy',
  label: 'CodeBuddy',
  unit: 'credits',
  signedIn: true,
  remain: 100,
  limit: 400,
  used: 300,
  totalRemain: 1000,
  exceeded: false,
  tone: 'warn',
  error: null,
})
check('remain+used === limit（同口径自洽）', (() => {
  const c = codebuddyChannel({ numericQuota: true, resource: { totalRemain: 955, cycleRemain: 455.19, cycleSize: 1000, cycleUsed: 544.81 } }, usage, 0)
  return Math.round((c.remain + c.used) * 100) / 100 === c.limit
})(), true)
check('cycleRemain 缺失按 cycleSize-cycleUsed 反推', codebuddyChannel({ numericQuota: true, resource: { totalRemain: 1000, cycleSize: 400, cycleUsed: 300 } }, usage, 0).remain, 100)
check('周期口径全缺才回退 TotalDosage', codebuddyChannel({ numericQuota: true, resource: { totalRemain: 100 } }, usage, 0).remain, 100)
check('manual estimate', codebuddyChannel({ numericQuota: false }, usage, 2000).remain, 431.41)
check('no numeric/no manual -> used only', codebuddyChannel({ numericQuota: false }, usage, 0).tone, 'off')

console.log('traeChannel / qoderChannel:')
check('trae ide pool', traeChannel({ pools: { ide: { limit: 4500, used: 1648.19, remain: 2851.81 }, work: { limit: 0, used: 0, remain: 0 } } }), {
  id: 'trae',
  label: 'Trae',
  unit: 'credits',
  signedIn: true,
  remain: 2851.81,
  limit: 4500,
  used: 1648.19,
  exceeded: false,
  tone: 'ok',
  error: null,
  pools: { ide: { limit: 4500, used: 1648.19, remain: 2851.81 }, work: { limit: 0, used: 0, remain: 0 } },
})
check('qoder exceeded', qoderChannel({ isQuotaExceeded: true, userQuota: { total: 300, used: 300, remaining: 0, unit: 'credits' } }), {
  id: 'qoder',
  label: 'Qoder',
  unit: 'credits',
  signedIn: true,
  remain: 0,
  limit: 300,
  used: 300,
  exceeded: true,
  tone: 'err',
  error: null,
})

console.log('stampLocal / startOfDay:')
check('本地日界时间戳', new Date(startOfDay(NOW)).getHours(), 0)
check('stampLocal 格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stampLocal(new Date(NOW))), true)
check('stampLocal 补零', stampLocal(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05')

console.log('parseTodayUsage:')
check('code 非 0 -> null', parseTodayUsage({ code: 1 }), null)
check('无 data -> null', parseTodayUsage({ code: 0 }), null)
check(
  '按模型聚合 + 累加',
  parseTodayUsage({
    code: 0,
    data: {
      total: 3,
      data: [
        { requestId: 'a', credit: 0.5, model: 'hy4-preview', client: 'CLI', requestTime: '2026-10-18 01:00:00' },
        { requestId: 'b', credit: 0.25, model: 'hy4-preview', client: 'CLI', requestTime: '2026-10-18 02:00:00' },
        { requestId: 'c', credit: 0, model: 'hy3', client: 'CLI', requestTime: '2026-10-18 03:00:00' },
      ],
    },
  }),
  {
    requests: 3,
    truncated: false,
    serverTotal: 3,
    credit: 0.75,
    models: [
      { model: 'hy4-preview', requests: 2, credit: 0.75 },
      { model: 'hy3', requests: 1, credit: 0 },
    ],
  },
)
check('服务端总量 > 本页 -> truncated', parseTodayUsage({ code: 0, data: { total: 500, data: [{ model: 'x', credit: 0 }] } }).truncated, true)
check('无 model 的行只计次数不进 models', parseTodayUsage({ code: 0, data: { total: 1, data: [{ credit: 1 }] } }).models, [])
check('credit 缺失按 0', parseTodayUsage({ code: 0, data: { total: 1, data: [{ model: 'x' }] } }).credit, 0)

console.log('buildSnapshot:')
const snap = buildSnapshot(
  {
    usage,
    codebuddyQuota: { numericQuota: true, resource: { totalRemain: 100, cycleSize: 400, cycleUsed: 300 } },
    traeQuota: { pools: { ide: { limit: 4500, used: 1648.19, remain: 2851.81 } } },
    qoderQuota: { isQuotaExceeded: true, userQuota: { total: 300, used: 300, remaining: 0, unit: 'credits' } },
    sources: [{ id: 'tap-route', ok: true, ms: 120 }],
  },
  { manualQuotaTotal: 0, includeDisabledChannels: true },
  NOW,
)
check('snapshot channels', snap.channels.map((c) => c.id), ['codebuddy', 'trae', 'qoder'])
check('snapshot usage totals', [snap.usage.totalCredit, snap.usage.totalRequests], [1568.5883, 1830])
check('snapshot focus', snap.focus, { model: 'hy3', channel: 'codebuddy' })

console.log('buildSnapshot with todayUsage:')
const snap2b = buildSnapshot(
  {
    usage,
    codebuddyQuota: { numericQuota: true, resource: { totalRemain: 100, cycleSize: 400, cycleUsed: 300 } },
    todayUsage: { requests: 70, credit: 0, models: [{ model: 'hy4-preview', requests: 70, credit: 0 }], truncated: false, serverTotal: 70, ms: 42 },
    sources: [{ id: 'tap-route', ok: true, ms: 120 }, { id: 'today-usage', ok: true, ms: 42 }],
  },
  { manualQuotaTotal: 0, includeDisabledChannels: true },
  NOW,
)
check('todayUpstream 透传到 usage', snap2b.usage.todayUpstream.requests, 70)
check('todayUpstream models 透传', snap2b.usage.todayUpstream.models[0].model, 'hy4-preview')
check('todayUsage 缺失时为 null', buildSnapshot({ usage, sources: [] }, {}, NOW).usage.todayUpstream, null)

console.log('今日用量独立于本地用量表（dsh-tap 缺席）:')
const snapTodayOnly = buildSnapshot(
  { usage: null, todayUsage: { requests: 135, credit: 0, models: [{ model: 'hy4-preview', requests: 135, credit: 0 }], truncated: false, serverTotal: 135 } },
  {},
  NOW,
)
check('没有本地用量表也保留 todayUpstream', snapTodayOnly.usage.todayUpstream.requests, 135)
check('累计值缺席 -> null（不伪造 0）', [snapTodayOnly.usage.totalCredit, snapTodayOnly.usage.totalRequests], [null, null])
check('recentModels 缺席 -> 空数组', snapTodayOnly.usage.recentModels, [])
check('本地用量表缺席时不产生 focus', snapTodayOnly.focus, null)
check('两边都没有 -> usage 为 null', buildSnapshot({ usage: null, sources: [] }, {}, NOW).usage, null)

console.log('余额行已迁出（本包不再碰 DSH 账号数据）:')
{
  const snap = buildSnapshot({ usage, sources: [] }, {}, NOW)
  check('快照没有 account 字段', 'account' in snap, false)
  check('快照没有 links 字段', 'links' in snap, false)
  // 死代码护栏：这些符号一旦回来，说明余额又被塞进了本包。
  // 只查「代码里出现」（排除注释行），因为文件头会解释性地提到这些名字。
  // 客户端半的对应检查在 loader 之后（clientSource 那时才就绪）。
  const hostCode = hostSource.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  for (const sym of ['normalizeAccount', 'fetchAccount', 'accountClientMetadata', 'deepseekAccount', 'getBalance']) {
    ok(`代码里不含 ${sym}`, !new RegExp('\\b' + sym + '\\b').test(hostCode))
  }
}

// ── browser half ─────────────────────────────────────────────────────────
/** 最小 DOM 桩：只实现卡片用到的属性，够跑 buildWidget/render 的真实路径。 */
function stubDom() {
  const make = (tag) => ({
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    title: '',
    textContent: '',
    children: [],
    setAttribute() {},
    addEventListener() {},
    appendChild(child) {
      this.children.push(child)
      return child
    },
  })
  const document = {
    createElement: (tag) => make(tag),
    querySelector: () => null,
    head: make('head'),
  }
  return document
}

function loadClient(path, extraGlobals) {
  const src = readFileSync(path, 'utf8')
  let def = null
  const ctx = {
    console,
    ...extraGlobals,
    window: {
      __ModuleLoader__: {
        load(d) {
          def = d
        },
      },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  if (!def) throw new Error('client did not call __ModuleLoader__.load')
  return def.factory(function () {
    throw new Error('client must not require modules')
  }).__internals
}

const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const client = loadClient(join(root, 'lib', 'client.js'))

console.log('fmt / pctOf / fmt4:')
check('fmt 2851.81', client.fmt(2851.81), '2.9K')
check('fmt 1568.5883', client.fmt(1568.5883), '1.6K')
check('fmt 0', client.fmt(0), '0')
check('fmt null', client.fmt(null), '—')
check('fmt4 0.75', client.fmt4(0.75), '0.75')
check('fmt4 0', client.fmt4(0), '0')
check('fmt4 0.005', client.fmt4(0.005), '0.005')
check('fmt4 1234', client.fmt4(1234), '1.2K')
check('pctOf 2851.81/4500', client.pctOf(2851.81, 4500), 63)
check('pctOf clamps', client.pctOf(-5, 100), 0)
check('pctOf no limit', client.pctOf(5, null), null)

console.log('pickEntries:')
const none = client.pickEntries({ usage: null, channels: [], focus: null })
check('empty snapshot -> total only', none.length, 1)
check('total cell is fixed first', none[0].key, 'total')

const snap2 = {
  usage: { totalCredit: 1568.5883, totalRequests: 1830, today: { credit: 267.7985 } },
  channels: [
    { id: 'codebuddy', label: 'CodeBuddy', remain: 100, limit: 400, used: 300, tone: 'warn', unit: 'credits' },
    { id: 'trae', label: 'Trae', remain: 2851.81, limit: 4500, used: 1648.19, tone: 'ok', unit: 'credits' },
    { id: 'qoder', label: 'Qoder', remain: 0, limit: 300, used: 300, tone: 'err', exceeded: true, unit: 'credits' },
  ],
  focus: null,
}
const cells = client.pickEntries(snap2)
check('at most 4 cells', cells.length, 4)
check('total first, then exceeded channel', cells.map((c) => c.key), ['total', 'qoder', 'codebuddy', 'trae'])
check('qoder value has no unit suffix', cells[1].value, '0')
check('qoder title keeps the unit', /credits/.test(cells[1].title), true)
check('total value has no unit suffix', /credits/.test(cells[0].value), false)
check('total title keeps the unit', /credits/.test(cells[0].title), true)
check('qoder bar is 0%', cells[1].pct, 0)

const focused = client.pickEntries({ ...snap2, focus: { model: 'hy3', channel: 'codebuddy' } })
check('focus pins its channel', focused.map((c) => c.key).slice(0, 2), ['total', 'codebuddy'])

const four = client.pickEntries({
  usage: snap2.usage,
  channels: [
    ...snap2.channels,
    { id: 'extra', label: 'Extra', remain: 5, limit: 10, tone: 'warn', unit: 'credits' },
  ],
  focus: null,
})
check('trims to 3 channels + total', four.length, 4)
ok('unavailable channel skipped', client.pickEntries({ usage: null, channels: [{ id: 'x', remain: null, error: null }], focus: null }).length === 1)

console.log('todayCount:')
check('upstream 优先', client.todayCount({ todayUpstream: { requests: 70, credit: 0, truncated: false }, today: { requests: 5, credit: 0 } }), { requests: 70, credit: 0, truncated: false, source: 'upstream', local: 5 })
check('无 upstream 用 local', client.todayCount({ today: { requests: 5, credit: 1.2 } }), { requests: 5, credit: 1.2, truncated: false, source: 'local', local: 5 })
check('upstream 带 error 退回 local', client.todayCount({ todayUpstream: { error: 'x' }, today: { requests: 3, credit: 0 } }), { requests: 3, credit: 0, truncated: false, source: 'local', local: 3 })
check('都没有 -> null', client.todayCount({}), null)
check('truncated 透传', client.todayCount({ todayUpstream: { requests: 100, credit: 0, truncated: true } }).truncated, true)

console.log('totalCell 含今日:')
const tc = client.totalCell({ totalCredit: 100, totalRequests: 50, today: { credit: 5, requests: 10 }, todayUpstream: { requests: 70, credit: 0, truncated: false } })
ok('可见值带今日请求数', /今日 70/.test(tc.value))
ok('tip 标服务端口径', /服务端口径/.test(tc.title))
ok('tip 带今日消耗', /今日消耗/.test(tc.title))
const tc2 = client.totalCell({ totalCredit: 100, today: { credit: 5, requests: 10 } })
ok('只有 local 时 tip 标本进程口径', /本进程口径/.test(tc2.title))

const tc3 = client.totalCell({ totalCredit: null, totalRequests: null, today: null, todayUpstream: { requests: 135, credit: 0, truncated: false, models: [{ model: 'hy4-preview', requests: 135, credit: 0 }] } })
check('累计缺席时可见值为 —，今日仍显示', tc3.value, '—  ·今日 135')
ok('累计缺席时不伪造 0', !/累计/.test(tc3.title))
ok('tip 带今日按模型拆分', /今日模型 hy4-preview×135/.test(tc3.title))

console.log('render（最小 DOM 桩，走真实挂载路径）:')
const domClient = loadClient(join(root, 'lib', 'client.js'), { document: stubDom() })
const widget = domClient.buildWidget()
// 余额行已迁往 dsh-tweaks：本卡片只剩 4 个单元格，不再有 row / rowVal / refreshBtn。
check('卡片是 4 个单元格', widget.cells.length, 4)
ok('不再有余额行节点', widget.row === undefined && widget.rowVal === undefined)
ok('不再有刷新按钮节点（刷新走整卡点击）', widget.refreshBtn === undefined)
domClient.render(widget, { channels: [], usage: null })
ok('渲染不依赖 account 字段', widget.wrap.title.length > 0)

console.log('client static discipline:')
ok('does not observe class', !/attributeFilter:\s*\[\s*["']class["']\s*\]/.test(clientSource))
ok('mount observes childList only', /observer\.observe\(parent,\s*\{\s*childList:\s*true\s*\}\)/.test(clientSource))
ok('no whole-document root scan', !/querySelectorAll\(\'\[class\*="_root"\]\'\)/.test(clientSource))
// 客户端半的死代码护栏：余额渲染符号不该再出现（排除注释行）。
{
  const clientCode = clientSource.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  for (const sym of ['fmtMoney', 'accountRow', 'symbolOf', 'positiveMoney', 'groupDigits', 'qw-row', 'qw-btn']) {
    ok(`客户端代码里不含 ${sym}`, !clientCode.includes(sym))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
