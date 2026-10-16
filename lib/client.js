/**
 * Browser half of dsh-tap-quota: a sidebar quota widget.
 *
 * Registers a QuotaWidget component in the sidebar.footer.action slot
 * (dsh ≥ 0.1.6). The widget polls the dsh-tap plugin's /dsh-tap/settings
 * route every 60s for three channels' quota snapshots plus the usage
 * meter's consumed-credit total, and renders a compact 2-column grid
 * with colored status dots and mini progress bars.
 *
 * Data source: dsh-tap's POST /dsh-tap/settings with actions:
 *   - 'usage'       → { usage: { totalCredit, totalRequests, ... }, quota: { resource, ... } }
 *   - 'trae-quota'  → { quota: { pools: { ide: {limit,used,remain}, work: {...} } } }
 *   - 'qoder-quota' → { quota: { userQuota: {total,used,remaining,unit}, addOnQuota: {...} } }
 *
 * No build step: plain React.createElement, same module-loader pattern as
 * dsh-tap's own client module. Uses the host's --dsw-alias-* design tokens
 * for automatic dark-theme support.
 */

window.__ModuleLoader__.load({
	id: "dsh-tap-quota",
	exports: function (module, exports, require) {
		"use strict";

		var React = require("@deepseek-ai/dsh-client-react");
		var createElement = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;

		var ROUTE = "/dsh-tap/settings";

		var CSS_TEXT = [
			".qw-wrap{display:flex;flex-direction:column;flex:1 1 100%;width:100%;min-width:0;max-width:100%;gap:3px;padding:6px 10px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,gray)}",
			".qw-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px}",
			".qw-cell{display:flex;flex-direction:column;gap:2px;min-width:0;padding:3px 5px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06))}",
			".qw-head{display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden}",
			".qw-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}",
			".qw-dot-ok{background:var(--dsw-alias-state-success-primary,#2a9d4a)}",
			".qw-dot-warn{background:var(--dsw-alias-state-warn-primary,#b80)}",
			".qw-dot-err{background:var(--dsw-alias-state-error-primary,#d33)}",
			".qw-dot-off{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(128,128,128,.45))}",
			".qw-name{font-weight:600;font-size:10px;color:var(--dsw-alias-label-secondary,inherit);flex:0 0 auto;letter-spacing:.02em}",
			".qw-val{font-family:var(--ds-font-family-code,monospace);font-size:11px;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".qw-sub{font-size:9px;color:var(--dsw-alias-label-tertiary,gray);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".qw-bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.15));overflow:hidden}",
			".qw-bar-fill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,#1a66ff);transition:width .3s ease}",
			".qw-bar-fill-warn{background:var(--dsw-alias-state-warn-primary,#b80)}",
			".qw-bar-fill-err{background:var(--dsw-alias-state-error-primary,#d33)}",
			".qw-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:1px;padding-top:3px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}",
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

		function barClass(cls) {
			if (cls === "warn") return " qw-bar-fill-warn";
			if (cls === "err") return " qw-bar-fill-err";
			return "";
		}

		function QuotaWidget() {
			var s = useState(null);
			var data = s[0];
			var setData = s[1];
			var loading = useState(false);
			var isLoading = loading[0];
			var setLoading = loading[1];

			var fetchData = function () {
				setLoading(true);
				var opts = { method: "POST", signal: AbortSignal.timeout(12000) };
				var jsonType = { "Content-Type": "application/json" };

				var cbP = fetch(ROUTE, Object.assign({}, opts, {
					headers: jsonType, body: JSON.stringify({ action: "usage" }),
				})).then(function (r) { return r.json(); }).catch(function () { return null; });

				var traeP = fetch(ROUTE, Object.assign({}, opts, {
					headers: jsonType, body: JSON.stringify({ action: "trae-quota" }),
				})).then(function (r) { return r.json(); }).catch(function () { return null; });

				var qoderP = fetch(ROUTE, Object.assign({}, opts, {
					headers: jsonType, body: JSON.stringify({ action: "qoder-quota" }),
				})).then(function (r) { return r.json(); }).catch(function () { return null; });

				Promise.all([cbP, traeP, qoderP]).then(function (results) {
					setData({ cb: results[0] || {}, trae: results[1] || {}, qoder: results[2] || {}, at: Date.now() });
				}).catch(function () {}).finally(function () { setLoading(false); });
			};

			useEffect(function () {
				ensureStyles();
				fetchData();
				var timer = setInterval(fetchData, 60000);
				return function () { clearInterval(timer); };
			}, []);

			// --- CodeBuddy ---
			var cbQuota = data && data.cb && data.cb.quota;
			var cbRes = cbQuota && cbQuota.resource;
			var cbRemain = cbRes && cbRes.totalRemain;
			var cbCycleSize = cbRes && cbRes.cycleSize;
			var cbCycleRemain = cbRes && cbRes.cycleRemain;
			var cbUsage = data && data.cb && data.cb.usage;
			var cbTotalCredit = cbUsage && cbUsage.totalCredit;
			var cbError = cbQuota && cbQuota.error;
			var cbCls = cbError ? "err" : cbRemain != null ? pctClass(cbRemain, cbCycleSize) : "off";
			var cbPct = cbCycleSize > 0 ? Math.max(0, Math.min(100, ((cbCycleSize - cbCycleRemain) / cbCycleSize) * 100)) : 0;

			// --- Trae ---
			var traeQ = data && data.trae && data.trae.quota;
			var traePools = traeQ && traeQ.pools;
			var traeIde = traePools && traePools.ide;
			var traeWork = traePools && traePools.work;
			var traeRemain = traeIde ? traeIde.remain : null;
			var traeLimit = traeIde ? traeIde.limit : null;
			var traeErr = traeQ && traeQ.error;
			var traeCls = traeErr ? "err" : traeRemain != null ? pctClass(traeRemain, traeLimit) : "off";
			var traePct = traeLimit > 0 ? Math.max(0, Math.min(100, (traeIde.used / traeLimit) * 100)) : 0;

			// --- Qoder ---
			var qoderQ = data && data.qoder && data.qoder.quota;
			var qoderUser = qoderQ && qoderQ.userQuota;
			var qoderRemain = qoderUser ? qoderUser.remaining : null;
			var qoderTotal = qoderUser ? qoderUser.total : null;
			var qoderErr = qoderQ && qoderQ.error;
			var qoderCls = qoderErr ? "err" : qoderRemain != null ? pctClass(qoderRemain, qoderTotal) : "off";
			var qoderPct = qoderTotal > 0 ? Math.max(0, Math.min(100, ((qoderTotal - qoderRemain) / qoderTotal) * 100)) : 0;

			// --- 已消耗积分 ---
			var consumedCredit = cbTotalCredit != null ? cbTotalCredit : null;
			var totalReqs = cbUsage && cbUsage.totalRequests;

			return createElement("div", { className: "qw-wrap", style: { display: "flex", flexDirection: "column", flex: "1 1 100%", width: "100%", minWidth: 0, maxWidth: "100%" } },
				// 2×2 网格
				createElement("div", { className: "qw-grid" },
					// CodeBuddy 格
					createElement("div", { className: "qw-cell" },
						createElement("div", { className: "qw-head" },
							createElement("span", { className: "qw-dot qw-dot-" + cbCls }),
							createElement("span", { className: "qw-name" }, "CodeBuddy")
						),
						createElement("div", { className: "qw-val" },
							cbError ? "错误" : cbRemain != null ? fmt(cbRemain) + " 剩余" : consumedCredit != null ? "已用 " + fmt(consumedCredit) : "—"
						),
						createElement("div", { className: "qw-sub" },
							cbCycleSize ? "周期 " + fmt(cbCycleSize) : (cbQuota && cbQuota.numericQuota === false ? "API Key 估算" : "—")
						),
						cbCycleSize > 0
							? createElement("div", { className: "qw-bar" },
								createElement("span", { className: "qw-bar-fill" + barClass(cbCls), style: { width: cbPct + "%" } })
							)
							: null
					),
					// Trae 格
					createElement("div", { className: "qw-cell" },
						createElement("div", { className: "qw-head" },
							createElement("span", { className: "qw-dot qw-dot-" + traeCls }),
							createElement("span", { className: "qw-name" }, "Trae")
						),
						createElement("div", { className: "qw-val" },
							traeErr ? "错误" : traeRemain != null ? fmt(traeRemain) + " IDE" : "—"
						),
						createElement("div", { className: "qw-sub" },
							traeWork ? fmt(traeWork.remain) + " Work" : (traeErr ? "" : "—")
						),
						traeLimit > 0
							? createElement("div", { className: "qw-bar" },
								createElement("span", { className: "qw-bar-fill" + barClass(traeCls), style: { width: traePct + "%" } })
							)
							: null
					),
					// Qoder 格
					createElement("div", { className: "qw-cell" },
						createElement("div", { className: "qw-head" },
							createElement("span", { className: "qw-dot qw-dot-" + qoderCls }),
							createElement("span", { className: "qw-name" }, "Qoder")
						),
						createElement("div", { className: "qw-val" },
							qoderErr ? "错误" : qoderRemain != null ? fmt(qoderRemain) + (qoderUser && qoderUser.unit ? " " + qoderUser.unit : "") : "—"
						),
						createElement("div", { className: "qw-sub" },
							qoderTotal ? "总量 " + fmt(qoderTotal) : "—"
						),
						qoderTotal > 0
							? createElement("div", { className: "qw-bar" },
								createElement("span", { className: "qw-bar-fill" + barClass(qoderCls), style: { width: qoderPct + "%" } })
							)
							: null
					),
					// 消耗统计格
					createElement("div", { className: "qw-cell" },
						createElement("div", { className: "qw-head" },
							createElement("span", { className: "qw-dot qw-dot-off" }),
							createElement("span", { className: "qw-name" }, "消耗")
						),
						createElement("div", { className: "qw-val" },
							consumedCredit != null ? fmt(consumedCredit) + " credits" : "—"
						),
						createElement("div", { className: "qw-sub" },
							totalReqs ? totalReqs + " 次请求" : "—"
						)
					)
				),
				// 底栏：刷新按钮
				createElement("div", { className: "qw-foot" },
					createElement("span", { className: "qw-foot-txt" },
						data && data.at ? new Date(data.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + " 更新" : ""
					),
					createElement("button", {
						className: "qw-refresh",
						onClick: function (e) { e.stopPropagation(); fetchData(); },
						disabled: isLoading,
					}, isLoading ? "刷新中…" : "↻ 刷新")
				)
			);
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.inject(["slots"], function (sctx) {
				if (typeof sctx.slots.inject === "function") {
					sctx.slots.inject("sidebar.footer.action", function () {
						return sctx.slots.register(
							{
								name: "sidebar.footer.action",
								id: "dsh-tap-quota",
								order: 10,
								label: function () { return "余量"; },
								inject: function () { return {}; },
							},
							QuotaWidget,
						);
					});
				} else {
					sctx.slots.register(
						{
							name: "sidebar.footer.action",
							id: "dsh-tap-quota",
							order: 10,
							label: function () { return "余量"; },
							inject: function () { return {}; },
						},
						QuotaWidget,
					);
				}
			});
		}

		exports.ROUTE = ROUTE;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
