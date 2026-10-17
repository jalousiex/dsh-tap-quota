/**
 * Browser half of dsh-tap-quota: a compact 2-row quota card in the sidebar.
 *
 * Data: ONE request per poll to `/dsh-tap-quota/snapshot` (the host fans out
 * to dsh-tap / the usage store / upstream and normalizes everything). The
 * browser no longer touches another plugin's private route, so a missing or
 * failing dsh-tap degrades to whatever the host could still read.
 *
 * Layout: 2 columns, at most 4 cells — the first cell is always `总消耗`, then
 * up to three channels (remaining + unit + a 2px progress bar). Entry order:
 * the channel of the model in use → exceeded → lowest remaining ratio → most
 * recently called → fixed order. Everything else lives in the cell tooltip.
 *
 * DOM discipline: the widget is a sibling block injected before the sidebar's
 * foot area (no slot fits: `sidebar.footer.action` is a flex row shared with
 * dsh-mobile's button). Mount is structural and idempotent — one bounded
 * structural query, a childList observer on the foot area's parent only, and a
 * ResizeObserver for the collapsed rail. No class-attribute observation, no
 * whole-document scans, no feedback loop.
 *
 * Diagnostics: the card reports a small JSON bundle to the host (including a
 * composer focus probe) so a browser-only symptom like "input cannot be
 * focused" can be diagnosed from ~/.dsh/.cache without DevTools.
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

		var CSS_TEXT = [
			'.qw-wrap{display:grid;grid-template-columns:1fr 1fr;gap:3px 6px;width:100%;min-width:0;box-sizing:border-box;margin:3px 0 1px;padding:3px 4px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));font-size:11px;line-height:1.2;cursor:pointer}',
			'.qw-wrap:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
			'.qw-cell{display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.qw-line{display:flex;align-items:baseline;gap:3px;white-space:nowrap;overflow:hidden}',
			'.qw-dot{width:5px;height:5px;border-radius:50%;flex:0 0 auto;align-self:center}',
			'.qw-dot-ok{background:var(--dsw-alias-state-success-primary,#2a9d4a)}',
			'.qw-dot-warn{background:var(--dsw-alias-state-warn-primary,#b80)}',
			'.qw-dot-err{background:var(--dsw-alias-state-error-primary,#d33)}',
			'.qw-dot-off{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(128,128,128,.45))}',
			'.qw-name{font-weight:600;font-size:10px;color:var(--dsw-alias-label-secondary,inherit);flex:0 0 auto;letter-spacing:.02em}',
			'.qw-val{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis}',
			'.qw-bar{height:2px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.15));overflow:hidden}',
			'.qw-bar>i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,#1a66ff);transition:width .3s ease}',
			'.qw-bar>i.warn{background:var(--dsw-alias-state-warn-primary,#b80)}',
			'.qw-bar>i.err{background:var(--dsw-alias-state-error-primary,#d33)}',
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
		// Pure helpers (also exported for the node test harness)
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

		function pctOf(remain, limit) {
			if (remain == null || limit == null || !isFinite(remain) || !isFinite(limit) || limit <= 0) return null;
			var p = (remain / limit) * 100;
			if (p < 0) return 0;
			if (p > 100) return 100;
			return Math.round(p);
		}

		function channelCell(c) {
			var pct = pctOf(c.remain, c.limit);
			var value;
			if (c.remain != null) value = fmt(c.remain) + " " + (c.unit || "");
			else if (c.used != null) value = "已用 " + fmt(c.used) + " " + (c.unit || "");
			else value = "—";
			var title = [c.label];
			if (c.remain != null && c.limit != null) title.push("剩余 " + fmt(c.remain) + " / " + fmt(c.limit) + " " + (c.unit || ""));
			else if (c.remain != null) title.push("剩余 " + fmt(c.remain) + " " + (c.unit || ""));
			if (c.used != null) title.push("已用 " + fmt(c.used));
			if (c.exceeded) title.push("已用尽");
			if (c.pools && c.pools.work) title.push("Work 池剩余 " + fmt(c.pools.work.remain) + " / " + fmt(c.pools.work.limit));
			if (c.error) title.push("错误：" + c.error);
			return {
				key: c.id,
				name: c.label,
				value: value,
				pct: pct,
				tone: c.exceeded && pct === 0 ? "err" : c.tone || "off",
				title: title.filter(Boolean).join(" · "),
			};
		}

		function totalCell(usage) {
			var total = usage && isFinite(usage.totalCredit) ? usage.totalCredit : null;
			var today = usage && usage.today && isFinite(usage.today.credit) ? usage.today.credit : null;
			var reqs = usage && isFinite(usage.totalRequests) ? usage.totalRequests : null;
			var title = [];
			if (total != null) title.push("累计 " + fmt(total) + " credits");
			if (today != null) title.push("今日 " + fmt(today));
			if (reqs != null) title.push(reqs + " 次请求");
			return {
				key: "total",
				name: "消耗",
				value: total == null ? "—" : fmt(total) + " credits",
				pct: total && total > 0 && today != null ? Math.round((today / total) * 100) : null,
				tone: "off",
				title: title.join(" · "),
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
				return c && (c.remain != null || c.error);
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
			var cells = [totalCell(usage)];
			for (var i = 0; i < channels.length && cells.length < 4; i++) cells.push(channelCell(channels[i]));
			return cells;
		}

		// ------------------------------------------------------------------
		// Mounting + rendering
		// ------------------------------------------------------------------
		function buildWidget() {
			var wrap = document.createElement("div");
			wrap.className = "qw-wrap";
			wrap.setAttribute(MARK, "");
			wrap.setAttribute("role", "group");
			wrap.setAttribute("aria-label", "余量");
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
				var bar = document.createElement("div");
				bar.className = "qw-bar";
				var fill = document.createElement("i");
				bar.appendChild(fill);
				cell.appendChild(line);
				cell.appendChild(bar);
				wrap.appendChild(cell);
				cells.push({ cell: cell, dot: dot, name: name, val: val, bar: bar, fill: fill });
			}
			return { wrap: wrap, cells: cells };
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
			host.wrap.title = (at ? at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + " 更新" : "") +
				(snap && snap.stale ? "（旧数据）" : "") +
				(snap && snap.sources ? "\n源：" + snap.sources.map(function (s) { return s.id + (s.ok ? "✓" : "✗"); }).join(" ") : "");
		}

		// ------------------------------------------------------------------
		// Diagnostics: a composer focus probe the host stores for later reading.
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
					host.wrap.addEventListener("click", function (e) {
						e.stopPropagation();
						fetchData(true);
					});
				}
				if (host.wrap.parentNode !== parent || host.wrap.nextSibling !== footArea) {
					parent.insertBefore(host.wrap, footArea);
				}
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
				fetch(url, opts)
					.then(function (r) {
						return r.json();
					})
					.then(function (snap) {
						render(host, snap);
						nextDelay = POLL_MS;
						report({ event: "poll", ok: !!(snap && snap.ok), sources: snap && snap.sources, stale: !!(snap && snap.stale) });
					})
					.catch(function (error) {
						nextDelay = Math.min(nextDelay * 2, BACKOFF_MAX_MS);
						report({ event: "poll-error", error: String((error && error.message) || error) });
					})
					.finally(function () {
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

		// No slot dependency: the widget is injected into the sidebar DOM directly.
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
			pctOf: pctOf,
			pickEntries: pickEntries,
			channelCell: channelCell,
			totalCell: totalCell,
			focusProbe: focusProbe,
		};
		return module.exports;
	},
});
