/**
 * dsh-tap-quota —— 浏览器半。
 *
 * 职责：在侧边栏渲染一张紧凑的两行配额卡片。
 *
 * 数据：每次轮询只向 `/dsh-tap-quota/snapshot` 发 **一个** 请求
 * （宿主负责扇出到 dsh-tap / 用量表 / 上游，并归一化）。
 * 浏览器不再碰另一个插件的私有路由，因此 dsh-tap 缺失或出错时，
 * 会降级到宿主仍能读到的那部分数据。
 *
 * 展示：**2 列网格**，最多 4 格（固定 `消耗` + 最多三个渠道）。排序依据：
 * 当前所用模型所属渠道 → 已超额 → 剩余比例最低 → 最近调用 → 固定顺序。
 * 其余细节都放进单元格的 tooltip。
 *
 * ⟳ 刷新按钮：**整个卡片右下角**的悬浮角标，默认隐藏、悬停卡片才出现；
 * 绝对定位，不占网格格、不占行高（不要再用 padding-bottom 给它腾地方）。
 * 与 dsh-tweaks 余额行那个常驻 ⟳ 各管各的：它刷 DSH 内置余额，这里只刷上游渠道余量。
 *
 * **卡片上没有「今日消耗」数字**：「用量明细」不是可读接口，而是嵌入的 Platform 网页；
 * 「用量」按钮也已移除 —— 官方那个页由它自己的包内私有通道打开，无法从插件侧调用。
*
 * DOM 纪律（这条是之前卡死的根因，别改回去）：
 *   组件以兄弟块的形式注入到侧边栏底部区域之前（没有合适的 slot：
 *   `sidebar.footer.action` 是与 dsh-mobile 按钮共用的 flex 行）。
 *   挂载是**结构化且幂等**的：一次有界的结构查询、只在底部区域的父节点上
 *   挂 childList 观察器、折叠轨道用 ResizeObserver。
 *   **绝不 observe class 属性、绝不整页扫描、不制造反馈回路。**
 *
 * 诊断：卡片会把一小包 JSON（含输入框聚焦探针）上报给宿主，
 * 这样「输入框点不进去」这类只有浏览器能看到的症状，
 * 可以直接从 ~/.dsh/.cache 读出，不必开 DevTools。
 */


window.__ModuleLoader__.load({
	id: "dsh-tap-quota",
	factory: function (require) {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var ROUTE = "/dsh-tap-quota/snapshot";
		var DIAG = "/dsh-tap-quota/diag";
		var MARK = "data-dsh-tap-quota";
		var POLL_MS = 60000;
		var TIMEOUT_MS = 8000;
		var BACKOFF_MAX_MS = 300000;

		var BG_KEY = "dsh-tap-quota:refresh-bg";
		// 悬停底色：角标压在单元格上，底色必须**跟随卡片实际背景**（深/浅主题不同），
		// 不能写死半透明灰 —— 在本机深色下单看「透明＝看得见」，挪到别的主题就糊成一块。
		var CSS_TEXT = [
			'.qw-wrap{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:3px 6px;width:100%;min-width:0;box-sizing:border-box;margin:3px 0 1px;padding:3px 4px;border-radius:6px;background:transparent;font-size:11px;line-height:1.2;cursor:pointer}',
			'.qw-wrap:hover{background:transparent}',
			'.qw-cell{position:relative;display:block;min-width:0;padding-bottom:3px}',
			'.qw-line{display:flex;align-items:baseline;gap:3px;white-space:nowrap;overflow:hidden}',
			'.qw-dot{width:5px;height:5px;border-radius:50%;flex:0 0 auto;align-self:center}',
			'.qw-dot-ok{background:var(--dsw-alias-state-success-primary,#2a9d4a)}',
			'.qw-dot-warn{background:var(--dsw-alias-state-warn-primary,#b80)}',
			'.qw-dot-err{background:var(--dsw-alias-state-error-primary,#d33)}',
			'.qw-dot-off{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(128,128,128,.45))}',
			'.qw-name{font-weight:600;font-size:10px;color:var(--dsw-alias-label-secondary,inherit);flex:0 0 auto;letter-spacing:.02em}',
			'.qw-val{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis}',
			'.qw-bar{position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.15));overflow:hidden}',
			'.qw-bar>i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,#1a66ff);transition:width .3s ease}',
			'.qw-bar>i.warn{background:var(--dsw-alias-state-warn-primary,#b80)}',
			'.qw-bar>i.err{background:var(--dsw-alias-state-error-primary,#d33)}',
			// 余额行与它的常驻刷新键已迁往 dsh-tweaks 的 sidebarBalance：
			// 余额来自 DSH 内置账号服务，与这里的上游渠道余量不同源，分开由各自插件管。
			// 注意别把旧类名写回代码里——test/run.mjs 有「死符号不许回来」的护栏，
			// 行尾注释也算（护栏只剥整行注释，不剥行尾注释）。
			//
			// 本卡自己的刷新按钮：**悬停在余量卡片上才出现**，属于这张卡自己的数据源。
			// 位置：网格**第一行第二个单元格的右上留白**（绝对定位，不占网格格）；
			// 第二格是句末最短的那格（渠道名+数值），它的横向留白正是按钮的落点——
			// 既不压文字，也不用给卡片额外撑出任何一行（曾用 padding-bottom 撑，白占一行）。
			// 与 dsh-tweaks 余额行那个常驻 ⟳ 各管各的：它刷 DSH 内置余额，这里只刷上游渠道余量。
			'.qw-refresh{position:absolute;top:3px;right:4px;display:inline-flex;align-items:center;justify-content:center;width:14px;height:11px;padding:0;border:0;border-radius:3px;background:var(--dsh-refresh-bg,transparent);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,inherit));opacity:0;transition:opacity .12s ease;font:inherit;font-size:11px;line-height:1;cursor:pointer;pointer-events:none}',
			'.qw-wrap:hover .qw-refresh,.qw-refresh:focus-visible{opacity:.75;pointer-events:auto}',
			'.qw-refresh:hover{opacity:1;--dsh-refresh-bg:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}',
			'.qw-refresh:focus-visible{outline:1px solid var(--dsw-alias-border-focus,var(--dsw-alias-state-business-primary,#1a66ff));outline-offset:1px}',
			'.qw-refresh[disabled]{opacity:.3;cursor:default}',
			'.qw-refresh>i{display:block;line-height:1}',
			// 刷新时转一圈，给个「正在取数」的即时反馈（不依赖文案）。
			'.qw-refresh.busy>i{animation:qw-spin .8s linear infinite}',
			'@keyframes qw-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			var tag = 'style[data-plugin-css="dsh-tap-quota"]';
			var existing = document.querySelector(tag);
			if (existing) {
				if (existing.textContent !== CSS_TEXT) existing.textContent = CSS_TEXT;
				return;
			}
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-tap-quota");
			el.setAttribute("data-plugin-css", "dsh-tap-quota");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}

		// ------------------------------------------------------------------
		// 纯函数辅助（同时导出给 node 测试夹具使用）
		// ------------------------------------------------------------------
		function fmt(n) {
			if (n == null || !isFinite(n)) return "—";
			var v = Number(n);
			if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(1) + "M";
			if (Math.abs(v) >= 100000) return Math.round(v / 1000) + "K";
			if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + "K";
			if (Math.abs(v) >= 100) return String(Math.round(v));
			return String(Math.round(v * 10) / 10);
		}

		/**
		 * 今日用量专用：分档保留小数。今日消耗往往是零点几 credit，
		 * 用 fmt() 会一律显示 "0"，那就等于没显示。
		 */
		function fmt4(n) {
			if (n == null || !isFinite(n)) return "—";
			var v = Number(n);
			var abs = Math.abs(v);
			if (abs >= 1000) return fmt(v);
			if (abs >= 100) return String(Math.round(v));
			if (abs >= 1) return String(Math.round(v * 100) / 100);
			if (abs === 0) return "0";
			return String(Math.round(v * 10000) / 10000);
		}

		function pctOf(remain, limit) {
			if (remain == null || limit == null || !isFinite(remain) || !isFinite(limit) || limit <= 0) return null;
			var p = (remain / limit) * 100;
			if (p < 0) return 0;
			if (p > 100) return 100;
			return Math.round(p);
		}

		/**
		 * 官方用量明细页地址（`links.usageUrl`）。
		 *
		 * **为什么卡片上没有「今日消耗」数字**：设置 → 账号与用量 → 用量明细不是可读接口，
		 * 而是嵌入的 Platform 网页 —— 官方 dsh-client-ui-settings-account README 明写 Usage 走
		 * usageUrl 打开原生页面、靠浏览器自身登录态、链接不带 DSH token；宿主服务
		 * deepseekAccount 也只有 getProfile / getBalance 两个读接口。所以这里只给入口，
		 * 绝不用 CodeBuddy 的账冒充官方账单。
		 *
		 * 未登录 / 链接缺失时返回 null。
		 *
		 * 注意：2026-10-18 已**移除**右下角那个「用量」按钮。官方那个 Platform 页
		 * 由 ui-settings-account 经包内私有通道打开（README：「its PlatformPages
		 * request channel」），不是公开 slot/service，能碰到的 account.platform-page
		 * 又是它的私有 occupant（注册同 id 会替换官方入口）。所以只剩新标签页一种
		 * 非破坏性做法，用户认为那只是"弹见面"，按钮去掉。链接仍随快照下发，
		 * 供 tooltip 指路与日后复用。
		 */
		function usageUrlOf(snap) {
			var url = snap && snap.links ? snap.links.usageUrl : null;
			return typeof url === "string" && url ? url : null;
		}

		// ------------------------------------------------------------------
		// Tooltip（tip）构造
		//
		// **用 `\n` 逐行排，而不是 ` · ` 串成一行**（2026-10-18 改）：
		// 原生 title 属性本身就支持换行，之前用「 · 」连接是把十几项挤成一坨，
		// 数字和标签互相黏住，反而更难读。实测每项一行最清楚。
		//
		// 为什么不用会话列表那种自绘 hover card：查官方 Slots 全树，
		// 没有任何 tooltip/popover 渲染位；`sidebar.session.row.hover` 是
		// ui-workspace 包内部的私有 occupant，只能往它已有的卡片里填空，
		// 不是可复用的公共组件（且本机该包 status: absent 未装载）。
		// 所以这里老老实实用原生 title —— 样式不可美化，但零风险、不碰 DOM 纪律。
		// ------------------------------------------------------------------
		function channelCell(c) {
			var pct = pctOf(c.remain, c.limit);
			var value;
			if (c.remain != null) value = fmt(c.remain);
			else if (c.used != null) value = "已用 " + fmt(c.used);
			else value = "—";
			var lines = [c.label];
			// 双口径：主值是「本周期还能用」，总量口径并列给出。
			// 两者都会实时下降但含义不同（周期重置 vs 资源包总量），所以都报、标明。
			if (c.remain != null && c.limit != null) lines.push("本周期剩 " + fmt(c.remain) + " / " + fmt(c.limit) + " " + (c.unit || ""));
			else if (c.remain != null) lines.push("本周期剩 " + fmt(c.remain) + " " + (c.unit || ""));
			if (c.totalRemain != null && c.totalRemain !== c.remain) lines.push("包总量剩 " + fmt(c.totalRemain) + " " + (c.unit || ""));
			if (c.used != null) lines.push("本周期已用 " + fmt(c.used));
			if (c.exceeded) lines.push("已用尽");
			if (c.pools && c.pools.work) lines.push("Work 池剩余 " + fmt(c.pools.work.remain) + " / " + fmt(c.pools.work.limit));
			if (c.error) lines.push("错误：" + c.error);
			return {
				key: c.id,
				name: c.label,
				value: value,
				pct: pct,
				tone: c.exceeded && pct === 0 ? "err" : c.tone || "off",
				// 逐行：label 一行 + 每个口径/状态各一行。
				title: lines.filter(Boolean).join("\n"),
			};
		}

		/**
		 * 今日请求数：两个口径分开报，绝不混成一个数。
		 *   upstream = 服务端流水（get-user-request-usage），含别的客户端；
		 *   local    = dsh-tap 用量表记的（只有经本进程且带回 usage 的）。
		 * 服务端口径优先显示（它是全量的），本地作为对照留在 tip 里；
		 * 只有本地有时就用本地，并标明它是本进程口径。
		 */
		function todayCount(usage) {
			var up = usage && usage.todayUpstream && !usage.todayUpstream.error ? usage.todayUpstream : null;
			var loc = usage && usage.today && isFinite(usage.today.requests) ? usage.today.requests : null;
			if (up) return { requests: up.requests, credit: isFinite(up.credit) ? up.credit : null, truncated: up.truncated === true, source: "upstream", local: loc };
			if (loc != null) return { requests: loc, credit: usage && usage.today && isFinite(usage.today.credit) ? usage.today.credit : null, truncated: false, source: "local", local: loc };
			return null;
		}

		function totalCell(usage, snap) {
			// 本地用量表可能整块缺席（dsh-tap 不在），此时 totalCredit/totalRequests 是
			// null —— 要显示成“—”，不能 isFinite(null) 当 0 用。
			var total = usage && usage.totalCredit != null && isFinite(usage.totalCredit) ? usage.totalCredit : null;
			var today = usage && usage.today && isFinite(usage.today.credit) ? usage.today.credit : null;
			var reqs = usage && usage.totalRequests != null && isFinite(usage.totalRequests) ? usage.totalRequests : null;
			var td = todayCount(usage);
			var title = [];
			if (total != null) title.push("累计 " + fmt(total) + " credits");
			if (today != null) title.push("今日 " + fmt(today) + " credits");
			if (td) {
				// 截断时标 "≥"，不假装有完整数字。
				title.push("今日请求 " + (td.truncated ? "≥" : "") + td.requests
					+ " 次（" + (td.source === "upstream" ? "服务端口径" : "本进程口径") + "）");
				if (td.credit != null) title.push("今日消耗 " + fmt4(td.credit) + " credits");
				if (td.source === "upstream" && td.local != null && td.local !== td.requests) {
					title.push("其中本进程 " + td.local + " 次");
				}
			}
			// 今日按模型的拆分已经解析好了，放进 tip —— 主行放不下，但值得看一眼。
			var models = usage && usage.todayUpstream && Array.isArray(usage.todayUpstream.models) ? usage.todayUpstream.models : [];
			if (models.length) {
				title.push("今日模型 " + models.slice(0, 3).map(function (m) {
					return m.model + "×" + m.requests;
				}).join(" "));
			}
			if (reqs != null) title.push("累计 " + reqs + " 次请求");
			// 指路：官方用量明细不是可读接口，这里点右下角「用量」打开真账，
			// 而不是在本行拿某个渠道的数字冒充它。
			if (snap && snap.links && snap.links.usageUrl) title.push("官方用量明细见右下角「用量」");
			// 可见值：累计在前，今日请求数跟在后面 —— 只有 tip 里有"今日"的话，
			// 用户每次都得悬停才知道今天用了多少。
			var value = total == null ? "—" : fmt(total);
			if (td) value += "  ·今日 " + (td.truncated ? "≥" : "") + td.requests;
			return {
				key: "total",
				name: "消耗",
				value: value,
				pct: total && total > 0 && today != null ? Math.round((today / total) * 100) : null,
				tone: "off",
				// 与 channelCell 同一规矩：逐行排，不用「 · 」挤成一行。
				title: title.join("\n"),
			};
		}

		/**
		 * Choose the 4 cells: fixed total first, then up to three channels.
		 * Order: channel of the model in use → exceeded → lowest remaining
		 * ratio → most recently called → fixed order.
		 */
		function pickEntries(snap) {
			var usage = snap && snap.usage ? snap.usage : null;
			var focus = snap && snap.focus ? snap.focus : null;
			var recent = (usage && Array.isArray(usage.recentModels) ? usage.recentModels : []).reduce(function (acc, r) {
				if (r && r.model) acc[r.model] = r.lastTs || 0;
				return acc;
			}, {});
			var channels = ((snap && snap.channels) || []).filter(function (c) {
				// 有数值配额（remain）、有错误（signed out / disabled）、**或有已用统计**都留下。
				// `used` 必须算数：api-key 模式上游不给数值额度（get-user-resource 这一族
				// OAuth-only，实测 numericQuota:false），但本地用量表照记 —— 此时渠道只剩
				// 「已用 N」也该显示。早年只判 remain/error，切到 api-key 后 CodeBuddy 整格消失。
				return c && (c.remain != null || c.error || c.used != null);
			});
			var order = { codebuddy: 0, trae: 1, qoder: 2 };
			channels.sort(function (a, b) {
				var fa = focus && focus.channel === a.id ? 0 : 1;
				var fb = focus && focus.channel === b.id ? 0 : 1;
				if (fa !== fb) return fa - fb;
				var ea = a.exceeded ? 0 : 1;
				var eb = b.exceeded ? 0 : 1;
				if (ea !== eb) return ea - eb;
				var ra = a.limit ? a.remain / a.limit : 2;
				var rb = b.limit ? b.remain / b.limit : 2;
				if (ra !== rb) return ra - rb;
				var ta = recent[a.id] || 0;
				var tb = recent[b.id] || 0;
				if (ta !== tb) return tb - ta;
				return (order[a.id] || 9) - (order[b.id] || 9);
			});
			var cells = [totalCell(usage, snap)];
			for (var i = 0; i < channels.length && cells.length < 4; i++) cells.push(channelCell(channels[i]));
			return cells;
		}

		// ------------------------------------------------------------------
		// 挂载与渲染
		// ------------------------------------------------------------------
		function buildWidget() {
			var wrap = document.createElement("div");
			wrap.className = "qw-wrap";
			wrap.setAttribute(MARK, "");
			wrap.setAttribute("role", "group");
			wrap.setAttribute("aria-label", "余量");
			// **整块只占两行**：网格第一行是「悬浮条」（刷新按钮 right:4px 绝对定位在里面），
			// 四格之间的上下间距已由 grid 的 row-gap 给足。所以单元格里**不再各带 2px 间隔**，
			// 进度条也不再各占一行——否则整块会多出 4~6px 的隐形高度（等于白多一行）。
			// 单元格池：1 个总消耗 + 3 个渠道，2 列排布。
			var cells = [];
			for (var i = 0; i < 4; i++) {
				var cell = document.createElement("div");
				cell.className = "qw-cell";
				cell.style.display = "none";
				var line = document.createElement("div");
				line.className = "qw-line";
				var dot = document.createElement("span");
				dot.className = "qw-dot qw-dot-off";
				var name = document.createElement("span");
				name.className = "qw-name";
				var val = document.createElement("span");
				val.className = "qw-val";
				line.appendChild(dot);
				line.appendChild(name);
				line.appendChild(val);
				// 进度条压在同一行的底部当**底色轨道**（absolute，不进文档流）：
				// 内容高度 = 文字行高，进度条不再另起一行。
				// 总消耗格没有比例值，整格不画轨道（原先就是个空的 2px 块，等于白占高）。
				var bar = document.createElement("div");
				bar.className = "qw-bar";
				bar.style.display = "none";
				var fill = document.createElement("i");
				bar.appendChild(fill);
				cell.appendChild(line);
				cell.appendChild(bar);
				wrap.appendChild(cell);
				cells.push({ cell: cell, dot: dot, name: name, val: val, bar: bar, fill: fill });
			}
			// 本卡自己的刷新按钮：网格第一行右端（第二格文字短、右侧留白）的悬浮角标、悬停才显现。
			// 只用 DOM 事件驱动，不新增任何 observer（DOM 纪律）。
			var btn = document.createElement("button");
			btn.type = "button";
			btn.className = "qw-refresh";
			btn.title = "刷新余量";
			btn.setAttribute("aria-label", "刷新余量");
			var icon = document.createElement("i");
			icon.textContent = "⟳";
			btn.appendChild(icon);
			wrap.appendChild(btn);
			// 角标方案：按钮绝对定位在第一行第二格的右上留白里（见 .qw-wrap 的 padding
			// 与 .qw-refresh 的 top/right），**不给卡片额外撑任何高度**——
			// 早先 JS 撑 padding-bottom、后来 CSS 16px 底边，都是白占一行。
			return { wrap: wrap, cells: cells, refreshBtn: btn, refreshIcon: icon };
		}

		/** 解析 CSS 计算样式里的 `rgb(...)` / `rgba(...)`（含空格、斜杠新写法）。 */
		function parseRgb(text) {
			var m = /rgba?\(([^)]*)\)/.exec(text || "");
			if (!m) return null;
			var parts = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
			if (parts.length < 3 || parts.some(function (n) { return !isFinite(n); })) return null;
			return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
		}

		/**
		 * 把半透明的卡片底色合到它实际压着的那层（父链上第一个不透明背景，兜底白）上，
		 * 得到角标该用的**不透明**底色。角标是绝对定位，不继承卡片背景，
		 * 只能自己画一层；画半透明的会在不同主题下糊成一块。
		 */
		function blendBackground(fg, under, fallback) {
			var f = parseRgb(fg);
			if (!f) return fallback || "transparent";
			var base = under && under.a >= 1 ? under : parseRgb(fallback) || { r: 255, g: 255, b: 255, a: 1 };
			var a = Math.max(0, Math.min(1, f.a));
			var ch = function (x, y) { return Math.round(x * a + y * (1 - a)); };
			return "rgb(" + ch(f.r, base.r) + ", " + ch(f.g, base.g) + ", " + ch(f.b, base.b) + ")";
		}

		/**
		 * 沿父链找第一个不透明背景色（读到 body 为止）。
		 * 只在挂载时读一次计算样式，不新增 observer；样式解析失败就当没读到。
		 */
		function opaqueBackground(el) {
			var node = el;
			for (var i = 0; node && i < 12; i++) {
				var view = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
				var parsed = view ? parseRgb(view.backgroundColor) : null;
				if (parsed && parsed.a >= 1) return parsed;
				node = node.parentElement;
			}
			return null;
		}

		/**
		 * 角标底色 = 卡片此刻的背景（半透明则与父层合成），由 JS 写入内联自定义属性。
		 * - CSS 里没有这一条：内联属性优先级更高，无 JS 时回落到默认透明。
		 * - 用自定义属性而非内联 background：:hover 那条规则才能靠内联变量重新着色。
		 * - 卡片背景是 transparent：删掉属性，角标跟着卡片一起透，悬停高亮照旧能看见。
		 */
		function syncButtonBackground(host) {
			if (!host || !host.wrap || !host.refreshBtn || typeof getComputedStyle !== "function") return;
			if (!host.refreshBtn.style || typeof host.refreshBtn.style.setProperty !== "function") return;
			var view = getComputedStyle(host.wrap);
			var card = view ? parseRgb(view.backgroundColor) : null;
			var btnStyle = host.refreshBtn.style;
			if (!card) return;
			if (card.a >= 1) btnStyle.setProperty(BG_KEY, "rgb(" + card.r + ", " + card.g + ", " + card.b + ")");
			else if (card.a > 0) btnStyle.setProperty(BG_KEY, blendBackground(card, opaqueBackground(host.wrap.parentElement)));
			else btnStyle.removeProperty(BG_KEY);
		}

		function render(host, snap) {
			if (!host) return;
			var cells = pickEntries(snap);
			for (var i = 0; i < host.cells.length; i++) {
				var h = host.cells[i];
				var c = cells[i];
				if (!c) {
					h.cell.style.display = "none";
					continue;
				}
				h.cell.style.display = "";
				h.dot.className = "qw-dot qw-dot-" + c.tone;
				h.name.textContent = c.name;
				h.val.textContent = c.value;
				h.cell.title = c.title || "";
				if (c.pct != null) {
					h.bar.style.display = "";
					h.fill.style.width = c.pct + "%";
					h.fill.className = c.tone === "warn" ? "warn" : c.tone === "err" ? "err" : "";
				} else {
					h.bar.style.display = "none";
				}
			}
			var at = snap && snap.at ? new Date(snap.at) : null;
			// 卡片级 tip 逐行排：状态一行、源一行、操作提示一行。
			var wrapLines = [];
			if (at) wrapLines.push(at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + " 更新");
			if (snap && snap.stale) wrapLines.push("刷新失败，显示上一次数据");
			if (snap && snap.sources) {
				wrapLines.push("源：" + snap.sources.map(function (s) { return s.id + (s.ok ? "✓" : "✗"); }).join(" "));
			}
			wrapLines.push("点击卡片刷新");
			if (usageUrlOf(snap)) wrapLines.push("官方用量明细：设置 → 账号 → 用量");
			host.wrap.title = wrapLines.join("\n");
		}

		// ------------------------------------------------------------------
		// 诊断：输入框聚焦探针，宿主会保存下来供稍后读取。
		// ------------------------------------------------------------------
		function classChain(el, depth) {
			var out = [];
			var node = el;
			for (var i = 0; i < depth && node; i++) {
				var cls = typeof node.className === "string" ? node.className : "";
				out.push(node.tagName.toLowerCase() + (cls ? "." + cls.trim().split(/\s+/).slice(0, 2).join(".") : ""));
				node = node.parentElement;
			}
			return out;
		}

		function focusProbe() {
			if (typeof document === "undefined") return null;
			try {
				var editor = document.querySelector('[contenteditable="true"]');
				if (!editor) return { ok: false, reason: "no-editor" };
				var rect = editor.getBoundingClientRect();
				if (!rect || rect.width === 0 || rect.height === 0) return { ok: false, reason: "editor-hidden" };
				var x = Math.round(rect.left + rect.width / 2);
				var y = Math.round(rect.top + rect.height / 2);
				var top = document.elementFromPoint(x, y);
				var inside = top === editor || (top && editor.contains(top));
				return {
					ok: inside,
					point: { x: x, y: y },
					top: top ? top.tagName.toLowerCase() + (typeof top.className === "string" && top.className ? "." + top.className.trim().split(/\s+/).slice(0, 2).join(".") : "") : null,
					chain: top ? classChain(top, 3) : [],
					active: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
					menus: document.querySelectorAll("[data-menu-material]").length,
					inert: document.querySelectorAll("[inert]").length,
				};
			} catch (e) {
				return { ok: false, reason: "probe-error" };
			}
		}

		function report(extra) {
			if (typeof fetch !== "function") return;
			var payload = { plugin: "dsh-tap-quota", at: Date.now(), focus: focusProbe() };
			for (var k in extra || {}) payload[k] = extra[k];
			try {
				fetch(DIAG, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					keepalive: true,
				}).catch(function () {});
			} catch (e) {}
		}

		function installQuotaWidget() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();

			var host = null;
			var timer = null;
			var retryTimer = null;
			var observer = null;
			var resizeObs = null;
			var observerParent = null;
			var nextDelay = POLL_MS;
			var disposed = false;

			function findFootArea() {
				var areas = document.querySelectorAll('[class*="_footArea"]');
				for (var i = 0; i < areas.length; i++) {
					var parent = areas[i].parentNode;
					if (parent && parent.querySelector('[class*="_regionArea"]')) return areas[i];
				}
				return areas.length ? areas[0] : null;
			}

			function mount() {
				if (disposed) return;
				var footArea = findFootArea();
				if (!footArea || !footArea.parentNode) {
					if (!retryTimer) {
						retryTimer = setTimeout(function () {
							retryTimer = null;
							mount();
						}, 2000);
					}
					return;
				}
				var parent = footArea.parentNode;
				if (!host) {
					host = buildWidget();
					// 整卡可点 = 强制刷新（无障碍兜底：不想精确点按钮也能刷）。
					host.wrap.addEventListener("click", function (e) {
						e.stopPropagation();
						fetchData(true);
					});
					// 右下角悬浮按钮：同样强制刷新，但 stopPropagation
					// 保证它不会因冒泡再触发一次整卡刷新（那样会发两个请求）。
					host.refreshBtn.addEventListener("click", function (e) {
						e.stopPropagation();
						e.preventDefault();
						fetchData(true);
					});
				}
				if (host.wrap.parentNode !== parent || host.wrap.nextSibling !== footArea) {
					parent.insertBefore(host.wrap, footArea);
				}
				// 角标底色依赖卡片此刻的背景（挂载时读一次；只在重挂载时重读，不新增 observer）。
				syncButtonBackground(host);
				if (observerParent !== parent) {
					if (observer) observer.disconnect();
					observer = new MutationObserver(function (records) {
						for (var i = 0; i < records.length; i++) {
							if (records[i].addedNodes.length) {
								mount();
								return;
							}
						}
					});
					observer.observe(parent, { childList: true });
					observerParent = parent;
				}
				if (!resizeObs) {
					resizeObs = new ResizeObserver(function () {
						if (!host || !parent) return;
						var w = parent.getBoundingClientRect ? parent.getBoundingClientRect().width : 0;
						host.wrap.style.display = w > 0 && w < 140 ? "none" : "";
					});
					resizeObs.observe(parent);
				}
				fetchData(false);
			}

			function fetchData(force) {
				if (disposed) return;
				var url = ROUTE + (force ? "?refresh=1" : "");
				var opts = {};
				if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(TIMEOUT_MS);
				// 手动刷新时给按钮一个转圈反馈；自动轮询不动它（避免每 60s 无谓抖一下）。
				if (force && host && host.refreshBtn) {
					host.refreshBtn.disabled = true;
					host.refreshBtn.className = "qw-refresh busy";
				}
				fetch(url, opts)
					.then(function (r) {
						return r.json();
					})
					.then(function (snap) {
						render(host, snap);
						nextDelay = POLL_MS;
						report({
							event: "poll",
							ok: !!(snap && snap.ok),
							sources: snap && snap.sources,
							stale: !!(snap && snap.stale),
						});
					})
					.catch(function (error) {
						nextDelay = Math.min(nextDelay * 2, BACKOFF_MAX_MS);
						report({ event: "poll-error", error: String((error && error.message) || error) });
					})
					.finally(function () {
						if (host && host.refreshBtn) {
							host.refreshBtn.disabled = false;
							host.refreshBtn.className = "qw-refresh";
						}
						schedule();
					});
			}

			function schedule() {
				if (timer) clearTimeout(timer);
				timer = setTimeout(function () {
					if (typeof document !== "undefined" && document.hidden) {
						schedule();
						return;
					}
					fetchData(false);
				}, nextDelay);
			}

			function onVisibility() {
				if (!document.hidden && !disposed) fetchData(false);
			}

			mount();
			setTimeout(function () {
				report({ event: "install" });
			}, 5000);
			document.addEventListener("visibilitychange", onVisibility);

			return function dispose() {
				disposed = true;
				if (timer) clearTimeout(timer);
				if (retryTimer) clearTimeout(retryTimer);
				if (observer) observer.disconnect();
				if (resizeObs) resizeObs.disconnect();
				document.removeEventListener("visibilitychange", onVisibility);
				if (host && host.wrap && host.wrap.parentNode) host.wrap.parentNode.removeChild(host.wrap);
				host = null;
			};
		}

		// 不依赖 slot：组件直接注入侧边栏 DOM。
		var inject = [];

		function apply(ctx) {
			ctx.effect(function () {
				return installQuotaWidget();
			}, "dsh-tap-quota: sidebar quota widget");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			fmt: fmt,
			fmt4: fmt4,
			usageUrlOf: usageUrlOf,
			pctOf: pctOf,
			pickEntries: pickEntries,
			channelCell: channelCell,
			totalCell: totalCell,
			todayCount: todayCount,
			focusProbe: focusProbe,
			parseRgb: parseRgb,
			blendBackground: blendBackground,
			opaqueBackground: opaqueBackground,
			syncButtonBackground: syncButtonBackground,
			// 结构 + 渲染也导出：测试夹具用最小 DOM 桩直接走一遍真实挂载路径。
			buildWidget: buildWidget,
			render: render,
		};
		return module.exports;
	},
});
