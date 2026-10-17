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

const hostCtx = { console, process, Buffer, setTimeout, clearTimeout }
vm.createContext(hostCtx)
vm.runInContext(
  hostSource +
    '\n;globalThis.__host = { recentModels, codebuddyChannel, traeChannel, qoderChannel, focusOf, buildSnapshot };',
  hostCtx,
)
const { recentModels, codebuddyChannel, traeChannel, qoderChannel, focusOf, buildSnapshot } = hostCtx.__host

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
check('numeric resource', codebuddyChannel({ numericQuota: true, resource: { totalRemain: 100, cycleSize: 400, cycleUsed: 300 } }, usage, 0), {
  id: 'codebuddy',
  label: 'CodeBuddy',
  unit: 'credits',
  signedIn: true,
  remain: 100,
  limit: 400,
  used: 300,
  exceeded: false,
  tone: 'warn',
  error: null,
})
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

// ── browser half ─────────────────────────────────────────────────────────
function loadClient(path) {
  const src = readFileSync(path, 'utf8')
  let def = null
  const ctx = {
    console,
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

console.log('fmt / pctOf:')
check('fmt 2851.81', client.fmt(2851.81), '2.9K')
check('fmt 1568.5883', client.fmt(1568.5883), '1.6K')
check('fmt 0', client.fmt(0), '0')
check('fmt null', client.fmt(null), '—')
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

console.log('client static discipline:')
ok('does not observe class', !/attributeFilter:\s*\[\s*["']class["']\s*\]/.test(clientSource))
ok('mount observes childList only', /observer\.observe\(parent,\s*\{\s*childList:\s*true\s*\}\)/.test(clientSource))
ok('no whole-document root scan', !/querySelectorAll\(\'\[class\*="_root"\]\'\)/.test(clientSource))

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
