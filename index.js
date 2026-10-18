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
 * ## 官方用量明细入口（只给链接，不给数字）
 *
 * 「设置 → 账号与用量 → 用量明细」**不是一个可读接口**，而是嵌入的 Platform 网页。
 * 官方 `dsh-client-ui-settings-account/README.md` 明写：Usage 走 `usageUrl` 打开原生
 * Platform 页面、靠**浏览器自身登录态**、链接**不带 DSH token**；宿主服务
 * `deepseekAccount` 也只有 `getProfile` / `getBalance` 两个读接口，没有任何用量明细方法。
 *
 * 所以卡片**不在这里伪造一个「今日消耗」数字**：那只能来自 CodeBuddy 账，
 * 与官方账单不是一回事。
 *
 * 「用量」角标已移除（2026-10-18）：官方那个 Platform 页由 ui-settings-account
 * 经**包内私有**的 `PlatformPages` 请求通道打开，既不是公开 slot 也不是 Host service；
 * 唯一能碰到的 `account.platform-page` 是那个包的私有 occupant，注册同 id 会
 * **替换**掉官方入口。所以要么劫持（破坏性，不做），要么只在新标签页开网页
 * （用户认为「只是弹见面」，已去掉）。
 *
 * ## 余额行已迁出（2026-10-18）
 *
 * 本包**不再读任何 DSH 账号数据**：原先那一行 DSH 余额（deepseekAccount.getBalance）
 * 与其同源的 tooltip 已整体迁到 `dsh-tweaks` 的 `sidebarBalance` 开关。
 * 理由：余额来自 **DSH 内置账号服务**，与本卡片的「上游渠道余量」
 * （CodeBuddy / Trae / Qoder）**不同源**，混在一张卡里语义混乱、权限边界也不清。
 * 快照里因此没有 `account` / `links` 字段了；本包只碰上游渠道的额度。
 *
 * 硬规则（踩过的坑，别改回去）：
 *   · 每次上游请求都带 AbortSignal.timeout —— 上游挂住绝不把路由挂住。
 *   · 缓存过期就**等**刷新（stale 只在刷新失败时为 true），绝不每轮都发旧数据。
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
    diagnostics: z.boolean().default(true),
})

export const name = 'dsh-tap-quota'

/** DSH 版本：既填 Platform 的 `x-client-version` 标识头，也进 sources[] 诊断字段。 */
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

/**
 * 归一化 CodeBuddy 渠道：数值资源 / 手工估算 / 仅已用，三选一。
 *
 * **口径纪律（2026-10-18 实测；结论经两次采样修正）**：
 * `get-user-resource` 同时给两套账，**两套都是实时下降的**：
 *
 *   cycleRemain / cycleUsed / cycleSize   本周期还能用 / 本周期已用 / 本周期配额
 *   totalRemain (TotalDosage = ΣCapacityRemain)   各包剩余总量
 *
 * 同一次账号（13:44）：totalRemain=749、cycleRemain=249.18、cycleUsed=750.82、cycleSize=1000。
 * 差额来自体验版包：本周期（10-01→10-31）已用尽 500/500，cycleRemain=0，
 * 但资源包仍有 500 的**总量**未被本周期消耗，故 totalRemain 里还留着这 500。
 *
 * 旧实现把 remain 取总量口径、limit/used 取周期口径 —— 两套混用，
 * remain+used=1499.82 却标 limit=1000，卡片永远满格、剩余读数偏高。
 *
 * 因此 **remain / limit / used 必须同口径**：一律走周期口径（回答"我现在还能用多少"）。
 * 总量口径另存 `totalRemain`，只进 tooltip —— 周期重置后数字会跳变
 * （体验版 10-31、裂变包 11-17 各重置一次），单看一个数容易困惑。
 */
export function codebuddyChannel(quota, usage, manualTotal) {
  const res = quota?.resource
  const error = typeof quota?.error === 'string' && quota.error ? quota.error : null
  const cycleSize = Number.isFinite(res?.cycleSize) && res.cycleSize > 0 ? res.cycleSize : null
  const cycleUsed = Number.isFinite(res?.cycleUsed) ? res.cycleUsed : null
  const numeric = quota?.numericQuota === true && res
    && (Number.isFinite(res.cycleRemain) || (cycleSize != null && cycleUsed != null) || Number.isFinite(res.totalRemain))
  const base = { id: 'codebuddy', label: 'CodeBuddy', unit: 'credits', signedIn: !error }
  if (numeric) {
    let remain
    if (Number.isFinite(res.cycleRemain)) remain = res.cycleRemain
    else if (cycleSize != null && cycleUsed != null) remain = cycleSize - cycleUsed
    else remain = res.totalRemain
    const limit = cycleSize != null ? round(cycleSize) : null
    return {
      ...base,
      remain: round(remain),
      limit,
      used: cycleUsed != null ? round(cycleUsed) : null,
      // 总量口径（Σ 各包 CapacityRemain）单独带一份，只进 tooltip。
      // 它和周期口径都是实时下降的（2026-10-18 13:44 实测：TotalDosage 749，
      // cycleRemain 249.18，同一时刻），差别在于本周期已用尽的包仍会剩下「总量」——
      // 体验版 10-31 重置、裂变包 11-17 重置，两个数都不等于「永久余额」。
      totalRemain: Number.isFinite(res.totalRemain) ? round(res.totalRemain) : null,
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
    // 余额行已迁往 dsh-tweaks 的 sidebarBalance（余额来自 DSH 内置账号服务，
    // 与本卡片的「上游渠道余量」不同源，分开由各自插件管）。
  }
}

export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 6000
  const cacheMs = Number.isFinite(config.cacheMs) ? config.cacheMs : 30000
  const manualQuotaTotal = Number.isFinite(config.manualQuotaTotal) ? config.manualQuotaTotal : 0
  const diagnostics = config.diagnostics !== false
  const useTodayUsage = config.todayUsage !== false

  const state = { cache: { at: 0, value: null }, inFlight: null, lastRefreshFailed: false }

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

  async function collect(port) {
    const sources = []
    let tapped = null
    // 今日流水是 direct 渠道独有的能力（dsh-tap 没有这个 action），
    // 登录态 / 用量明细链接与它互不依赖 —— 三者一起并发发起。
    //
    // **并发是纪律要求，不是优化**：原先 parallel 在 `await viaTapRoute()` 之后才发起，
    // 于是最坏耗时是 6s + 6s = 12s，超过客户端 8s 的 fetch 超时 —— 上游一挂住，
    // 卡片就会 poll-error 并退避，而不是安静地显示上一份。提前发起后总耗时是三者最大值。
    const parallel = []
    if (useTodayUsage) {
      parallel.push(
        fetchTodayUsage()
          .then((value) => ({ id: 'today-usage', ok: value !== null, ms: value?.ms ?? 0, value }))
          .catch((error) => ({ id: 'today-usage', ok: false, error: String(error?.message ?? error), value: null })),
      )
    }
    // 先挂上刷新结果：tap-route 成功就并入，否则走 files/direct 降级链。
    const tappedPromise = viaTapRoute(port)
      .then((value) => {
        sources.push({ id: 'tap-route', ok: true, ms: value.ms })
        return value
      })
      .catch((error) => {
        sources.push({ id: 'tap-route', ok: false, error: String(error?.message ?? error) })
        return null
      })
    tapped = await tappedPromise
    let todayUsage = null
    for (const result of await Promise.all(parallel)) {
      todayUsage = result.value
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
        { ...tapped, todayUsage, sources },
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
        // stale 的唯一来源：本次刷新没产出快照（collect 抛错或全程无源）。
        state.lastRefreshFailed = value === null
        if (value) state.cache = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        state.inFlight = null
      })
    return state.inFlight
  }

  /**
 * 取一份快照。
 *
 * **stale 的含义只有一个：本次刷新没成功，正在发上一份**（2026-10-18 修正）。
 * 旧实现只要缓存过期就 `void startRefresh()` 并把**上一份**标成 stale 发出去 ——
 * 而 cacheMs(30s) < 客户端轮询(60s)，于是每次轮询都必然走这条路，
 * 实测 59 次轮询里 57 次 stale，卡片长期挂着误导性的「旧数据」。
 *
 * 现在缓存过期就**等**这次刷新；但等待是**有上限的**：客户端 fetch 超时 8s，
 * 所以硬期限取 5s（留足余量给序列化与传输）。到点还没好就发上一份并标 stale ——
 * 这正是 stale 该有的含义：数据没拿到，而不是"缓存刚好过期"。
 * 每个上游自身也带 AbortSignal.timeout(requestTimeoutMs)，两层都不挂路由。
 */
async function snapshot(port, force) {
    const fresh = state.cache.value !== null && Date.now() - state.cache.at < cacheMs
    if (fresh && !force) return state.cache.value
    const DEADLINE_MS = 5000
    let timer = null
    try {
      await Promise.race([
        startRefresh(port),
        new Promise((resolve) => {
          timer = setTimeout(resolve, DEADLINE_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    // 刷新成功：state.cache 已被换成新的，直接发（stale 不适用）。
    if (state.cache.value !== null && !state.lastRefreshFailed) {
      return state.cache.value
    }
    if (state.cache.value !== null) return { ...state.cache.value, stale: true }
    return {
      ok: false,
      at: Date.now(),
      stale: false,
      sources: [],
      usage: null,
      channels: [],
      focus: null,
      error: 'no-source',
    }
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
