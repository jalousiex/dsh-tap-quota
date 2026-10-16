/**
 * Browser half of dsh-tap-quota: a sidebar quota widget.
 *
 * The widget is injected straight into the sidebar DOM as a full-width row
 * placed before the foot area (the flex column that holds the footer action
 * row plus the Settings row), NOT through the `sidebar.footer.action` slot.
 *
 * Why not the slot: that slot is a LIST rendered by the host inside a
 * `display:flex` row container, and `dsh-mobile` registers its
 * "移动访问" button into the same row. Two entries share one row, so the
 * widget got squeezed to the right half with truncated content. Injecting
 * as a sibling block gives it its own full-width row.
 *
 * The widget polls the dsh-tap plugin's /dsh-tap/settings route every 60s
 * for three channels' quota snapshots plus the usage meter's consumed-credit
 * total, and renders a compact 2-column grid with colored status dots and
 * mini progress bars.
 *
 * Data source: dsh-tap's POST /dsh-tap/settings with actions:
 *   - 'usage'       → { usage: { totalCredit, totalRequests, ... }, quota: { resource, ... } }
 *   - 'trae-quota'  → { quota: { pools: { ide: {limit,used,remain}, work: {...} } } }
 *   - 'qoder-quota' → { quota: { userQuota: {total,used,remaining,unit}, addOnQuota: {...} } }
 *
 * No build step: plain DOM APIs (no react-dom needed, the module loader's
 * require table does not expose it). Uses the host's --dsw-alias-* design
 * tokens for automatic dark-theme support.
 */

window.__ModuleLoader__.load({
	id: "dsh-tap-quota",
	exports: function (module, exports, require) {
		"use strict";

		var ROUTE = "/dsh-tap/settings";

		var CSS_TEXT = [
			".qw-wrap{display:flex;flex-direction:column;width:100%;min-width:0;box-sizing:border-box;gap:2px;margin:2px 0 1px;padding:2px 0 0;font-size:11px;line-height:1.25;color:var(--dsw-alias-label-tertiary,gray)}",
			".qw-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px 6px}",
			".qw-cell{display:flex;flex-direction:column;gap:1px;min-width:0;padding:2px 4px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06))}",
			".qw-head{display:flex;align-items:center;gap:3px;white-space:nowrap;overflow:hidden}",
			".qw-dot{width:5px;height:5px;border-radius:50%;flex:0 0 auto}",
			".qw-dot-ok{background:var(--dsw-alias-state-success-primary,#2a9d4a)}",
			".qw-dot-warn{background:var(--dsw-alias-state-warn-primary,#b80)}",
			".qw-dot-err{background:var(--dsw-alias-state-error-primary,#d33)}",
			".qw-dot-off{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(128,128,128,.45))}",
			".qw-name{font-weight:600;font-size:10px;color:var(--dsw-alias-label-secondary,inherit);flex:0 0 auto;letter-spacing:.02em}",
			".qw-val{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".qw-sub{font-size:9px;color:var(--dsw-alias-label-tertiary,gray);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".qw-bar{height:2px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.15));overflow:hidden}",
			".qw-bar-fill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,#1a66ff);transition:width .3s ease}",
			".qw-bar-fill-warn{background:var(--dsw-alias-state-warn-primary,#b80)}",
			".qw-bar-fill-err{background:var(--dsw-alias-state-error-primary,#d33)}",
			".qw-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:0;padding-top:2px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}",
			".qw-foot-txt{font-size:10px;color:var(--dsw-alias-label-tertiary,gray);font-family:var(--ds-font-family-code,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".qw-refresh{all:unset;cursor:pointer;font-size:10px;color:var(--dsw-alias-state-business-primary,#1a66ff);flex:0 0 auto;white-space:nowrap}",
			".qw-refresh:hover{text-decoration:underline}",
			".qw-refresh[disabled]{opacity:.5;cursor:default}",
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			var tag = 'style[data-plugin-css="dsh-tap-quota"]';
			var existing = document.querySelector(tag);
			if (existing) {
				// HMR: refresh the content instead of skipping
				if (existing.textContent !== CSS_TEXT) existing.textContent = CSS_TEXT;
				return;
			}
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-tap-quota");
			el.setAttribute("data-plugin-css", "dsh-tap-quota");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}

		function fmt(n) {
			if (n == null || isNaN(n)) return "—";
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
			return n.toFixed(1);
		}

		function pctClass(remain, total) {
			if (!total || total <= 0) return "ok";
			var pct = remain / total;
			if (pct < 0.1) return "err";
			if (pct < 0.3) return "warn";
			return "ok";
		}

		function el(tag, cls, text) {
			var node = document.createElement(tag);
			if (cls) node.className = cls;
			if (text != null) node.textContent = text;
			return node;
		}

		// ------------------------------------------------------------------
		// Sidebar location: CSS-module class names are hashed (_2H3hWW_*), so
		// match on the class-token suffix, the same technique dsh-mobile uses.
		// The sidebar root is the element with a `_root` token that contains
		// both a `_footArea` child (footer action row + Settings row) and a
		// `_regionArea` child (session list).
		// ------------------------------------------------------------------
		var MARK = "data-dsh-tap-quota";

		function findSidebarRoot() {
			if (typeof document === "undefined") return null;
			var roots = document.querySelectorAll('[class*="_root"]');
			for (var i = 0; i < roots.length; i++) {
				var candidate = roots[i];
				if (candidate.querySelector('[class*="_footArea"]') && candidate.querySelector('[class*="_regionArea"]')) return candidate;
			}
			return null;
		}

		function buildWidget() {
			var wrap = el("div", "qw-wrap");
			wrap.setAttribute(MARK, "");

			var grid = el("div", "qw-grid");
			var cells = {};
			var defs = [["cb", "CodeBuddy"], ["trae", "Trae"], ["qoder", "Qoder"], ["consumed", "消耗"]];
			for (var i = 0; i < defs.length; i++) {
				var key = defs[i][0];
				var cell = el("div", "qw-cell");
				var head = el("div", "qw-head");
				var dot = el("span", "qw-dot qw-dot-off");
				head.appendChild(dot);
				head.appendChild(el("span", "qw-name", defs[i][1]));
				var val = el("div", "qw-val", "—");
				var sub = el("div", "qw-sub", "—");
				cell.appendChild(head);
				cell.appendChild(val);
				cell.appendChild(sub);
				var bar = el("div", "qw-bar");
				bar.style.display = "none";
				var fill = el("span", "qw-bar-fill");
				fill.style.width = "0%";
				bar.appendChild(fill);
				cell.appendChild(bar);
				grid.appendChild(cell);
				cells[key] = { dot: dot, val: val, sub: sub, bar: bar, fill: fill };
			}
			wrap.appendChild(grid);

			var foot = el("div", "qw-foot");
			var stamp = el("span", "qw-foot-txt", "");
			var btn = el("button", "qw-refresh", "↻ 刷新");
			btn.type = "button";
			foot.appendChild(stamp);
			foot.appendChild(btn);
			wrap.appendChild(foot);

			return { wrap: wrap, cells: cells, stamp: stamp, btn: btn };
		}

		function setCell(c, tone, valText, subText, pct) {
			c.dot.className = "qw-dot qw-dot-" + tone;
			c.val.textContent = valText;
			c.sub.textContent = subText;
			if (pct != null && pct >= 0) {
				c.bar.style.display = "";
				c.fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
				c.fill.className = "qw-bar-fill" + (tone === "warn" ? " qw-bar-fill-warn" : tone === "err" ? " qw-bar-fill-err" : "");
			} else {
				c.bar.style.display = "none";
			}
		}

		function installQuotaWidget() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();

			var timer = null;
			var host = null;
			var observer = null;
			var lastRoot = null;

			function fetchData() {
				var opts = { method: "POST", signal: AbortSignal.timeout(12000) };
				var jsonType = { "Content-Type": "application/json" };
				var cbP = fetch(ROUTE, Object.assign({}, opts, { headers: jsonType, body: JSON.stringify({ action: "usage" }) })).then(function (r) { return r.json(); }).catch(function () { return null; });
				var traeP = fetch(ROUTE, Object.assign({}, opts, { headers: jsonType, body: JSON.stringify({ action: "trae-quota" }) })).then(function (r) { return r.json(); }).catch(function () { return null; });
				var qoderP = fetch(ROUTE, Object.assign({}, opts, { headers: jsonType, body: JSON.stringify({ action: "qoder-quota" }) })).then(function (r) { return r.json(); }).catch(function () { return null; });
				Promise.all([cbP, traeP, qoderP]).then(function (results) {
					render({ cb: results[0] || {}, trae: results[1] || {}, qoder: results[2] || {}, at: Date.now() });
				}).catch(function () {});
			}

			function render(data) {
				if (!host) return;
				var c = host.cells;

				// CodeBuddy
				var cbQuota = data.cb && data.cb.quota;
				var cbRes = cbQuota && cbQuota.resource;
				var cbRemain = cbRes && cbRes.totalRemain;
				var cbCycleSize = cbRes && cbRes.cycleSize;
				var cbCycleRemain = cbRes && cbRes.cycleRemain;
				var cbUsage = data.cb && data.cb.usage;
				var cbTotalCredit = cbUsage && cbUsage.totalCredit;
				var cbError = cbQuota && cbQuota.error;
				var cbTone = cbError ? "err" : cbRemain != null ? pctClass(cbRemain, cbCycleSize) : "off";
				setCell(
					c.cb, cbTone,
					cbError ? "错误" : cbRemain != null ? fmt(cbRemain) + " 剩余" : cbTotalCredit != null ? "已用 " + fmt(cbTotalCredit) : "—",
					cbCycleSize ? "周期 " + fmt(cbCycleSize) : (cbQuota && cbQuota.numericQuota === false ? "API Key 估算" : "—"),
					cbCycleSize > 0 ? ((cbCycleSize - cbCycleRemain) / cbCycleSize) * 100 : -1
				);

				// Trae
				var traeQ = data.trae && data.trae.quota;
				var traePools = traeQ && traeQ.pools;
				var traeIde = traePools && traePools.ide;
				var traeWork = traePools && traePools.work;
				var traeRemain = traeIde ? traeIde.remain : null;
				var traeLimit = traeIde ? traeIde.limit : null;
				var traeErr = traeQ && traeQ.error;
				var traeTone = traeErr ? "err" : traeRemain != null ? pctClass(traeRemain, traeLimit) : "off";
				setCell(
					c.trae, traeTone,
					traeErr ? "错误" : traeRemain != null ? fmt(traeRemain) + " IDE" : "—",
					traeWork ? fmt(traeWork.remain) + " Work" : (traeErr ? "" : "—"),
					traeLimit > 0 ? (traeIde.used / traeLimit) * 100 : -1
				);

				// Qoder
				var qoderQ = data.qoder && data.qoder.quota;
				var qoderUser = qoderQ && qoderQ.userQuota;
				var qoderRemain = qoderUser ? qoderUser.remaining : null;
				var qoderTotal = qoderUser ? qoderUser.total : null;
				var qoderErr = qoderQ && qoderQ.error;
				var qoderTone = qoderErr ? "err" : qoderRemain != null ? pctClass(qoderRemain, qoderTotal) : "off";
				setCell(
					c.qoder, qoderTone,
					qoderErr ? "错误" : qoderRemain != null ? fmt(qoderRemain) + (qoderUser && qoderUser.unit ? " " + qoderUser.unit : "") : "—",
					qoderTotal ? "总量 " + fmt(qoderTotal) : "—",
					qoderTotal > 0 ? ((qoderTotal - qoderRemain) / qoderTotal) * 100 : -1
				);

				// Consumed credits
				var totalReqs = cbUsage && cbUsage.totalRequests;
				setCell(
					c.consumed, "off",
					cbTotalCredit != null ? fmt(cbTotalCredit) + " credits" : "—",
					totalReqs ? totalReqs + " 次请求" : "—",
					-1
				);

				host.stamp.textContent = data.at
					? new Date(data.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + " 更新"
					: "";
			}

			// Place the widget as a full-width row directly above the foot area.
			function mount() {
				var root = findSidebarRoot();
				if (!root) return;
				lastRoot = root;
				var footArea = root.querySelector('[class*="_footArea"]');
				if (!footArea) return;

				if (!host) {
					host = buildWidget();
					host.btn.addEventListener("click", function (e) {
						e.stopPropagation();
						fetchData();
					});
				}
				var parent = footArea.parentNode;
				if (host.wrap.parentNode !== parent || host.wrap.nextSibling !== footArea) {
					parent.insertBefore(host.wrap, footArea);
				}
				// Hidden while the sidebar is collapsed to the 56px rail
				host.wrap.style.display = root.className.indexOf("_collapsed") >= 0 ? "none" : "";
			}

			function sweep() {
				try { mount(); } catch (e) {}
			}

			sweep();
			fetchData();
			timer = setInterval(fetchData, 60000);

			observer = new MutationObserver(function () {
				var root = findSidebarRoot();
				if (root !== lastRoot) lastRoot = root;
				sweep();
			});
			observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

			return function dispose() {
				if (timer) clearInterval(timer);
				if (observer) observer.disconnect();
				if (host && host.wrap && host.wrap.parentNode) host.wrap.parentNode.removeChild(host.wrap);
				host = null;
			};
		}

		// No slot dependency: the widget is injected into the sidebar DOM directly,
		// so the module needs no injected services.
		var inject = [];

		function apply(ctx) {
			ctx.effect(function () {
				return installQuotaWidget();
			}, "dsh-tap-quota: sidebar quota widget");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
