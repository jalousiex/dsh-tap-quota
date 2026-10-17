/**
 * dsh-tap-quota —— 宿主半（host half）。
 *
 * 分工：浏览器端只渲染一张紧凑的两行卡片；**所有数据获取与归一化都在这里**，
 * 由单条 loopback 路由输出。这样浏览器每分钟只发 **一个** 请求。
 * （旧实现让客户端直接向另一个插件的私有路由连发三次 POST，没有退避、
 *  也无法降级——上游一变慢，整个 GUI 都会被拖住。）
 *
 * 数据来源在运行时**按顺序探测、逐渠道降级**，不硬依赖任何单一插件：
 *
 *   tap-route   POST http://127.0.0.1:<webServer.port>/dsh-tap/settings
 *               action 支持 `usage`（用量表 + CodeBuddy 配额）、`trae-quota`、
 *               `qoder-quota`。**首选**：复用 dsh-tap 的上游方言与落盘用量表。
 *   tap-files   直接读 ~/.dsh/codebuddy-plugin-usage.json（有文档的固定结构）。
 *               路由缺失/失败时使用，保证卡片仍能显示累计消耗。
 *   direct      自行读凭据文件并直连上游：
 *                 Qoder     GET  https://openapi.qoder.com.cn/api/v2/quota/usage
 *                 CodeBuddy POST https://copilot.tencent.com/billing/meter/get-user-resource
 *               （仅 OAuth；api-key 模式上游没有数值配额）
 *               Trae 没有直连适配器 —— 它需要 dsh-tap 的设备指纹头，
 *               因此该渠道直接缺席，而不是伪造一个数字。
 *
 * 硬规则（踩过的坑，别改回去）：
 *   · 每次上游请求都带 AbortSignal.timeout —— 上游挂住绝不把路由挂住。
 *   · 路由走 30 秒缓存，刷新失败时发**上一份好数据**（stale:true），
 *     从不把异常抛进响应。
 *   · 绝不回传任何机密：只回数字、标签、单位与一条 error 字符串。
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

const SNAPSHOT = '/dsh-tap-quota/snapshot'
const DIAG = '/dsh-tap-quota/diag'
const QODER_BASE = 'https://openapi.qoder.com.cn'
const CODEBUDDY_BASE = 'https://copilot.tencent.com'
/** 用量条目早于这个时长，就不算「当前在用的模型」。 */
const FOCUS_WINDOW_MS = 15 * 60 * 1000
const DIAG_MAX = 60
const DIAG_MAX_BYTES = 64 * 1024

export const Config = z.object({
  /** 单次数据源调用的硬性超时。 */
  requestTimeoutMs: z.number().step(500).min(1000).default(6000),
  /** 快照缓存存活时长；客户端每 60 秒轮询一次。 */
  cacheMs: z.number().step(1000).min(0).default(30000),
  /** api-key 模式的估算额度（0 = 不估算，只显示已用）。 */
  manualQuotaTotal: z.number().min(0).default(0),
  includeDisabledChannels: z.boolean().default(true),
  diagnostics: z.boolean().default(true),
})

export const name = 'dsh-tap-quota'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function cacheDir() {
  return join(dshHome(), '.cache')
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

const round = (n) => Math.round(n * 100) / 100
const toneOf = (remain, limit) => {
  if (!Number.isFinite(remain) || !Number.isFinite(limit) || limit <= 0) return 'off'
  const pct = remain / limit
  if (pct <= 0) return 'err'
  if (pct < 0.3) return 'warn'
  return 'ok'
}

/** 把用量表里最近的对话记录按模型归并，得出各模型的新近程度。 */
export function recentModels(usage, limit = 6) {
  const rows = Array.isArray(usage?.recent) ? usage.recent : []
  const byModel = new Map()
  for (const row of rows) {
    if (!row || row.kind !== 'chat' || typeof row.model !== 'string' || !row.model) continue
    const prev = byModel.get(row.model)
    const ts = Number.isFinite(row.ts) ? row.ts : 0
    if (!prev) {
      byModel.set(row.model, { model: row.model, lastTs: ts, calls: 1, credit: Number(row.credit) || 0 })
    } else {
      prev.calls += 1
      prev.credit = round(prev.credit + (Number(row.credit) || 0))
      if (ts > prev.lastTs) prev.lastTs = ts
    }
  }
  return [...byModel.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, limit)
}

/** 归一化 CodeBuddy 渠道：数值资源 / 手工估算 / 仅已用，三选一。 */
export function codebuddyChannel(quota, usage, manualTotal) {
  const res = quota?.resource
  const error = typeof quota?.error === 'string' && quota.error ? quota.error : null
  const numeric = quota?.numericQuota === true && res && Number.isFinite(res.totalRemain)
  const base = { id: 'codebuddy', label: 'CodeBuddy', unit: 'credits', signedIn: !error }
  if (numeric) {
    const remain = round(res.totalRemain)
    const limit = Number.isFinite(res.cycleSize) && res.cycleSize > 0 ? round(res.cycleSize) : null
    return {
      ...base,
      remain,
      limit,
      used: Number.isFinite(res.cycleUsed) ? round(res.cycleUsed) : null,
      exceeded: remain <= 0,
      tone: toneOf(remain, limit ?? 0),
      error,
    }
  }
  if (Number.isFinite(manualTotal) && manualTotal > 0) {
    const used = Number.isFinite(usage?.totalCredit) ? usage.totalCredit : 0
    const remain = round(Math.max(0, manualTotal - used))
    return { ...base, remain, limit: round(manualTotal), used: round(used), exceeded: remain <= 0, tone: toneOf(remain, manualTotal), error }
  }
  return { ...base, remain: null, limit: null, used: Number.isFinite(usage?.totalCredit) ? usage.totalCredit : null, exceeded: false, tone: 'off', error }
}

/** 归一化 Trae 渠道（IDE 池为主；工作用量留在池里，不单列）。 */
export function traeChannel(quota) {
  const error = typeof quota?.error === 'string' && quota.error ? quota.error : null
  const ide = quota?.pools?.ide
  const work = quota?.pools?.work
  if (!ide || !Number.isFinite(ide.limit) || ide.limit <= 0) {
    return { id: 'trae', label: 'Trae', unit: 'credits', signedIn: !error, remain: null, limit: null, exceeded: false, tone: 'off', error, pools: quota?.pools ?? null }
  }
  const remain = round(ide.remain)
  const limit = round(ide.limit)
  return { id: 'trae', label: 'Trae', unit: 'credits', signedIn: true, remain, limit, used: round(ide.used), exceeded: remain <= 0, tone: toneOf(remain, limit), error, pools: quota.pools }
}

/** 归一化 Qoder 渠道（用户配额；加购部分留在 tooltip 载荷里，不占主行）。 */
export function qoderChannel(quota) {
  const error = typeof quota?.error === 'string' && quota.error ? quota.error : null
  const user = quota?.userQuota
  if (!user || !Number.isFinite(user.total) || user.total <= 0) {
    return { id: 'qoder', label: 'Qoder', unit: 'credits', signedIn: !error, remain: null, limit: null, exceeded: quota?.isQuotaExceeded === true, tone: 'off', error }
  }
  const remain = Number.isFinite(user.remaining) ? round(user.remaining) : round(user.total - (user.used || 0))
  const limit = round(user.total)
  return {
    id: 'qoder',
    label: 'Qoder',
    unit: typeof user.unit === 'string' && user.unit ? user.unit : 'credits',
    signedIn: true,
    remain,
    limit,
    used: Number.isFinite(user.used) ? round(user.used) : null,
    exceeded: quota?.isQuotaExceeded === true || remain <= 0,
    tone: quota?.isQuotaExceeded === true ? 'err' : toneOf(remain, limit),
    error,
  }
}

/** 最近一次对话请求属于哪个渠道（用量表只覆盖 CodeBuddy）。 */
export function focusOf(usage, now = Date.now()) {
  const rows = Array.isArray(usage?.recent) ? usage.recent : []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!row || row.kind !== 'chat' || typeof row.model !== 'string' || !row.model) continue
    const ts = Number.isFinite(row.ts) ? row.ts : 0
    if (now - ts > FOCUS_WINDOW_MS) return null
    return { model: row.model, channel: 'codebuddy' }
  }
  return null
}

export function buildSnapshot(parts, config, now = Date.now()) {
  const usage = parts.usage ?? null
  const channels = []
  if (parts.codebuddyQuota !== undefined || parts.usageFromFiles) {
    channels.push(codebuddyChannel(parts.codebuddyQuota, usage, config.manualQuotaTotal))
  }
  if (parts.traeQuota && (config.includeDisabledChannels || !parts.traeQuota.error)) {
    channels.push(traeChannel(parts.traeQuota))
  }
  if (parts.qoderQuota && (config.includeDisabledChannels || !parts.qoderQuota.error)) {
    channels.push(qoderChannel(parts.qoderQuota))
  }
  return {
    ok: true,
    at: now,
    stale: parts.stale === true,
    sources: parts.sources ?? [],
    usage: usage
      ? {
          totalCredit: Number.isFinite(usage.totalCredit) ? usage.totalCredit : 0,
          totalRequests: Number.isFinite(usage.totalRequests) ? usage.totalRequests : 0,
          today: usage.today ?? null,
          recentModels: recentModels(usage),
        }
      : null,
    channels,
    focus: usage ? focusOf(usage, now) : null,
  }
}

export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 6000
  const cacheMs = Number.isFinite(config.cacheMs) ? config.cacheMs : 30000
  const manualQuotaTotal = Number.isFinite(config.manualQuotaTotal) ? config.manualQuotaTotal : 0
  const diagnostics = config.diagnostics !== false

  const state = { cache: { at: 0, value: null }, inFlight: null }

  async function postTap(port, action) {
    const res = await fetch(`http://127.0.0.1:${port}/dsh-tap/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`tap-http-${res.status}`)
    const body = await res.json()
    if (!body || body.ok === false) throw new Error(body?.error || 'tap-error')
    return body
  }

  async function viaTapRoute(port) {
    const started = Date.now()
    const [usage, trae, qoder] = await Promise.all([
      postTap(port, 'usage'),
      postTap(port, 'trae-quota').catch((e) => ({ __error: e.message })),
      postTap(port, 'qoder-quota').catch((e) => ({ __error: e.message })),
    ])
    return {
      via: 'tap-route',
      ms: Date.now() - started,
      usage: usage.usage ?? null,
      codebuddyQuota: usage.quota ?? null,
      traeQuota: trae.__error ? { error: trae.__error } : trae.quota ?? null,
      qoderQuota: qoder.__error ? { error: qoder.__error } : qoder.quota ?? null,
    }
  }

  async function viaFiles() {
    const started = Date.now()
    const store = await readJson(join(dshHome(), 'codebuddy-plugin-usage.json'))
    if (!store) return null
    return {
      via: 'tap-files',
      ms: Date.now() - started,
      usage: store,
      usageFromFiles: true,
      codebuddyQuota: { error: 'no-route', numericQuota: false },
    }
  }

  async function viaDirect() {
    const started = Date.now()
    const out = { via: 'direct', ms: 0, usage: null, codebuddyQuota: null, qoderQuota: null, traeQuota: null }
    // Qoder：openapi 面用普通 bearer 鉴权。
    try {
      const auth = await readJson(join(dshHome(), 'qoder-plugin-auth.json'))
      const token = auth?.auth?.accessToken
      if (typeof token === 'string' && token) {
        const res = await fetch(`${QODER_BASE}/api/v2/quota/usage`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        })
        const body = await res.json().catch(() => null)
        out.qoderQuota = res.ok && body ? body : { error: `qoder-http-${res.status}` }
      }
    } catch (error) {
      out.qoderQuota = { error: String(error?.message ?? error) }
    }
    // CodeBuddy 资源接口：只认 OAuth（这族路由用 api-key 会 401）。
    try {
      const auth = await readJson(join(dshHome(), 'codebuddy-plugin-auth.json'))
      const token = auth?.auth?.accessToken
      if (typeof token === 'string' && token) {
        const res = await fetch(`${CODEBUDDY_BASE}/billing/meter/get-user-resource`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(timeoutMs),
        })
        const body = await res.json().catch(() => null)
        const data = body?.code === 0 ? body?.data?.Response?.Data ?? null : null
        if (data) {
          const packs = Array.isArray(data.Accounts) ? data.Accounts : []
          const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
          const sum = (k) => round(packs.reduce((acc, p) => acc + (num(p[k]) ?? 0), 0))
          out.codebuddyQuota = {
            numericQuota: true,
            resource: { totalRemain: num(data.TotalDosage), cycleRemain: sum('CycleCapacityRemainPrecise'), cycleUsed: sum('CycleCapacityUsedPrecise'), cycleSize: sum('CycleCapacitySizePrecise') },
          }
        } else {
          out.codebuddyQuota = { error: `codebuddy-http-${res.status}`, numericQuota: false }
        }
      }
    } catch (error) {
      out.codebuddyQuota = { error: String(error?.message ?? error), numericQuota: false }
    }
    out.ms = Date.now() - started
    return out
  }

  async function collect(port) {
    const sources = []
    let tapped = null
    try {
      tapped = await viaTapRoute(port)
      sources.push({ id: 'tap-route', ok: true, ms: tapped.ms })
    } catch (error) {
      sources.push({ id: 'tap-route', ok: false, error: String(error?.message ?? error) })
    }
    if (tapped) return buildSnapshot({ ...tapped, sources }, { manualQuotaTotal, includeDisabledChannels: config.includeDisabledChannels !== false })

    let files = null
    try {
      files = await viaFiles()
      sources.push({ id: 'tap-files', ok: files !== null, ms: files?.ms ?? 0 })
    } catch (error) {
      sources.push({ id: 'tap-files', ok: false, error: String(error?.message ?? error) })
    }
    let direct = null
    try {
      direct = await viaDirect()
      sources.push({ id: 'direct', ok: direct.qoderQuota !== null || direct.codebuddyQuota !== null, ms: direct.ms })
    } catch (error) {
      sources.push({ id: 'direct', ok: false, error: String(error?.message ?? error) })
    }
    return buildSnapshot(
      {
        usage: files?.usage ?? null,
        usageFromFiles: files?.usageFromFiles === true,
        codebuddyQuota: direct?.codebuddyQuota ?? files?.codebuddyQuota ?? null,
        qoderQuota: direct?.qoderQuota ?? null,
        traeQuota: null,
        sources,
      },
      { manualQuotaTotal, includeDisabledChannels: config.includeDisabledChannels !== false },
    )
  }

  function startRefresh(port) {
    if (state.inFlight) return state.inFlight
    state.inFlight = collect(port)
      .catch(() => null)
      .then((value) => {
        if (value) state.cache = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        state.inFlight = null
      })
    return state.inFlight
  }

  async function snapshot(port, force) {
    const fresh = state.cache.value !== null && Date.now() - state.cache.at < cacheMs
    if (fresh && !force) return state.cache.value
    if (state.cache.value !== null) {
      void startRefresh(port)
      return { ...state.cache.value, stale: true }
    }
    await startRefresh(port)
    if (state.cache.value !== null) return state.cache.value
    return { ok: false, at: Date.now(), stale: false, sources: [], usage: null, channels: [], focus: null, error: 'no-source' }
  }

  async function appendDiagnostic(report) {
    try {
      await mkdir(cacheDir(), { recursive: true })
      const file = join(cacheDir(), 'dsh-tap-quota-client.json')
      let list = []
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        if (Array.isArray(parsed)) list = parsed
      } catch {
        // 首次上报
      }
      list.push({ receivedAt: Date.now(), ...report })
      if (list.length > DIAG_MAX) list = list.slice(-DIAG_MAX)
      while (list.length > 1 && Buffer.byteLength(JSON.stringify(list)) > DIAG_MAX_BYTES) list.shift()
      await writeFile(file, JSON.stringify(list), 'utf8')
    } catch {
      // 尽力而为
    }
  }

  function readBody(request, limit = DIAG_MAX_BYTES) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          request.destroy()
          resolve('')
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      request.on('error', () => resolve(''))
    })
  }

  ctx.inject(['webServer'], (wsctx) => {
    const port = wsctx.webServer.port

    wsctx.webServer.register({
      kind: 'exact',
      path: SNAPSHOT,
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const force = url.searchParams.get('refresh') === '1'
        let payload
        try {
          payload = await snapshot(port, force)
        } catch (error) {
          payload = { ok: false, at: Date.now(), sources: [], usage: null, channels: [], focus: null, error: String(error?.message ?? error) }
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(payload))
      },
    })

    wsctx.webServer.register({
      kind: 'exact',
      path: DIAG,
      handler: async (request, response) => {
        if (diagnostics) {
          try {
            const text = await readBody(request)
            const parsed = text ? JSON.parse(text) : null
            if (parsed && typeof parsed === 'object') await appendDiagnostic(parsed)
          } catch {
            // 忽略格式不正确的上报
          }
        }
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
      },
    })

    void snapshot(port, false).catch(() => {})
  })
}
