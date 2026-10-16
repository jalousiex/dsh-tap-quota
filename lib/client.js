/**
 * Browser half of dsh-tap-quota: a sidebar quota widget.
 *
 * Registers a QuotaWidget component in the sidebar.footer.action slot
 * (dsh ≥ 0.1.6). The widget polls the dsh-tap plugin's /dsh-tap/settings
 * route every 60s for three channels' quota snapshots plus the usage
 * meter's consumed-credit total, and renders a compact multi-row display
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
			".qw-wrap{display:flex;flex-direction:column;gap:2px;padding:4px 12px;min-width:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,gray)}",
			".qw-row{display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".qw-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}",
			".qw-dot-ok{background:var(--dsw-alias-state-success-primary,#2a9d4a)}",
			".qw-dot-warn{background:var(--dsw-alias-state-warn-primary,#b80)}",
			".qw-dot-err{background:var(--dsw-alias-state-error-primary,#d33)}",
			".qw-dot-off{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,rgba(128,128,128,.45))}",
			".qw-name{font-weight:500;color:var(--dsw-alias-label-secondary,inherit);flex:0 0 auto}",
			".qw-val{font-family:var(--ds-font-family-code,monospace);color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis}",
			".qw-bar{display:flex;gap:3px;margin-top:2px}",
			".qw-minibar{flex:1;height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.15));overflow:hidden;min-width:20px}",
			".qw-minibar-fill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,#1a66ff)}",
			".qw-minibar-fill-warn{background:var(--dsw-alias-state-warn-primary,#b80)}",
			".qw-minibar-fill-err{background:var(--dsw-alias-state-error-primary,#d33)}",
			".qw-refresh{all:unset;cursor:pointer;font-size:10px;color:var(--dsw-alias-state-business-primary,#1a66ff);padding:2px 0;display:inline-flex;align-items:center;gap:3px;margin-top:2px}",
			".qw-refresh:hover{text-decoration:underline}",
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="dsh-tap-quota"]')) return;
			var el = document.createElement("style");
			el.setAttribute("data-plugin", "dsh-tap-quota");
			el.setAttribute("data-plugin-css", "dsh-tap-quota");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
		}

		function QuotaWidget() {
			var s = useState(null);
			var data = s[0];
			var setData = s[1];
			var loading = useState(false);
			var isLoading = loading[0];
			var setLoading = loading[1];

			var fmt = function (n) {
				if (n == null || isNaN(n)) return "—";
				if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
				if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
				return n.toFixed(1);
			};

			var pctClass = function (remain, total) {
				if (!total || total <= 0) return "ok";
				var pct = remain / total;
				if (pct < 0.1) return "err";
				if (pct < 0.3) return "warn";
				return "ok";
			};

			var fetchData = function () {
				setLoading(true);
				var opts = { method: "POST", signal: AbortSignal.timeout(12000) };
				var jsonType = { "Content-Type": "application/json" };

				var cbP = fetch(ROUTE, Object.assign({}, opts, {
					headers: jsonType,
					body: JSON.stringify({ action: "usage" }),
				})).then(function (r) { return r.json(); }).catch(function () { return null; });

				var traeP = fetch(ROUTE, Object.assign({}, opts, {
					headers: jsonType,
					body: JSON.stringify({ action: "trae-quota" }),
				})).then(function (r) { return r.json(); }).catch(function () { return null; });

				var qoderP = fetch(ROUTE, Object.assign({}, opts, {
					headers: jsonType,
					body: JSON.stringify({ action: "qoder-quota" }),
				})).then(function (r) { return r.json(); }).catch(function () { return null; });

				Promise.all([cbP, traeP, qoderP]).then(function (results) {
					var cb = results[0];
					var trae = results[1];
					var qoder = results[2];
					setData({
						cb: cb || {},
						trae: trae || {},
						qoder: qoder || {},
						at: Date.now(),
					});
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
			var cbCycleUsed = cbRes && cbRes.cycleUsed;
			var cbCycleSize = cbRes && cbRes.cycleSize;
			var cbCycleRemain = cbRes && cbRes.cycleRemain;
			var cbUsage = data && data.cb && data.cb.usage;
			var cbTotalCredit = cbUsage && cbUsage.totalCredit;
			var cbError = cbQuota && cbQuota.error;
			var cbCls = cbError ? "err" : cbRemain != null ? pctClass(cbRemain, cbCycleSize) : "off";

			// --- Trae ---
			var traeQ = data && data.trae && data.trae.quota;
			var traePools = traeQ && traeQ.pools;
			var traeIde = traePools && traePools.ide;
			var traeWork = traePools && traePools.work;
			var traeRemain = traeIde ? traeIde.remain : null;
			var traeLimit = traeIde ? traeIde.limit : null;
			var traeErr = traeQ && traeQ.error;
			var traeCls = traeErr ? "err" : traeRemain != null ? pctClass(traeRemain, traeLimit) : "off";

			// --- Qoder ---
			var qoderQ = data && data.qoder && data.qoder.quota;
			var qoderUser = qoderQ && qoderQ.userQuota;
			var qoderAddOn = qoderQ && qoderQ.addOnQuota;
			var qoderRemain = qoderUser ? qoderUser.remaining : null;
			var qoderTotal = qoderUser ? qoderUser.total : null;
			var qoderErr = qoderQ && qoderQ.error;
			var qoderCls = qoderErr ? "err" : qoderRemain != null ? pctClass(qoderRemain, qoderTotal) : "off";

			// --- 已消耗积分（来自 usage meter）---
			var consumedCredit = cbTotalCredit != null ? cbTotalCredit : null;

			return createElement("div", { className: "qw-wrap", title: "三通道余量概览" },
				// CodeBuddy 行
				createElement("div", { className: "qw-row" },
					createElement("span", { className: "qw-dot qw-dot-" + cbCls }),
					createElement("span", { className: "qw-name" }, "CB"),
					createElement("span", { className: "qw-val" },
						cbError ? "错误"
							: cbRemain != null
								? fmt(cbRemain) + " 剩余" + (cbCycleSize ? " / " + fmt(cbCycleSize) : "")
								: consumedCredit != null
									? "已用 " + fmt(consumedCredit) + " credits"
									: "—"
					)
				),
				// CodeBuddy 进度条（有周期数据时显示）
				cbCycleSize > 0
					? createElement("div", { className: "qw-bar" },
						createElement("span", { className: "qw-minibar" },
							createElement("span", {
								className: "qw-minibar-fill" + (cbCls === "warn" ? " qw-minibar-fill-warn" : cbCls === "err" ? " qw-minibar-fill-err" : ""),
								style: { width: Math.max(0, Math.min(100, ((cbCycleSize - cbCycleRemain) / cbCycleSize) * 100)) + "%" },
							})
						)
					)
					: null,
				// Trae 行
				createElement("div", { className: "qw-row" },
					createElement("span", { className: "qw-dot qw-dot-" + traeCls }),
					createElement("span", { className: "qw-name" }, "Trae"),
					createElement("span", { className: "qw-val" },
						traeErr ? "错误"
							: traeRemain != null
								? fmt(traeRemain) + " IDE" + (traeWork ? " / " + fmt(traeWork.remain) + " Work" : "")
								: "—"
					)
				),
				// Trae 进度条
				traeLimit > 0
					? createElement("div", { className: "qw-bar" },
						createElement("span", { className: "qw-minibar" },
							createElement("span", {
								className: "qw-minibar-fill" + (traeCls === "warn" ? " qw-minibar-fill-warn" : traeCls === "err" ? " qw-minibar-fill-err" : ""),
								style: { width: Math.max(0, Math.min(100, (traeIde.used / traeLimit) * 100)) + "%" },
							})
						)
					)
					: null,
				// Qoder 行
				createElement("div", { className: "qw-row" },
					createElement("span", { className: "qw-dot qw-dot-" + qoderCls }),
					createElement("span", { className: "qw-name" }, "Qoder"),
					createElement("span", { className: "qw-val" },
						qoderErr ? "错误"
							: qoderRemain != null
								? fmt(qoderRemain) + (qoderUser && qoderUser.unit ? " " + qoderUser.unit : "") + (qoderTotal ? " / " + fmt(qoderTotal) : "")
								: "—"
					)
				),
				// Qoder 进度条
				qoderTotal > 0
					? createElement("div", { className: "qw-bar" },
						createElement("span", { className: "qw-minibar" },
							createElement("span", {
								className: "qw-minibar-fill" + (qoderCls === "warn" ? " qw-minibar-fill-warn" : qoderCls === "err" ? " qw-minibar-fill-err" : ""),
								style: { width: Math.max(0, Math.min(100, ((qoderTotal - qoderRemain) / qoderTotal) * 100)) + "%" },
							})
						)
					)
					: null,
				// 已消耗积分总览
				consumedCredit != null
					? createElement("div", { className: "qw-row", style: { marginTop: "2px", borderTop: "1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))", paddingTop: "2px" } },
						createElement("span", { className: "qw-val", style: { fontSize: "10px" } },
							"累计消耗: " + fmt(consumedCredit) + " credits"
							+ (data && data.cb && data.cb.usage && data.cb.usage.totalRequests ? " / " + data.cb.usage.totalRequests + " 次请求" : "")
						)
					)
					: null,
				// 刷新按钮
				createElement("button", {
					className: "qw-refresh",
					onClick: function (e) { e.stopPropagation(); fetchData(); },
					disabled: isLoading,
				}, isLoading ? "刷新中…" : "↻ 刷新")
			);
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.inject(["slots"], function (sctx) {
				// sidebar.footer.action 是 list 槽，在左侧菜单底部 Settings 按钮旁
				// 渲染额外条目。两路径都注册（与 dsh-tap 同纪律）。
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
