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
 *                 CodeBuddy POST https://copilot.tencent.com/billing/meter/get-user-request-usage
 *                            （今日逐条请求流水；见下）
 *               （仅 OAuth；api-key 模式上游没有数值配额）
 *               Trae 没有直连适配器 —— 它需要 dsh-tap 的设备指纹头，
 *               因此该渠道直接缺席，而不是伪造一个数字。
 *
 * ## 今日用量（`billing/meter/get-user-request-usage`）
 *
 * 这是 2026-10-18 实测到的**未知端点**：路径没有 `/v2` 前缀（与资源包的
 * `/v2/billing/meter/get-user-resource` 不是一族），但**用同一个 origin 与
 * 同一个 OAuth bearer 就能通**（copilot.tencent.com 与 www.codebuddy.cn 都 200），
 * 不需要 dsh-tap 的设备指纹头，所以它是 direct 渠道唯一能补上的缺口。
 *
 * 请求体 `{ startTime, endTime, pageNum, pageSize }`，时间格式
 * `"YYYY-MM-DD HH:mm:ss"`（本地日界）。响应 `data.data[]` 是逐条请求流水：
 *   { requestId, credit, model, client, requestTime, input, inputTrunc,
 *     agentPurpose, appType }
 * `data.total` 是服务端对当页/总量给出的计数。
 *
 * 为什么值得单独取：本地 dsh-tap 的用量表（core/usage-meter.js）只记
 * **经本进程发出的**请求，且只有 SSE 带回 usage 的才算；这个端点是
 * **服务端口径**，包含别的客户端（IDE 插件、WorkBuddy）在同一账号下的
 * 请求。两者不一致是正常的，所以快照里**两个都给**，各自标明来源，
 * 绝不互相覆盖或相加。
 *
 * ## DSH 内置余量（账号余额）
 *
 * 从宿主服务 `deepseekAccount.getBalance()` 取 —— 就是「设置 → 账号与余额」
 * 显示的那份数据（充值余额 + 赠金余额）。**不另算、不合并、不估算**：
 * 内置显示怎么分，这里就怎么分；取不到服务就整行不显示。
 * `getBalance` 需要一份 ClientMetadata（version/locale/timezone），它只被
 * 拼成 Platform 的 `x-client-*` 标识头，不参与鉴权；宿主侧用本机时区与
 * ICU 语言拼出来即可。
 * 余额一律以**十进制字符串**原样透传（内置 formatBalance 用 Big 做
 * roundDown），浏览器端按同一套规则格式化 —— 先转 Number 会把 12.34
 * 变成 12.339999，最后一位就漂了。
 *
 * 硬规则（踩过的坑，别改回去）：
 *   · 每次上游请求都带 AbortSignal.timeout —— 上游挂住绝不把路由挂住。
 *   · 路由走 30 秒缓存，刷新失败时发**上一份好数据**（stale:true），
 *     从不把异常抛进响应。
 *   · 绝不回传任何机密：只回数字、标签、单位与一条 error 字符串。
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

const SNAPSHOT = '/dsh-tap-quota/snapshot'
const DIAG = '/dsh-tap-quota/diag'
const QODER_BASE = 'https://openapi.qoder.com.cn'
const CODEBUDDY_BASE = 'https://copilot.tencent.com'
/** 用量条目早于这个时长，就不算「当前在用的模型」。 */
const FOCUS_WINDOW_MS = 15 * 60 * 1000
/**
 * 今日流水一页取多少条。**仍是一页，不翻页**（翻页会把快照变成 N 次上游往返，
 * 同源 HTTP/1.1 只有 6 条连接）；只是把页大小放大到实测可用的上限：
 * 2026-10-18 实测 pageSize 200/500/1000 都返回完整当天流水（135 条全给），
 * 100 条才会被截。500 条一天够用，真超了照样老实标 `≥`。
 */
const TODAY_PAGE_SIZE = 500
/** 本地日的起点时间戳（与 core/usage-meter.js 的 dayKey 同口径）。 */
function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
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
  /** 是否查询服务端口径的今日用量（get-user-request-usage）。 */
  todayUsage: z.boolean().default(true),
  /** 是否查询 DSH 内置账号余额（deepseekAccount.getBalance，与「设置 → 账号与余额」同源）。 */
  accountBalance: z.boolean().default(true),
  diagnostics: z.boolean().default(true),
})

export const name = 'dsh-tap-quota'

/** DSH 版本：只填 Platform 的 `x-client-version` 标识头（内置客户端也只把它当标识）。 */
function resolveClientVersion() {
  for (const key of ['DSH_CLIENT_VERSION', 'DSH_VERSION']) {
    const value = process.env[key]
    if (typeof value === 'string' && value) return value
  }
  // Desktop: <app>/resources/app.asar/package.json 的 version 与内置客户端内联的
  // DSH_CLIENT_VERSION 是同一个值（2026-10 实测 0.2.1-rc.2）。
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'app.asar', 'package.json'))
  }
  if (typeof process.execPath === 'string' && process.execPath) {
    candidates.push(join(dirname(process.execPath), 'resources', 'app.asar', 'package.json'))
  }
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'))
      if (typeof pkg?.version === 'string' && pkg.version) return pkg.version
    } catch {
      // 非 Electron 宿主（dsh web 直跑）读不到 asar，继续下一个候选
    }
  }
  return '0.0.0'
}

const CLIENT_VERSION = resolveClientVersion()

/** Platform 只取语言主标签（zh → zh_CN），宿主用 ICU 的默认区域即可。 */
function hostLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
  } catch {
    return 'en-US'
  }
}

/** 与内置 accountClientMetadata 同口径：东八区为 +28800。 */
function accountClientMetadata() {
  return {
    version: CLIENT_VERSION,
    locale: hostLocale(),
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

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
const roundCredit = (n) => Math.round(n * 10000) / 10000

/**
 * 今日请求流水的请求体时间格式："YYYY-MM-DD HH:mm:ss"（本地日界）。
 * 上游按这个字面格式解析，用 toISOString 会拿到别的东西。
 */
function stampLocal(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

/**
 * 归一化服务端口径的今日用量（get-user-request-usage 的一页）。
 *
 * 只累加本页的行——**不翻页**：该接口按日查询，一天上千页的情况不存在，
 * 而翻页会把每条快照变成 N 次上游往返（同源 HTTP/1.1 只有 6 条连接）。
 * 因此 `truncated` 如实标出"取到的行数 >= 服务端报的总量吗"，
 * 让 UI 能说"≥N 次"而不是假装数字是完整的。
 */
export function parseTodayUsage(body) {
  if (!body || body.code !== 0) return null
  const data = body.data && typeof body.data === 'object' ? body.data : null
  if (!data) return null
  const rows = Array.isArray(data.data) ? data.data : []
  let credit = 0
  const byModel = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const c = Number(row.credit)
    if (Number.isFinite(c)) credit = roundCredit(credit + c)
    const model = typeof row.model === 'string' && row.model ? row.model : null
    if (!model) continue
    const prev = byModel.get(model)
    if (prev) {
      prev.requests += 1
      prev.credit = roundCredit(prev.credit + (Number.isFinite(c) ? c : 0))
    } else {
      byModel.set(model, { model, requests: 1, credit: Number.isFinite(c) ? roundCredit(c) : 0 })
    }
  }
  const total = Number.isFinite(Number(data.total)) ? Number(data.total) : null
  return {
    requests: rows.length,
    // 服务端报的总量 > 本页行数 = 被截断了；UI 据此显示"≥"。
    truncated: total != null && total > rows.length,
    serverTotal: total,
    credit: roundCredit(credit),
    models: [...byModel.values()].sort((a, b) => b.requests - a.requests).slice(0, 5),
  }
}

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

/**
 * 归一化内置账号余额（deepseekAccount.getBalance）。
 *
 * 与内置「账号与余额」页同一份数据、同一套口径：`value` = 充值余额，
 * `bonusWallets` = 赠金余额，**分开给、不相加**。金额是十进制字符串，
 * 原样保留（见文件头说明），只有币种收窄到 CNY/USD。
 */
export function normalizeAccount(balance) {
  if (balance === null || balance === undefined) {
    return { ok: false, error: 'signed-out', wallets: [], bonusWallets: [] }
  }
  if (balance.status !== 'ready') {
    return { ok: false, error: 'read-failed', wallets: [], bonusWallets: [] }
  }
  const pick = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((w) => w && typeof w.balance === 'string' && (w.currency === 'CNY' || w.currency === 'USD'))
      .map((w) => ({ currency: w.currency, balance: w.balance }))
  return { ok: true, wallets: pick(balance.value), bonusWallets: pick(balance.bonusWallets) }
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
    // 今日用量（服务端口径）独立于本地用量表：dsh-tap 缺席时这一份仍然要能显示，
    // 所以「有本地用量」或「有今日流水」任一边成立就给出 usage 块。
    usage: usage || parts.todayUsage
      ? {
          // 本地用量表缺席时留 null（不知道），不要伪造成 0。
          totalCredit: usage && Number.isFinite(usage.totalCredit) ? usage.totalCredit : null,
          totalRequests: usage && Number.isFinite(usage.totalRequests) ? usage.totalRequests : null,
          // 本地口径：dsh-tap 用量表记的（只有经本进程且带回 usage 的请求）。
          today: usage?.today ?? null,
          // 服务端口径：get-user-request-usage（含别的客户端）。两者分开给，
          // 绝不互相覆盖或相加 —— 对不上是正常的，不是 bug。
          todayUpstream: parts.todayUsage ?? null,
          recentModels: usage ? recentModels(usage) : [],
        }
      : null,
    channels,
    focus: usage ? focusOf(usage, now) : null,
    // 内置账号余额：null = 没查/没服务/关掉，客户端整行不渲染。
    account: parts.account ?? null,
  }
}

export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 6000
  const cacheMs = Number.isFinite(config.cacheMs) ? config.cacheMs : 30000
  const manualQuotaTotal = Number.isFinite(config.manualQuotaTotal) ? config.manualQuotaTotal : 0
  const diagnostics = config.diagnostics !== false
  const useTodayUsage = config.todayUsage !== false
  const useAccount = config.accountBalance !== false

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
    const out = { via: 'direct', ms: 0, usage: null, codebuddyQuota: null, qoderQuota: null, traeQuota: null, todayUsage: null }
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
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'content-type': 'application/json' }
        // 资源包与今日流水共用一次凭据读取、两个端点（流水是增强，
        // 失败只留 consologue，资源包照常返回）。
        const [resRes, usageRes] = await Promise.all([
          fetch(`${CODEBUDDY_BASE}/billing/meter/get-user-resource`, {
            method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(timeoutMs),
          }).catch(() => null),
          useTodayUsage
            ? fetch(`${CODEBUDDY_BASE}/billing/meter/get-user-request-usage`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  startTime: stampLocal(new Date(startOfDay(Date.now()))),
                  endTime: stampLocal(new Date()),
                  pageNum: 1,
                  pageSize: TODAY_PAGE_SIZE,
                }),
                signal: AbortSignal.timeout(timeoutMs),
              }).catch(() => null)
            : Promise.resolve(null),
        ])
        if (resRes) {
          const body = await resRes.json().catch(() => null)
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
            out.codebuddyQuota = { error: `codebuddy-http-${resRes.status}`, numericQuota: false }
          }
        } else {
          out.codebuddyQuota = { error: 'codebuddy-network', numericQuota: false }
        }
        if (usageRes) {
          const body = await usageRes.json().catch(() => null)
          const parsed = parseTodayUsage(body)
          if (parsed) {
            out.todayUsage = parsed
          } else {
            // 端点在了但没解析出数据：如实记下，UI 不加"≥"以外的东西。
            out.todayUsage = { requests: 0, credit: 0, models: [], truncated: false, serverTotal: null, error: `usage-http-${usageRes.status}` }
          }
        }
      }
    } catch (error) {
      out.codebuddyQuota = { error: String(error?.message ?? error), numericQuota: false }
    }
    out.ms = Date.now() - started
    return out
  }

  /**
   * 只取今日流水（与 viaDirect 内部同一套逻辑，但独立成一支，
   * 这样 tap-route 胜出时也能拿到它）。上游挂住有超时兜底。
   */
  async function fetchTodayUsage() {
    const started = Date.now()
    const auth = await readJson(join(dshHome(), 'codebuddy-plugin-auth.json'))
    const token = auth?.auth?.accessToken
    if (typeof token !== 'string' || !token) return null
    const res = await fetch(`${CODEBUDDY_BASE}/billing/meter/get-user-request-usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        startTime: stampLocal(new Date(startOfDay(Date.now()))),
        endTime: stampLocal(new Date()),
        pageNum: 1,
        pageSize: TODAY_PAGE_SIZE,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.json().catch(() => null)
    const parsed = parseTodayUsage(body)
    if (!parsed) return null
    return { ...parsed, ms: Date.now() - started }
  }

  /**
   * 取 DSH 内置账号余额（与「设置 → 账号与余额」同源）。
   *
   * 服务不是硬依赖：`ctx.get('deepseekAccount')` 取不到就返回 null（客户端整行不显示）。
   * getBalance 内部自带请求超时，这里再兜一层 —— 余额慢绝不拖住整张卡片。
   */
  async function fetchAccount() {
    const service = ctx.get('deepseekAccount')
    if (!service || typeof service.getBalance !== 'function') return null
    const started = Date.now()
    const TIMEOUT = Symbol('account-timeout')
    let timer = null
    try {
      const guard = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
      })
      const balance = await Promise.race([service.getBalance(accountClientMetadata()), guard])
      if (balance === TIMEOUT) {
        return { ok: false, error: 'timeout', wallets: [], bonusWallets: [], ms: Date.now() - started }
      }
      return { ...normalizeAccount(balance), ms: Date.now() - started }
    } finally {
      if (timer) clearTimeout(timer)
    }
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
    // 今日流水是 direct 渠道独有的能力（dsh-tap 没有这个 action），
    // 而 tap-route 通常才是赢家 —— 所以**独立取一次**，不管哪条路胜出都补进去。
    // 内置账号余额与它互不依赖，两者并行；失败只加一条 source 记录，
    // 绝不影响主快照。
    const parallel = []
    if (useTodayUsage) {
      parallel.push(
        fetchTodayUsage()
          .then((value) => ({ id: 'today-usage', ok: value !== null, ms: value?.ms ?? 0, value }))
          .catch((error) => ({ id: 'today-usage', ok: false, error: String(error?.message ?? error), value: null })),
      )
    }
    if (useAccount) {
      parallel.push(
        fetchAccount()
          .then((value) => ({
            id: 'account',
            ok: value !== null && value.ok === true,
            ms: value?.ms ?? 0,
            value,
            // 版本号只进 sources（诊断用），不进 account 结构。
            meta: { version: CLIENT_VERSION },
            error: value && !value.ok ? value.error : undefined,
          }))
          .catch((error) => ({ id: 'account', ok: false, error: String(error?.message ?? error), value: null })),
      )
    }
    let todayUsage = null
    let account = null
    for (const result of await Promise.all(parallel)) {
      if (result.id === 'account') account = result.value
      else todayUsage = result.value
      // 服务不在（account === null 且无错）时不写 source，免得卡片提示里多一条噪声。
      if (result.error || result.value !== null) {
        sources.push({
          id: result.id,
          ok: result.ok,
          ms: result.ms,
          ...(result.meta ?? {}),
          ...(result.error ? { error: result.error } : {}),
        })
      }
    }
    if (tapped) {
      return buildSnapshot(
        { ...tapped, todayUsage, account, sources },
        { manualQuotaTotal, includeDisabledChannels: config.includeDisabledChannels !== false },
      )
    }

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
        // direct 已经取过就别打第二次；只在它没取到时兜底。
        todayUsage: direct?.todayUsage ?? null,
        account,
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
    return { ok: false, at: Date.now(), stale: false, sources: [], usage: null, channels: [], focus: null, account: null, error: 'no-source' }
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
          payload = { ok: false, at: Date.now(), sources: [], usage: null, channels: [], focus: null, account: null, error: String(error?.message ?? error) }
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
