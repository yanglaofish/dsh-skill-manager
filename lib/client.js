/**
 * dsh-skill-manager — web client half.
 *
 * Registers a "技能管理" settings page listing every skill found in the
 * active + disabled skill directories, with per-skill actions:
 *   - view / edit content (frontmatter + body) inline
 *   - enable / disable (move between skills/ and skills-disabled/)
 *   - delete (permanent)
 *   - import a skill .zip (must contain a root SKILL.md with a kebab-case
 *     `name` in its frontmatter)
 *
 * All data flows through the same-origin /skill-manager/api endpoints served
 * by the host half.
 */
window.__ModuleLoader__.load({
	id: "@yanglaofish/dsh-skill-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { useEffect, useState, useCallback, useRef } = react;
		// dsh's own GFM renderer (seed word): full CommonMark + tables + TeX
		// math (KaTeX) + syntax-highlighted code fences, raw HTML disabled.
		// Used to render .md files in the file browser's view (non-edit) state.
		// Resolved defensively: when the package is absent from the client
		// module table (desktop builds have differed here) `require` throws or
		// yields a namespace without MarkdownText, and an undefined component
		// reaching createElement throws "Element type is invalid" DURING RENDER
		// — which unmounts the whole panel tree and looks like a crash. Probe
		// once, fall back to a plain <pre> viewer instead.
		const primitives = (() => {
			try { return require("@deepseek-ai/dsh-client-ui-primitives") ?? null; } catch { return null; }
		})();
		const MarkdownText = typeof primitives?.MarkdownText === "function" ? primitives.MarkdownText : null;

		const API = "/skill-manager/api";

		// Render-fault containment. React unmounts up to the nearest error
		// boundary when a render throws, so without one a single bad subtree
		// (an unfamiliar host payload, a markdown render failure) takes the
		// entire settings surface down with it. Each slot entry point is
		// wrapped, so a fault degrades to this panel only.
		class PanelBoundary extends react.Component {
			constructor(props) { super(props); this.state = { error: null }; }
			static getDerivedStateFromError(error) { return { error }; }
			componentDidCatch(error, info) {
				try { console.error("[skill-manager] render error:", error, info?.componentStack ?? ""); } catch { /* console unavailable */ }
			}
			render() {
				if (this.state.error) {
					return react.createElement("div", { className: "dskm" },
						react.createElement("div", { className: "dskm_errblock" },
							"技能管理面板渲染出错：" + String(this.state.error?.message ?? this.state.error)),
						react.createElement("button", {
							className: "dskm_btn",
							style: { alignSelf: "flex-start" },
							onClick: () => this.setState({ error: null }),
						}, "重试渲染")
					);
				}
				return this.props.children;
			}
		}

		// Shared async wrapper: flip the busy flag on/off, clear the notice,
		// surface any uncaught error as a notice. Every async handler uses it so
		// the try/catch/finally boilerplate lives in exactly one place.
		const withBusy = async (setBusy, setNotice, fn) => {
			setBusy(true);
			setNotice("");
			try {
				return await fn();
			} catch (e) {
				setNotice(String(e));
			} finally {
				setBusy(false);
			}
		};

		const css =
			".dskm{display:flex;flex-direction:column;gap:12px;padding:4px 0}" +
			".dskm_h{display:flex;align-items:center;justify-content:space-between;gap:8px}" +
			".dskm_hbtn{flex:none}" +
			".dskm_row{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-tip)}" +
			".dskm_ws{display:flex;flex-direction:column;gap:8px}" +
			".dskm_wsbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
			".dskm_wsrow{margin:2px 0 8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-tip)}" +
			".dskm_libhint{opacity:.75}" +
			".dskm_wshead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:22px}" +
			".dskm_mode{flex:none;font-size:11px;line-height:20px;padding:0 10px;border-radius:20px;font-weight:700;white-space:nowrap;letter-spacing:.2px;user-select:none}" +
			".dskm_mode_follow{background:#2563eb;color:#fff;border:1px solid #60a5fa;text-shadow:0 1px 2px rgba(0,0,0,.35)}" +
			".dskm_mode_pin{background:#f59e0b;color:#1f2937;border:1px solid #fbbf24;text-shadow:none;font-weight:800}" +
			".dskm_followbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
			".dskm_followbtn{flex:none;font-size:11px;line-height:20px;padding:2px 10px;border-radius:14px;font-weight:600;border-color:rgba(96,165,250,.6);color:#93c5fd}" +
			".dskm_followbtn:hover{background:rgba(59,130,246,.18);border-color:#60a5fa}" +
			".dskm_wsrow .dskm_select{flex:1;min-width:0}" +
			".dskm_input{flex:1 1 220px;min-width:160px;font-size:12px;line-height:16px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary)}" +
			".dskm_layers{display:flex;flex-direction:column;gap:4px}" +
			".dskm_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));gap:8px}" +
			".dskm_g2{grid-template-columns:repeat(2,minmax(0,1fr))}" +
			".dskm_g4{grid-template-columns:repeat(4,minmax(0,1fr))}" +
			".dskm_viewbar{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:11px}" +
			".dskm_viewbtn{line-height:18px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;font-weight:600;transition:background .12s,border-color .12s,color .12s}" +
			".dskm_viewbtn:hover{border-color:var(--dsw-alias-accent);color:var(--dsw-alias-accent)}" +
			".dskm_viewbtn_on{background:rgba(59,130,246,.14);border-color:rgba(96,165,250,.65);color:#93c5fd}" +
			".dskm_card{display:flex;flex-direction:column;gap:5px;min-height:104px;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-tip);cursor:pointer;transition:border-color .12s,background .12s,opacity .12s,transform .12s,box-shadow .12s}" +
			".dskm_card:hover{border-color:var(--dsw-alias-accent);background:var(--dsw-alias-state-hover);transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,.10)}" +
			".dskm_card_dis{cursor:default;opacity:.55}" +
			".dskm_card_static{cursor:default}" +
			".dskm_card_dis:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);transform:none;box-shadow:none}" +
			".dskm_card_on{border-color:rgba(16,185,129,.4);background:rgba(16,185,129,.06)}" +
			".dskm_card_off{opacity:.72}" +
			".dskm_card_on:hover{border-color:rgba(16,185,129,.55);background:rgba(16,185,129,.12)}" +
			".dskm_card_off:hover{opacity:.9}" +
			".dskm_g4 .dskm_card{min-height:74px;padding:7px 9px;gap:3px;border-radius:8px}" +
			".dskm_g4 .dskm_cardname{font-size:12px}" +
			".dskm_g4 .dskm_carddesc{-webkit-line-clamp:1;font-size:10.5px;line-height:14px;white-space:nowrap;text-overflow:ellipsis;display:block;overflow:hidden}" +
			".dskm_g4 .dskm_cardacts{gap:4px}" +
			".dskm_g4 .dskm_cardacts .dskm_btn{font-size:10.5px;line-height:14px;padding:2px 6px;border-radius:6px}" +
			".dskm_cardhead{display:flex;align-items:center;gap:6px;min-width:0}" +
			".dskm_cardname{font-size:13px;font-weight:700;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
			".dskm_carddesc{flex:1;min-height:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}" +
			".dskm_cardtag{display:flex;gap:4px;align-items:center;flex-wrap:wrap}" +
			".dskm_cardacts{display:flex;gap:6px;margin-top:auto;padding-top:2px;flex-wrap:wrap}" +
			".dskm_litem{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:16px;cursor:pointer;border:1px solid transparent;user-select:none;transition:opacity .12s,background .12s}" +
			".dskm_litem:hover{background:var(--dsw-alias-state-hover)}" +
			".dskm_litem:active{transform:translateY(.5px)}" +
			".dskm_litem_on{background:rgba(16,185,129,.09);border-color:rgba(16,185,129,.25)}" +
			".dskm_litem_on:hover{background:rgba(16,185,129,.14)}" +
			".dskm_litem_on .dskm_name{color:var(--dsw-alias-label-primary)}" +
			".dskm_litem_on .dskm_desc{color:var(--dsw-alias-label-secondary)}" +
			".dskm_litem_off{opacity:.45;filter:grayscale(.55);border-color:var(--dsw-alias-border-l2);background:transparent}" +
			".dskm_litem_off:hover{opacity:.85;filter:grayscale(.25);border-color:var(--dsw-alias-border-l1)}" +
			".dskm_litem_dis{cursor:default;opacity:.6}" +
			".dskm_litem_lib .dskm_name{color:var(--dsw-alias-label-secondary)}" +
			".dskm_litem_lib .dskm_desc{color:var(--dsw-alias-label-tertiary)}" +
			".dskm_litem_lib .dskm_dot_on{background:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-label-tertiary);box-shadow:none}" +
			".dskm_litem_lib{cursor:default}" +
			".dskm_litem_lib.dskm_litem_on{background:transparent;border-color:transparent}" +
			".dskm_litem_lib.dskm_litem_on:hover{background:var(--dsw-alias-state-hover);border-color:var(--dsw-alias-border-l1)}" +
			".dskm_litem_lib.dskm_litem_on:active{transform:none}" +
			".dskm_litem .dskm_name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}" +
			".dskm_litem .dskm_desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}" +
			".dskm_litem .dskm_btn{flex:none;white-space:nowrap}" +
			".dskm_acts{display:flex;align-items:center;gap:6px;flex:none}" +
			".dskm_dot{flex:none;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--dsw-alias-label-tertiary);box-sizing:border-box;background:transparent}" +
			".dskm_dot_on{background:#10b981;border-color:#10b981;box-shadow:0 0 0 1px rgba(16,185,129,.25)}" +
			".dskm_litem input{accent-color:var(--dsw-alias-accent)}" +
			".dskm_tag{flex:none;font-size:10px;line-height:14px;padding:0 6px;border-radius:999px;font-weight:600}" +
			".dskm_tag_gl{color:#1d4ed8;background:rgba(59,130,246,.15)}" +
			".dskm_tag_ws{color:#0c7a3d;background:rgba(16,185,129,.14)}" +
			".dskm_tag_preset{color:#6d28d9;background:rgba(139,92,246,.16)}" +
			".dskm_tag_sess{color:#b45309;background:rgba(245,158,11,.16)}" +
			".dskm_tag_warn{color:#b91c1c;background:rgba(239,68,68,.16);cursor:help;border:1px solid rgba(239,68,68,.28)}" +
			".dskm_legend{font-size:11px;color:var(--dsw-alias-label-caption);padding:2px 2px 0}" +
			".dskm_check{display:flex;align-items:center;gap:6px;margin:2px 0;font-size:12px;cursor:pointer}" +
			".dskm_check input{accent-color:var(--dsw-alias-accent)}" +
			".dskm_sect{font-size:12px;font-weight:700;color:var(--dsw-alias-label-primary);padding:8px 2px 4px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:4px}" +
			".dskm_dock{display:flex;flex-direction:column;gap:6px;width:100%}" +
			".dskm_dockbtn{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;padding:4px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);cursor:pointer;align-self:flex-start}" +
			".dskm_dockbtn:hover{background:var(--dsw-alias-state-hover)}" +
			".dskm_stats{display:flex;gap:6px;flex-wrap:wrap;padding:2px 2px 6px}" +
			".dskm_stat{font-size:11px;line-height:16px;padding:2px 10px;border-radius:999px;font-weight:600;flex:none}" +
			".dskm_stat_total{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-hover)}" +
			".dskm_stat_preset{color:#6d28d9;background:rgba(139,92,246,.16)}" +
			".dskm_stat_ws{color:#1d4ed8;background:rgba(59,130,246,.15)}" +
			".dskm_tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:8px}" +
			".dskm_tab{font-size:12px;line-height:16px;padding:6px 14px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-bottom:2px solid transparent}" +
			".dskm_tab:hover{color:var(--dsw-alias-label-primary)}" +
			".dskm_tab_on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-accent);font-weight:600}" +
			".dskm_badge{flex:none;font-size:11px;line-height:16px;padding:0 8px;border-radius:999px;font-weight:600}" +
			".dskm_on{color:#0c7a3d;background:rgba(16,185,129,.14)}" +
			".dskm_off{color:#b45309;background:rgba(245,158,11,.16)}" +
			".dskm_name{font-weight:600;font-size:13px;line-height:18px}" +
			".dskm_verbadge{font-size:10px;font-weight:600;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-caption);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 6px;margin-left:8px;vertical-align:middle}" +
			".dskm_desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-all}" +
			".dskm_acts{display:flex;gap:6px;margin-left:auto;flex:none}" +
			".dskm_btn{font-size:12px;line-height:16px;padding:3px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}" +
		".dskm_btn:disabled{opacity:.6;cursor:not-allowed}" +
			".dskm_btn:hover{background:var(--dsw-alias-state-hover)}" +
			".dskm_danger{color:#dc2626}" +
			".dskm_edit{display:flex;flex-direction:column;gap:8px;margin-top:8px}" +
			".dskm_edit textarea{width:100%;min-height:220px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);box-sizing:border-box}" +
			".dskm_empty{font-size:12px;color:var(--dsw-alias-label-caption);padding:16px 0;text-align:center}" +
			".dskm_errblock{white-space:pre-wrap;color:#dc2626;border:1px solid rgba(220,38,38,.3);background:rgba(220,38,38,.08);border-radius:8px;padding:8px 10px;margin:6px 0;font-size:12px;line-height:18px}" +
			".dskm_search{display:flex;gap:6px;margin-bottom:8px;align-items:center}" +
			".dskm_search .dskm_input{flex:1;min-width:0}" +
			".dskm_search .dskm_viewbar{margin-left:auto}" +
			".dskm_snip{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:4px;background:var(--dsw-alias-state-hover);border-radius:6px;padding:4px 8px;font-family:ui-monospace,Consolas,monospace;word-break:break-all}" +
			".dskm_mask{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}" +
			".dskm_modal{width:min(780px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:var(--dsw-shadow-lv3);overflow:hidden}" +
			".dskm_mhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}" +
			".dskm_mbody{flex:1;min-height:0;overflow-y:auto;padding:14px 18px}" +
			".dskm_pager{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 0 2px}" +
		".dskm_modal_wide{width:min(1100px,94vw)}" +
		".dskm_badge{font-size:11px;font-weight:600;color:var(--dsw-alias-accent);border:1px solid var(--dsw-alias-accent);border-radius:6px;padding:1px 6px;margin-left:8px}" +
		".dskm_ftouter{display:flex;flex-direction:column;height:62vh;min-height:62vh;max-height:80vh;padding:0;overflow:hidden}" +
		".dskm_dragging{user-select:none}" +
		".dskm_ftwrap{flex:1;min-height:0;display:flex;flex-direction:row;gap:0;padding:0;position:relative;overflow:hidden}" +
		".dskm_ftleft{flex:0 0 200px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:8px 4px;min-width:0}" +
		".dskm_resizer{flex:none;width:5px;cursor:col-resize;background:transparent;transition:background .12s}" +
		".dskm_resizer:hover,.dskm_resizing{background:var(--dsw-alias-state-hover)}" +
		".dskm_resizery{flex:none;height:5px;cursor:row-resize;background:transparent;border-top:1px solid var(--dsw-alias-border-l1);transition:background .12s}" +
		".dskm_resizery:hover,.dskm_resizery.dskm_resizing{background:var(--dsw-alias-state-hover)}" +
		".dskm_ftright{flex:1;min-width:0;overflow:hidden;display:flex;flex-direction:column}" +
		".dskm_ftnode{display:flex;align-items:center;gap:2px;cursor:pointer;padding:3px 7px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);border-radius:6px;border:1px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;transition:background .12s,border-color .12s}" +
		".dskm_caret{flex:none;font-size:9px;color:var(--dsw-alias-label-caption);min-width:9px;text-align:center}" +
		".dskm_ftname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
		".dskm_ftnode:hover{background:var(--dsw-alias-state-selected);border-color:var(--dsw-alias-border-l1)}" +
		".dskm_ftsel{background:var(--dsw-alias-state-selected);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);font-weight:600}" +
		".dskm_fview{flex:1;min-height:0;margin:0;padding:10px 14px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary)}" +
		".dskm_mdview{flex:1;min-height:0;overflow:auto;padding:10px 14px;background:var(--dsw-specific-input)}" +
		".dskm_mdview h2{font-size:16px;font-weight:700;margin:14px 0 8px}" +
		".dskm_mdview h3{font-size:14px;font-weight:700;margin:12px 0 6px}" +
		".dskm_mdview h4{font-size:13px;font-weight:600;margin:10px 0 4px}" +
		".dskm_mdview p{margin:6px 0}" +
		".dskm_mdview ul,.dskm_mdview ol{margin:6px 0 6px 20px}" +
		".dskm_mdview li{margin:2px 0}" +
		".dskm_mdview pre{margin:8px 0;padding:10px 12px;background:var(--dsw-specific-input);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow-x:auto;font-size:12px;line-height:17px}" +
		".dskm_mdview code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--dsw-alias-state-hover);border-radius:4px;padding:1px 4px}" +
		".dskm_mdview pre code{background:none;padding:0}" +
		".dskm_mdview blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--dsw-alias-accent);color:var(--dsw-alias-label-secondary)}" +
		".dskm_mdview hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0}" +
		".dskm_mdview a{color:var(--dsw-alias-accent);text-decoration:underline}" +
		".dskm_mdview table{border-collapse:collapse;margin:8px 0;font-size:12px;line-height:17px}" +
		".dskm_mdview th,.dskm_mdview td{border:1px solid var(--dsw-alias-border-l2);padding:4px 10px;text-align:left}" +
		".dskm_mdview th{background:var(--dsw-alias-state-hover);font-weight:600}" +
		".dskm_mdview img{max-width:100%}" +
		".dskm_ftbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}" +
		".dskm_ftpath{flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
		".dskm_ftbtns{display:flex;gap:6px;flex:none;align-items:center}" +
		".dskm_ftedit{flex:none}" +
		".dskm_ftsave{flex:none}" +
		".dskm_savebtn{flex:none;border-color:var(--dsw-alias-accent);color:var(--dsw-alias-accent);font-weight:600}" +
		".dskm_fta{flex:1;min-height:0;width:100%;margin:0;padding:10px 14px;border:none;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;white-space:pre;overflow-y:auto;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);resize:none;outline:none}" +
		".dskm_fview{flex:1;margin:0;padding:10px 14px;overflow-y:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);max-height:55vh}" +
		// Host-wrap alignment: inside the conversation transcript column the
		// width handles resize --dsh-chat-content-width; tracking it keeps the
		// panel body aligned with those handles so dragging resizes the panel.
		// box-sizing:border-box keeps the full column width (padding included)
		// within the tracked width, matching how the host sizes its transcript.
		".dskm_ws_col{box-sizing:border-box;width:var(--dsh-chat-content-width,100%);max-width:100%;margin:0 auto}" +
		// overwrite-confirm card (directory import colliding with library names)
		".dskm_importconfirm{margin:10px 0;padding:12px 14px;border:1px solid var(--dsw-alias-accent);background:var(--dsw-alias-state-selected-bg,var(--dsw-alias-state-hover))}" +
		".dskm_importconf_title{font-size:13px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
		".dskm_importconf_list{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 2px}" +
		".dskm_importconf_btns{display:flex;gap:8px;align-items:center;flex:none}" +
		".dskm_badge{padding:2px 8px;border-radius:10px;font-size:11px;line-height:16px;background:var(--dsw-alias-state-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}";
		const tagId = "@yanglaofish/dsh-skill-manager/styles.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@yanglaofish/dsh-skill-manager";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		async function api(path, options) {
			const res = await fetch(API + path, options);
			// The fence answers 403 with a text/plain body, and a dead host can
			// answer an HTML error page; res.json() would reject and surface as
			// an unhandled rejection in fire-and-forget callers. Normalize to a
			// { ok:false } result instead so every caller's !data.ok branch owns
			// the failure.
			let data;
			try { data = await res.json(); }
			catch {
				return { ok: false, error: `请求失败（HTTP ${res.status}）` };
			}
			if (data && typeof data === "object" && data.ok === undefined) data.ok = res.ok;
			return data;
		}

		const PRESET_LABEL_TEXT = "preset";

		// ---------- skill detail modal (GFM preview + raw edit) ----------
		// Recursive file-tree node for browsing a directory-form skill's
		// folder (SKILL.md + reference/ + assets/ + scripts/ …). Directories
		// toggle open/closed; files call back with their relative path.
		function FileTreeNode({ node, depth, selected, onSelect }) {
			const [open, setOpen] = useState(depth < 1);
			if (node.type === "dir") {
				return react.createElement("div", null,
					react.createElement("div", {
						className: "dskm_ftnode",
						style: { paddingLeft: (depth * 14) + "px" },
						onClick: () => setOpen(!open)
					},
						react.createElement("span", { className: "dskm_caret" }, open ? "▾" : "▸"),
						react.createElement("span", { className: "dskm_ftname" }, "📁 " + node.name)
					),
					open && node.children ? node.children.map((c) =>
						react.createElement(FileTreeNode, { key: c.path, node: c, depth: depth + 1, selected, onSelect })
					) : null
				);
			}
			return react.createElement("div", {
				className: "dskm_ftnode" + (selected === node.path ? " dskm_ftsel" : ""),
				style: { paddingLeft: (depth * 14) + "px" },
				onClick: () => onSelect(node.path)
			}, react.createElement("span", { className: "dskm_ftname" }, "📄 " + node.name));
		}

		// Find the skill's main document inside a file tree (root-level
		// SKILL.md preferred, recursive fallback for nested layouts).
		function findSkillMdPath(nodes) {
			for (const n of nodes || []) {
				if (n.name === "SKILL.md") return n.path;
				const p = findSkillMdPath(n.children);
				if (p) return p;
			}
			return null;
		}

		function SkillDetailModal({ skill, cwd, onClose }) {
			const [err, setErr] = useState("");
			// directory-form skill file tree state (directory form is the only
			// canonical layout — folder + SKILL.md)
			const [fileTree, setFileTree] = useState(null); // null=loading, []=empty
			const [treeError, setTreeError] = useState("");
			const [selFile, setSelFile] = useState(""); // highlighted row (user clicks only)
			const [curFile, setCurFile] = useState(""); // file actually open (saving/ftbar use it)
			const [fileContent, setFileContent] = useState(null);
			const [fileDraft, setFileDraft] = useState("");
			const [fileLoading, setFileLoading] = useState(false);
			const [fileDirty, setFileDirty] = useState(false);
			const [fileSaving, setFileSaving] = useState(false);
			const [fileEditing, setFileEditing] = useState(false);
			// left/right splitter: draggable, clamped to [15%, 60%] of the wrap
			const ftRef = useRef(null);
			const [leftW, setLeftW] = useState(200);
			const [dragging, setDragging] = useState(false);
			const startResize = (e) => {
				e.preventDefault();
				const onMove = (ev) => {
					const wrap = ftRef.current;
					if (!wrap) return;
					const rect = wrap.getBoundingClientRect();
					const w = ev.clientX - rect.left;
					setLeftW(Math.min(Math.max(w, rect.width * 0.15), rect.width * 0.6));
				};
				const onUp = () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
					setDragging(false);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
				setDragging(true);
			};
			// vertical splitter: container height, clamped to [30%, 80%] of the viewport
			const [wrapH, setWrapH] = useState("62vh");
			const startResizeY = (e) => {
				e.preventDefault();
				const onMove = (ev) => {
					const wrap = ftRef.current;
					if (!wrap) return;
					const rect = wrap.getBoundingClientRect();
					const h = ev.clientY - rect.top;
					setWrapH(Math.min(Math.max(h, window.innerHeight * 0.3), window.innerHeight * 0.8) + "px");
				};
				const onUp = () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
					setDragging(false);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
				setDragging(true);
			};

			useEffect(() => {
				let cancelled = false;
				setFileTree(null);
				setTreeError("");
				setSelFile("");
				setCurFile("");
				setFileContent(null);
				setFileDraft("");
				setFileDirty(false);
				const qs = "/skill-files?name=" + encodeURIComponent(skill?.name ?? "") + (cwd ? "&cwd=" + encodeURIComponent(cwd) : "");
				api(qs).then((data) => {
					if (cancelled) return;
					if (data.ok) {
						setFileTree(data.files ?? []);
						// default to SKILL.md — the skill's main document — and
						// highlight it (neutral bright row, not the green tint)
						const md = findSkillMdPath(data.files ?? []);
						if (md) loadFile(md);
					} else setTreeError(data.error ?? "文件树加载失败");
				}).catch(() => { if (!cancelled) setTreeError("文件树加载失败"); });
				return () => { cancelled = true; };
			}, [skill?.name, cwd]);

			const loadFile = async (relPath, select = true) => {
				setCurFile(relPath);
				if (select) setSelFile(relPath);
				setFileLoading(true);
				setFileContent(null);
				setFileDraft("");
				setFileDirty(false);
				setFileEditing(false);
				try {
					const qs = "/skill-file?name=" + encodeURIComponent(skill.name) + "&path=" + encodeURIComponent(relPath) + (cwd ? "&cwd=" + encodeURIComponent(cwd) : "");
					const data = await api(qs);
					if (data.ok) {
						setFileContent(data.content);
						setFileDraft(data.content ?? "");
					} else {
						setFileContent(null);
					}
				} catch { setFileContent(null); }
				finally { setFileLoading(false); }
			};

			const cancelFile = () => {
				setFileDraft(fileContent ?? "");
				setFileDirty(false);
				setFileEditing(false);
			};

			const saveFile = async () => {
				if (!curFile) return;
				// host readJsonBody caps writes at 2MB — check locally first
				if (fileDraft.length > 2 * 1024 * 1024) {
					setErr("内容超过 2MB 保存上限（单文件 ≤2MB）");
					return;
				}
				await withBusy(setFileSaving, setErr, async () => {
					const data = await api("/skill-file", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: skill.name, path: curFile, content: fileDraft, cwd: cwd || undefined }),
					});
					if (data.ok) {
						setFileContent(fileDraft);
						setFileDirty(false);
						setFileEditing(false);
						setErr("");
					} else {
						setErr(data.error ?? "保存失败");
					}
				});
			};

			if (!skill) return null;
			return react.createElement("div", { className: "dskm_mask",
					onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				react.createElement("div", { className: "dskm_modal dskm_modal_wide" },
					react.createElement("div", { className: "dskm_mhead" },
						react.createElement("span", { className: "dskm_name" }, skill.name || "技能详情"),
						react.createElement("button", { className: "dskm_btn", onClick: onClose }, "✕ 关闭")
					),
					// single surface: file browser (opens straight into SKILL.md)
					react.createElement("div", {
						className: "dskm_mbody dskm_ftouter",
						style: { height: wrapH, minHeight: wrapH, maxHeight: wrapH },
						ref: ftRef,
					},
						react.createElement("div", { className: "dskm_ftwrap" + (dragging ? " dskm_dragging" : "") },
							react.createElement("div", { className: "dskm_ftleft", style: { flex: "0 0 " + leftW + "px" } },
									fileTree === null
										? react.createElement("div", { className: "dskm_empty" }, "加载中…")
										: treeError
											? react.createElement("div", { className: "dskm_empty" }, treeError)
											: fileTree.length === 0
												? react.createElement("div", { className: "dskm_empty" }, "无文件")
												: fileTree.map((n) =>
													react.createElement(FileTreeNode, { key: n.path, node: n, depth: 0, selected: selFile, onSelect: loadFile })
												)
								),
							react.createElement("div", {
								className: "dskm_resizer" + (dragging ? " dskm_resizing" : ""),
								onMouseDown: startResize,
								title: "拖拽调整左右宽度（最小 15%）",
							}),
							react.createElement("div", { className: "dskm_ftright" },
								fileLoading
									? react.createElement("div", { className: "dskm_empty" }, "加载中…")
									: fileContent != null
										? react.createElement(react.Fragment, null,
											react.createElement("div", { className: "dskm_ftbar" },
												react.createElement("span", { className: "dskm_ftpath", style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, curFile),
												fileEditing
													? react.createElement("div", { style: { display: "flex", gap: "6px", flex: "none", alignItems: "center" } },
														react.createElement("button", { className: "dskm_btn", onClick: cancelFile, disabled: fileSaving }, "取消"),
														react.createElement("button", {
															className: "dskm_btn dskm_savebtn",
															disabled: fileSaving,
															onClick: saveFile,
														}, fileSaving ? "保存中…" : "保存 ✓")
													)
													: react.createElement("button", { className: "dskm_btn dskm_ftedit", onClick: () => setFileEditing(true) }, "✏ 编辑")
											),
											fileEditing
												? react.createElement("textarea", {
													className: "dskm_fta",
													value: fileDraft,
													spellCheck: false,
													onChange: (e) => { setFileDraft(e.target.value); setFileDirty(true); },
												})
												: /\.md$/i.test(curFile) && MarkdownText
													? react.createElement("div", { className: "dskm_mdview" },
														react.createElement(MarkdownText, { text: fileContent }))
													: react.createElement("pre", { className: "dskm_fview" }, fileContent)
										)
										: curFile
											? react.createElement("div", { className: "dskm_empty" }, "无法读取该文件")
											: react.createElement("div", { className: "dskm_empty" }, "选择左侧文件查看/编辑内容")
							)
						),
						react.createElement("div", {
							className: "dskm_resizery" + (dragging ? " dskm_resizing" : ""),
							onMouseDown: startResizeY,
							title: "拖拽调整高度（30%–80% 视口）",
						}),
					),
					err ? react.createElement("div", { className: "dskm_errblock" }, err) : null
				)
			);
		}

		function SkillManagerPanel(props) {
			const { initialSessionId = "" } = props;
			const [skills, setSkills] = useState([]);
			const [stats, setStats] = useState(null);
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState("");
			const [modalSkill, setModalSkill] = useState(null); // skill being viewed in modal
			const [pluginVer, setPluginVer] = useState(""); // bundle version from /view
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [tab, setTab] = useState("global"); // 'global' | 'workspace'
			const [wsCwd, setWsCwd] = useState(""); // workspace picker selection
			const [wsKnown, setWsKnown] = useState([]); // known workspaces for the picker
			const [query, setQuery] = useState("");
			const [results, setResults] = useState(null); // search results or null=idle
			const [searching, setSearching] = useState(false);
			const [page, setPage] = useState(0); // list pagination page index
			const [unmanaged, setUnmanaged] = useState(null); // ghost skills in engine roots; null=未检测
			const [layout, setLayout] = useState("rows"); // 'rows' | 'g2' | 'g4'
			// pending directory-import plan awaiting overwrite confirmation.
			// null = none; otherwise { groups, zipFiles, conflicts, names } where
			// conflicts = groups whose frontmatter name already exists in the
			// library (mirror import would replace them).
			const [importPlan, setImportPlan] = useState(null);
			// per-view page size: single rows=10, 2×5 grid=10, 4×5 grid=20
			const PAGE_SIZE = layout === "g4" ? 20 : 10;

			const refresh = useCallback(async () => {
				try {
					const data = await api("/list");
					if (data.ok) {
						setSkills(data.skills);
						setStats(data.stats ?? null);
						setError("");
					} else {
						setError(data.error ?? "加载失败");
					}
				} catch (e) {
					setError(String(e));
				} finally {
					// engine-root ghost scan: non-fatal, never blocks the list
					try {
						const um = await api("/unmanaged");
						if (um.ok) setUnmanaged(Array.isArray(um.items) ? um.items : []);
					} catch { /* keep previous state */ }
					setLoading(false);
				}
			}, []);

			useEffect(() => { refresh(); }, [refresh]);

			// load the workspace picker list + default to the current session's
			// workspace (independent row above the search box, not inside the
			// workspace panel frame)
			useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const data = await api("/view" + (initialSessionId ? "?sessionId=" + encodeURIComponent(initialSessionId) : ""));
						if (!alive) return;
						if (data.ok) {
							if (typeof data.version === "string") setPluginVer(data.version);
							if (Array.isArray(data.workspaces)) setWsKnown(data.workspaces);
							if (data.session?.cwd) setWsCwd(data.session.cwd);
							else if (Array.isArray(data.workspaces) && data.workspaces.length > 0) setWsCwd(data.workspaces[0].cwd);
						}
					} catch { /* non-fatal */ }
				})();
				return () => { alive = false; };
			}, [initialSessionId]);

			// debounced cross-layer search. The workspace picker (wsCwd)
			// drives the wsEnabled state shown on each result row so search
			// results can enable/disable skills right in place.
			const doSearch = useCallback(async (q, cwd) => {
				setSearching(true);
				try {
					const params = new URLSearchParams();
					if (q) params.set("q", q);
					if (initialSessionId) params.set("sessionId", initialSessionId);
					if (cwd) params.set("cwd", cwd);
					const data = await api("/search?" + params.toString());
					setResults(data.ok ? (data.results ?? []) : []);
				} catch {
					setResults([]);
				} finally {
					setSearching(false);
				}
			}, [initialSessionId]);

			useEffect(() => {
				const q = query.trim();
				if (!q) { setResults(null); setSearching(false); return; }
				const t = setTimeout(() => doSearch(q, wsCwd), 250);
				return () => clearTimeout(t);
			}, [query, wsCwd, doSearch]);

			const run = useCallback(async (op, name, extra) => {
				await withBusy(setBusy, setNotice, async () => {
					const data = await api("/" + op, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name, ...extra }),
					});
					setNotice(data.ok ? `${op} 成功` : data.error ?? "操作失败");
					if (data.ok) {
						if (op === "delete" && modalSkill && modalSkill.name === name) setModalSkill(null);
						await refresh();
					}
				});
			}, [refresh, modalSkill]);

			const adoptUnmanaged = async () => {
				await withBusy(setBusy, setNotice, async () => {
					const data = await api("/unmanaged/import", { method: "POST" });
					const nImp = (data.imported ?? []).length;
					const nRem = (data.removed ?? []).length;
					const nFail = (data.failed ?? []).length;
					setNotice(data.ok
						? `已收纳：${nImp} 个导入技能库、${nRem} 个移除引擎根副本` + (nFail ? `，${nFail} 个失败` : "")
						: data.error ?? "操作失败");
					await refresh();
				});
			};

			const scanUnmanaged = async () => {
				await withBusy(setBusy, setNotice, async () => {
					const um = await api("/unmanaged");
					if (um.ok) {
						const items = Array.isArray(um.items) ? um.items : [];
						setUnmanaged(items);
						setNotice(items.length
							? `扫描完成：发现 ${items.length} 个游离技能（引擎/项目源，未纳入库）`
							: "扫描完成：未发现游离技能");
					} else {
						setNotice(um.error ?? "扫描失败");
					}
				});
			};

			// extract the frontmatter `name` from a SKILL.md text (best-effort; the
			// server does authoritative validation on upload)
			const parseSkillName = (raw) => {
				const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
				const m = (fm ? fm[1] : raw).match(/^name:\s*([^\r\n]+)$/m);
				return m ? m[1].trim() : "";
			};

			// Do the actual upload: directory groups as base64 batch, zips as
			// raw buffers. Shared by the direct path (no conflicts) and the
			// confirmed overwrite path.
			const doImport = async (groups, zipFiles) => {
				await withBusy(setBusy, setNotice, async () => {
					const batch = [];
					// directory groups first: SKILL.md + all siblings as base64
					for (const g of groups) {
						const filesPayload = [];
						let payloadSize = 0;
						let over = false;
						for (const it of g.items) {
							const b64 = await fileToBase64(it.f);
							payloadSize += b64.length;
							if (payloadSize > 72 * 1024 * 1024) { over = true; break; } // JSON body guard (~1.37x of 50MB raw)
							filesPayload.push({ path: it.path, b64 });
						}
						if (over) continue; // already reported by the size pre-check
						batch.push({ source: g.root, files: filesPayload });
					}
					const zips = [];
					for (const f of zipFiles) {
						zips.push({ source: f.name, buf: await f.arrayBuffer() });
					}
					let mdResult = null;
					if (batch.length) {
						mdResult = await api("/import/batch", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ items: batch }),
						});
					}
					// then zips one by one
					const zipResults = [];
					for (const z of zips) {
						const r = await api("/import", { method: "POST", body: z.buf });
						zipResults.push({ source: z.source, ok: r.ok, name: r.name, error: r.error ?? "" });
					}
					const all = [
						...(mdResult?.ok && Array.isArray(mdResult.results) ? mdResult.results : []),
						...zipResults,
					];
					const okN = all.filter((r) => r.ok).length;
					const restoredN = all.filter((r) => r.ok).reduce((s, r) => s + (r.restored ?? 0), 0);
					const bad = all.filter((r) => !r.ok);
					setNotice(`导入完成：成功 ${okN} / ${all.length}` + (restoredN ? `（还原附属文件 ${restoredN} 个）` : "") + (bad.length ? `，失败 ${bad.length} 个` : ""));
					if (bad.length) {
						setError(bad.map((r) => `✗ ${r.source}：${r.error}`).join("\n"));
					} else {
						setError("");
					}
					await refresh();
					if (all.length === 0) setNotice("没有可导入的内容");
				});
			};

			// Identify directory groups whose frontmatter name already exists
			// in the library — mirror import would replace them, so they must
			// be confirmed before uploading.
			const onImportDir = async (e) => {
				// multi-pick folder input: every file carries webkitRelativePath.
				// A skill directory is one that contains a SKILL.md; every file
				// under that directory (scripts/, reference/, assets/, fonts, …)
				// is collected and uploaded together, so directory-imports get
				// the same full-fidelity restore as zip imports — not just the
				// SKILL.md doc. .zip files in the pick are imported as before.
				const files = e.target.files ? Array.from(e.target.files) : [];
				if (files.length === 0) return;
				const toRel = (f) => (f.webkitRelativePath || "").replace(/\\/g, "/");
				const zipFiles = files.filter((f) => /\.zip$/i.test(f.name));
				// First pass: locate every skill root (dirname of a SKILL.md).
				const roots = new Map(); // root rel path -> SKILL.md file
				for (const f of files) {
					if (/\.zip$/i.test(f.name)) continue;
					const rel = toRel(f);
					const parts = rel.split("/");
					if (parts[parts.length - 1] !== "SKILL.md") continue;
					const root = parts.slice(0, -1).join("/") || ".";
					if (!roots.has(root)) roots.set(root, []);
					roots.get(root).push(f);
				}
				// Second pass: group every sibling under its skill root.
				const groups = [];
				for (const [root] of roots) {
					const items = [];
					let mdText = "";
					for (const f of files) {
						if (/\.zip$/i.test(f.name)) continue;
						const rel = toRel(f);
						if (rel === root + "/SKILL.md" || rel.startsWith(root + "/")) {
							items.push({ path: rel.slice(root.length + 1), f });
							if (rel.endsWith("/SKILL.md")) {
								try { mdText = await f.text(); } catch { mdText = ""; }
							}
						}
					}
					groups.push({ root, items, mdText });
				}
				if (groups.length === 0 && zipFiles.length === 0) {
					setNotice("所选内容里没有含 SKILL.md 的技能目录或 .zip 文件（每个技能目录应含一个 SKILL.md）");
					e.target.value = "";
					return;
				}
				// front-end size pre-checks — surface the server's limits before
				// uploading, instead of failing after the transfer
				const MAX_ZIP = 50 * 1024 * 1024; // host: /import cap
				const MAX_DIR = 50 * 1024 * 1024; // per-skill-dir raw bytes (host: 100MB expanded)
				const overZip = zipFiles.filter((f) => f.size > MAX_ZIP);
				if (overZip.length) {
					setError(`跳过超限 zip（单个 >50MB）：${overZip.map((f) => f.name).join("、")}\n技能包请在 50MB 内（含解压后总大小 ≤100MB）`);
					e.target.value = "";
					return;
				}
				const overDir = groups.filter((g) => g.items.reduce((s, it) => s + it.f.size, 0) > MAX_DIR);
				if (overDir.length) {
					setError(`跳过超限技能目录（单个 >50MB）：${overDir.map((g) => g.root).join("、")}\n目录导入请控制在 50MB 内（含附属文件）`);
					e.target.value = "";
					return;
				}
				// Overwrite guard: mirror import REPLACES any same-named skill,
				// so confirm before uploading when the pick would overwrite one.
				const conflicts = groups
					.map((g) => ({ g, name: parseSkillName(g.mdText ?? "") }))
					.filter((c) => c.name && (skills ?? []).some((s) => s.name === c.name));
				if (conflicts.length > 0) {
					setImportPlan({ groups, zipFiles, conflicts });
					e.target.value = "";
					return;
				}
				await doImport(groups, zipFiles);
				e.target.value = "";
			};

			const confirmImport = async (skipExisting) => {
				if (!importPlan) return;
				const { groups, zipFiles, conflicts } = importPlan;
				setImportPlan(null);
				const conflictNames = new Set(conflicts.map((c) => c.name));
				const toImport = skipExisting ? groups.filter((g) => !conflictNames.has(parseSkillName(g.mdText ?? ""))) : groups;
				await doImport(toImport, zipFiles);
			};

			const startEdit = (skill) => {
				api("/get?name=" + encodeURIComponent(skill.name)).then((data) => {
					if (data.ok) setModalSkill(data.skill);
					else setNotice(data.error ?? "读取失败");
				});
			};

			const s = stats ?? { total: 0, globalEnabled: 0, globalDisabled: 0, preset: 0, workspaceCount: 0 };

			// pagination: slice a list and render a pager when it overflows
			const paginate = (list) => {
				if (!Array.isArray(list) || list.length <= PAGE_SIZE) return { items: list ?? [], total: list?.length ?? 0 };
				const total = list.length;
				const pages = Math.ceil(total / PAGE_SIZE);
				const cur = Math.min(page, pages - 1);
				const items = list.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE);
				return { items, total, pages, cur };
			};
			const renderPager = (pg) => {
				if (!pg || typeof pg.pages !== "number" || pg.pages <= 1) return null;
				return react.createElement("div", { className: "dskm_pager" },
					react.createElement("button", { className: "dskm_btn", disabled: pg.cur <= 0, onClick: () => setPage(pg.cur - 1) }, "‹ 上一页"),
					react.createElement("span", { className: "dskm_legend" }, `第 ${pg.cur + 1} / ${pg.pages} 页（共 ${pg.total} 个）`),
					react.createElement("button", { className: "dskm_btn", disabled: pg.cur >= pg.pages - 1, onClick: () => setPage(pg.cur + 1) }, "下一页 ›")
				);
			};

			// pool sorting shared by library list + search results: presets last,
			// then alphabetical by name.
			const sortPool = (list) => (list ?? []).slice().sort((a, b) => {
				const rank = (x) => (x.origin === "preset" || x.preset ? 1 : 0);
				const ra = rank(a), rb = rank(b);
				if (ra !== rb) return ra - rb;
				return a.name.localeCompare(b.name);
			});

			// One pool row (library or search hit). Rows mode reuses the shared
			// SkillRow (action buttons stay bright thanks to notoggle); g2/g4
			// render the compact SkillCard. Preset entries stay read-only.
			const poolRow = (item, actions) => {
				const isPreset = item.origin === "preset" || item.preset;
				const tag = isPreset ? (item.preset?.label ?? "preset") : null;
				if (layout === "rows") return react.createElement(SkillRow, {
					key: item.name,
					name: item.name,
					desc: item.description || "",
					checked: true, // in the pool; enablement is per-workspace
					disabled: isPreset, // preset rows stay read-only
					notoggle: true, // library rows can't be toggled
					lib: true, // muted text + grey dot; action buttons stay bright
					onToggle: null,
					tag,
					actions,
				});
				return react.createElement(SkillCard, {
					key: item.name,
					name: item.name,
					desc: item.description || "",
					notoggle: true,
					tag,
					actions,
				});
			};

			// layout → container class: rows → stacked rows, g2/g4 → fixed grids
			const poolCls = layout === "g4" ? "dskm_grid dskm_g4"
				: layout === "g2" ? "dskm_grid dskm_g2"
				: "dskm_layers";

			// search results: same look as the library list — pure pool, NO
			// enable/disable and NO snippet line here. Same per-item actions as
			// the full library (查看/编辑 + 删除); preset hits stay read-only.
			const renderSearchResults = () => {
				const sorted = sortPool(results);
				const pg = paginate(sorted);
				return react.createElement("div", { className: "dskm_ws" },
					react.createElement("div", { className: "dskm_legend" }, `找到 ${(results ?? []).length} 个匹配 "${query.trim()}"`),
					react.createElement("div", { className: poolCls }, pg.items.map((r) => poolRow(r, r.origin === "preset"
						? react.createElement("span", { className: "dskm_legend" }, "只读（预设捆绑）")
						: poolActions(r)
					))),
					renderPager(pg)
				);
			};

			// global tab list, paginated; preset entries are read-only cards
			const poolActions = (s) => {
				// 4-column cards are narrow: shorten the label so both actions fit
				// on one line instead of wrapping inside the buttons.
				const editLabel = layout === "g4" ? "查看" : "查看/编辑";
				return react.createElement(react.Fragment, null,
					react.createElement("button", { className: "dskm_btn", disabled: busy, title: "查看 / 编辑技能内容", onClick: (e) => { e.preventDefault(); startEdit(s); } }, editLabel),
					react.createElement("button", { className: "dskm_btn dskm_danger", disabled: busy, title: "永久删除该技能", onClick: (e) => { e.preventDefault(); if (window.confirm("确认永久删除技能 " + s.name + " ？")) run("delete", s.name); } }, "删除")
				);
			};
			const renderGlobalList = () => {
				const pg = paginate(skills);
				return react.createElement("div", { className: "dskm_ws" },
					react.createElement("div", { className: "dskm_legend" }, "技能库 = 可用技能池。是否在工作区生效请到「工作区技能」勾选。"),
					react.createElement("div", { className: poolCls }, pg.items.map((s) => poolRow(s, s.origin === "preset"
						? react.createElement("span", { className: "dskm_legend" }, "只读（预设捆绑）")
						: poolActions(s)
					))),
					renderPager(pg)
				);
			};

			return react.createElement("div", { className: "dskm" },
				// header: title + scan + import
				react.createElement("div", { className: "dskm_h" },
					react.createElement("div", { className: "dskm_name" }, "技能管理",
						pluginVer ? react.createElement("span", { className: "dskm_verbadge" }, "v" + pluginVer) : null
					),
					// right-aligned action cluster: scan sits next to import
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flex: "none" } },
						react.createElement("button", {
							className: "dskm_btn dskm_hbtn",
							disabled: busy,
							onClick: () => scanUnmanaged(),
						}, "扫描技能源"),
						react.createElement("label", { className: "dskm_btn dskm_hbtn" },
							"导入 skill",
							react.createElement("input", {
								type: "file",
								webkitdirectory: "",
								multiple: true,
								style: { display: "none" },
								disabled: busy,
								onChange: onImportDir,
							})
						)
					)
				),
				// overwrite confirm card: mirror import would REPLACE same-named
				// skills — ask before uploading. Skip-existing keeps the new
				// ones only; apply-all overwrites every conflict.
				importPlan
					? react.createElement("div", { className: "dskm_card dskm_importconfirm" },
						react.createElement("div", { className: "dskm_importconf_title" },
							"检测到 " + importPlan.conflicts.length + " 个技能在库中已存在，导入将覆盖它们（镜像语义，旧文件会被替换）"),
						react.createElement("div", { className: "dskm_importconf_list" },
							importPlan.conflicts.map((c) => react.createElement("span", { key: c.name, className: "dskm_badge dskm_stat_total" }, c.name))),
						react.createElement("div", { className: "dskm_ftbar" },
							react.createElement("div", { className: "dskm_importconf_btns" },
								react.createElement("button", { className: "dskm_btn dskm_danger", disabled: busy, onClick: () => confirmImport(true) }, "跳过已有的"),
								react.createElement("button", { className: "dskm_btn dskm_savebtn", disabled: busy, onClick: () => confirmImport(false) }, "覆盖全部"),
								react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: () => setImportPlan(null) }, "取消")
							)
						)
					)
					: null,
				// stats strip
				tab === "global"
					? react.createElement("div", { className: "dskm_stats" },
						react.createElement("span", { className: "dskm_stat dskm_stat_total" }, `技能库 ${s.total} 个`),
						react.createElement("span", { className: "dskm_stat dskm_stat_preset" }, `preset ${s.preset}`),
						react.createElement("span", { className: "dskm_stat dskm_stat_ws" }, `登记工作区 ${s.workspaceCount}`)
					)
					: react.createElement("div", { className: "dskm_stats" },
						react.createElement("span", { className: "dskm_stat dskm_stat_total" }, "工作区技能"),
						react.createElement("span", { className: "dskm_stat dskm_stat_ws" },
							wsCwd
								? `${baseNameOf(wsCwd)}：启用 ${(wsKnown.find((w) => sameCwdSeg(w.cwd, wsCwd))?.enabledCount ?? 0)} 个`
								: "（未选择工作区）"
						)
					),
				// tab bar
				react.createElement("div", { className: "dskm_tabs" },
					react.createElement("button", {
						className: "dskm_tab " + (tab === "global" ? "dskm_tab_on" : ""),
						onClick: () => setTab("global"),
					}, "技能库"),
					react.createElement("button", {
						className: "dskm_tab " + (tab === "workspace" ? "dskm_tab_on" : ""),
						onClick: () => setTab("workspace"),
					}, "工作区技能")
				),
				// workspace picker — only on the workspace tab; the library tab
				// shows a hint instead
				tab === "workspace"
					? react.createElement("div", { className: "dskm_wsbar dskm_wsrow" },
						react.createElement("span", { className: "dskm_legend" }, "工作区"),
						react.createElement("select", {
							className: "dskm_input dskm_select",
							value: wsCwd,
							disabled: busy,
							onChange: (e) => { const v = e.target.value; setWsCwd(v); setTab("workspace"); },
						},
							wsKnown.length === 0
								? react.createElement("option", { value: "" }, "（暂无工作区，打开任意会话后自动出现）")
								: wsKnown.map((w) => react.createElement("option", { key: w.cwd, value: w.cwd },
									(w.exists ? "" : "⚠ ") + w.cwd
								))
						)
					)
					: react.createElement("div", { className: "dskm_wsbar dskm_wsrow dskm_libhint" },
						react.createElement("span", { className: "dskm_legend" }, "技能需要到「工作区技能」tab 启用：库中的技能不会自动生效，勾选对应工作区后才会在该项目可见。")
					),
				// search box — library tab only. The workspace tab filters its own
				// view inside the panel (local name/desc), so "search" always
				// means "filter THIS context", never a foreign result set.
				tab === "global"
					? react.createElement("div", { className: "dskm_search" },
						react.createElement("input", {
							className: "dskm_input",
							type: "search",
							placeholder: "搜索技能（名称 / 描述 / 正文）…",
							value: query,
							onChange: (e) => setQuery(e.target.value),
						}),
						query ? react.createElement("button", { className: "dskm_btn", onClick: () => setQuery("") }, "清除") : null,
						react.createElement(ViewSwitch, { mode: layout, onChange: (m) => { setLayout(m); setPage(0); } })
					)
					: null,
				notice ? react.createElement("div", { className: "dskm_desc" }, notice) : null,
				error ? react.createElement("div", { className: "dskm_desc dskm_errblock" }, error) : null,
				tab === "global"
					? (query.trim()
						? (searching
							? react.createElement("div", { className: "dskm_empty" }, "搜索中…")
							: results && results.length === 0
								? react.createElement("div", { className: "dskm_empty" }, `没有找到匹配 "${query.trim()}" 的技能`)
								: renderSearchResults()
						)
						: react.createElement(react.Fragment, null,
							// ghost skills detected in engine/project roots — adopt them
							Array.isArray(unmanaged) && unmanaged.length > 0
								? react.createElement("div", { className: "dskm_wsbar dskm_wsrow" },
									react.createElement("span", { className: "dskm_legend" },
										`发现 ${unmanaged.length} 个游离技能（引擎/项目源，未纳入库）：${unmanaged.map((u) => u.name).join("、")}`),
									react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: () => adoptUnmanaged() }, "迁移入库")
								)
								: null,
							(loading
								? react.createElement("div", { className: "dskm_empty" }, "加载中…")
								: skills.length === 0
									? react.createElement("div", { className: "dskm_empty" }, "全局技能目录为空。点右上角导入 skill 技能包。")
									: renderGlobalList()))
					)
					: react.createElement(WorkspaceSkillsPanel, { cwd: wsCwd, initialSessionId, onWorkspaces: setWsKnown }),
				// skill detail modal (GFM preview + file browser) covers the panel
				modalSkill
					? react.createElement(SkillDetailModal, {
						skill: modalSkill,
						cwd: wsCwd,
						onClose: () => setModalSkill(null),
					})
					: null
			);
		}

		// browser-safe path basename
		function baseNameOf(p) {
			if (!p) return "";
			const parts = p.split(/[\\/]/).filter(Boolean);
			return parts[parts.length - 1] ?? "";
		}

		// Browser File → base64 data payload (for directory imports, so sibling
		// files survive the JSON hop alongside the SKILL.md doc).
		const fileToBase64 = (f) => new Promise((resolve) => {
			const r = new FileReader();
			r.onload = () => resolve(typeof r.result === "string" ? r.result.split(",")[1] ?? "" : "");
			r.onerror = () => resolve("");
			r.readAsDataURL(f);
		});

		// Path equality for the picker: normalize slashes (Windows registry keys
		// store \"\\\", the session store may hand over \"/\") before comparing.
		const sameCwdSeg = (a, b) => {
			const norm = (p) => (p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "");
			return norm(a) === norm(b);
		};

		// Shared skill row used by all three surfaces (settings global tab,
		// settings workspace tab, conversation tab). The WHOLE ROW toggles:
		// click anywhere → enable/disable. checked → highlighted (green tint +
		// bright text + solid dot), unchecked → greyed out (dimmed + hollow dot).
		// Buttons inside `actions` do not trigger the toggle. `notoggle` keeps
		// the row from responding to clicks/keyboard (library rows) WITHOUT the
		// dimmed disabled look, so action buttons stay fully bright and usable.
		function SkillRow({ name, desc, checked, disabled, notoggle, lib, onToggle, actions, tag, sub, warn }) {
			const handleClick = (e) => {
				if (disabled || notoggle) return;
				if (e.target.closest("button")) return; // action buttons keep their own behavior
				if (onToggle) onToggle(!checked);
			};
			return react.createElement("div", {
				className: "dskm_litem " + (checked ? "dskm_litem_on" : "dskm_litem_off") + (disabled ? " dskm_litem_dis" : "") + (lib ? " dskm_litem_lib" : ""),
				onClick: handleClick,
				role: notoggle ? undefined : "button",
				tabIndex: notoggle ? -1 : 0,
				onKeyDown: (e) => { if ((e.key === " " || e.key === "Enter") && !disabled && !notoggle) { e.preventDefault(); if (onToggle) onToggle(!checked); } },
			},
				react.createElement("span", { className: "dskm_dot " + (checked ? "dskm_dot_on" : "dskm_dot_off") }),
				react.createElement("span", { style: { minWidth: 0, flex: "1 1 auto", display: "flex", flexDirection: "column", overflow: "hidden" } },
					react.createElement("span", { className: "dskm_name", title: name }, name),
					react.createElement("span", { className: "dskm_desc", title: desc || "" }, desc || ""),
					sub || null
				),
				tag ? react.createElement("span", { className: "dskm_tag dskm_tag_preset" }, tag) : null,
				warn ? react.createElement("span", { className: "dskm_tag dskm_tag_warn", title: warn.title }, warn.text) : null,
				actions ? react.createElement("div", { className: "dskm_acts" }, actions) : null
			);
		}

		// Grid card for the library / search pools: compact — name (one line,
		// ellipsis) + description (clamped to 2 lines) + preset tag + actions.
		// Fixed min-height keeps the cards' aspect roughly uniform; the stash
		// of 236px+ columns reflows into 2 / 3 / 4+ columns by container width.
		// Workspace/session views reuse this card with checked/dot state and an
		// onToggle — the card body click toggles (buttons keep their behavior).
		function SkillCard({ name, desc, tag, warn, actions, checked, disabled, notoggle, onToggle }) {
			const handleClick = (e) => {
				if (disabled || notoggle) return;
				if (e.target.closest("button")) return;
				if (onToggle) onToggle(!checked);
			};
			// Only workspace/session cards actually carry an enable state. The
			// library & search pools are read-only (enablement is per-workspace),
			// so they render neutral and bright: an unconditional _off class
			// dimmed every library card to 72% and made the whole tab look grey.
			const toggleable = typeof onToggle === "function" && !notoggle;
			return react.createElement("div", {
				className: "dskm_card"
					+ (toggleable ? (checked ? " dskm_card_on" : " dskm_card_off") : " dskm_card_static")
					+ (disabled ? " dskm_card_dis" : ""),
				onClick: handleClick,
				role: toggleable ? "button" : undefined,
				tabIndex: toggleable ? 0 : -1,
				onKeyDown: (e) => { if ((e.key === " " || e.key === "Enter") && toggleable && !disabled) { e.preventDefault(); onToggle(!checked); } },
			},
				react.createElement("div", { className: "dskm_cardhead" },
					toggleable ? react.createElement("span", { className: "dskm_dot " + (checked ? "dskm_dot_on" : "dskm_dot_off") }) : null,
					react.createElement("span", { className: "dskm_cardname", title: name }, name)
				),
				react.createElement("span", { className: "dskm_carddesc" }, desc || ""),
				tag || warn
					? react.createElement("div", { className: "dskm_cardtag" },
						tag ? react.createElement("span", { className: "dskm_tag dskm_tag_preset" }, tag) : null,
						warn ? react.createElement("span", { className: "dskm_tag dskm_tag_warn", title: warn.title }, warn.text) : null
					)
					: null,
				actions ? react.createElement("div", { className: "dskm_cardacts" }, actions) : null
			);
		}

		// View-mode switch: single-column rows / two columns (2×5) / four
		// columns (4×5). PAGE_SIZE follows: rows=10, 2×5=10, 4×5=20.
		function ViewSwitch({ mode, onChange }) {
			const btn = (m, label, title) => react.createElement("button", {
				className: "dskm_viewbtn" + (mode === m ? " dskm_viewbtn_on" : ""),
				onClick: () => onChange(m),
				title,
			}, label);
			return react.createElement("div", { className: "dskm_viewbar" },
				btn("rows", "单栏", "单栏行式，每页 10 个（勾选场景更顺手）"),
				btn("g2", "双栏", "双栏网格（2×5），每页 10 个"),
				btn("g4", "4栏", "四栏网格（4×5），每页 20 个")
			);
		}

		// ---------- workspace (L1) + session (L2) panel ----------
		// Shows the skill view for a workspace. cwd is controlled by the parent
		// (settings page owns the picker row; conversation tab passes the session's
		// workspace). embed hides the picker entirely.
		function WorkspaceSkillsPanel(props) {
			const { cwd: cwdProp, initialSessionId, embed, onWorkspaces } = props;
			const [cwd, setCwd] = useState(cwdProp ?? "");
			const [sessionId] = useState(initialSessionId ?? "");
			const [view, setView] = useState(null);
			const [loading, setLoading] = useState(false);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [known, setKnown] = useState([]);
			const [page, setPage] = useState(0);
			const [q, setQ] = useState(""); // local filter (embed/session view)
			const [layout, setLayout] = useState("rows"); // 'rows' | 'g2' | 'g4'
			const PAGE_SIZE = layout === "g4" ? 20 : 10;

			useEffect(() => { setCwd(cwdProp ?? ""); }, [cwdProp]);

			const refresh = useCallback(async (targetCwd) => {
				const c = targetCwd ?? cwd;
				setLoading(true);
				setNotice("");
				try {
					const q = new URLSearchParams();
					if (c) q.set("cwd", c);
					if (sessionId) q.set("sessionId", sessionId);
					const data = await api("/view?" + q.toString());
					if (data.ok) {
						setView(data);
						// the view carries the auto-registered workspaces list
						if (Array.isArray(data.workspaces)) {
							setKnown(data.workspaces);
							if (onWorkspaces) onWorkspaces(data.workspaces);
						}
						// session-backed panels: host resolves cwd from the session
						if (!c && data.session?.cwd) setCwd(data.session.cwd);
					} else setNotice(data.error ?? "加载失败");
				} catch (e) { setNotice(String(e)); }
				finally { setLoading(false); }
			}, [cwd, sessionId, onWorkspaces]);

			useEffect(() => {
				// Refresh whenever the controlled cwd or session changes: mount,
				// picker selection, or session resolution.
				refresh(cwd);
				/* eslint-disable-line */
			}, [cwd, sessionId]);

			const toggleWorkspace = async (name, enable) => {
				if (!cwd) return;
				await withBusy(setBusy, setNotice, async () => {
					const data = await api("/workspace/toggle", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ cwd, name, enable }),
					});
					setNotice(data.ok ? (enable ? `已在工作区启用 ${name}` : `已停用 ${name}`) : data.error ?? "操作失败");
					await refresh();
				});
			};

			const toggleSession = async (name, targetChecked) => {
				if (!sessionId) return;
				const curEff = new Set((view?.skills ?? [])
					.filter((s) => s.sessionEnabled)
					.map((s) => s.name));
				let next;
				if (targetChecked) next = new Set([...curEff, name]);
				else next = new Set([...curEff].filter((n) => n !== name));
				// Session picks are ALWAYS explicit now: a session may freely choose
				// any library skill (workspace enablement only sets the follow
				// default). Returning to follow is the explicit 回到跟随 button —
				// auto-detecting "checked all == back to follow" would silently
				// drop extra picks whenever the subset happens to cover the whole
				// workspace set, so it must not fire implicitly.
				await withBusy(setBusy, setNotice, async () => {
					const data = await api("/session/set", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, cwd, enabled: [...next], explicit: true }),
					});
					setNotice(data.ok ? "会话技能已更新" : data.error ?? "操作失败");
					await refresh();
				});
			};

			const resetToFollow = async () => {
				if (!sessionId) return;
				// explicit=false with an empty subset → the session inherits the
				// workspace enabled set again (server-side intersection yields it)
				await withBusy(setBusy, setNotice, async () => {
					const data = await api("/session/set", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, cwd, enabled: [], explicit: false }),
					});
					setNotice(data.ok ? "已回到跟随工作区，本会话按工作区启用集生效" : data.error ?? "操作失败");
					await refresh();
				});
			};

			// Embed (conversation.view): the host wraps every view in its
			// transcript column, which the host's width handles resize via
			// --dsh-chat-content-width. Track that width so the panel body
			// aligns with the handles and dragging actually resizes this panel;
			// otherwise the handles float beside an unaffected full-width panel.
			const wsCls = "dskm_ws" + (embed ? " dskm_ws_col" : "");
			return react.createElement("div", { className: wsCls },
				notice ? react.createElement("div", { className: "dskm_desc" }, notice) : null,
				loading
					? react.createElement("div", { className: "dskm_empty" }, "加载中…")
					: !view
						? react.createElement("div", { className: "dskm_empty" }, "加载中…")
						: react.createElement("div", { className: "dskm_layers" },
							embed
								? react.createElement("div", { className: "dskm_wshead" },
									view.session?.cwd && view.session?.cwd !== ""
										? react.createElement("span", { className: "dskm_legend" },
											"当前工作区：", react.createElement("span", { className: "dskm_name" }, baseNameOf(view.session.cwd))
										)
										: react.createElement("span", { className: "dskm_legend" }, "当前会话技能"),
									react.createElement("span", {
										className: "dskm_mode " + (view.session?.explicit ? "dskm_mode_pin" : "dskm_mode_follow"),
										title: view.session?.explicit
											? "已固定自选：只按本会话勾选生效，不受工作区后续增删影响"
											: "跟随工作区：本会话与工作区启用集保持一致",
									}, view.session?.explicit ? "独立自选" : "跟随工作区")
								)
								: view.session?.cwd && view.session?.cwd !== ""
									? react.createElement("div", { className: "dskm_legend" },
										"当前工作区：", react.createElement("span", { className: "dskm_name" }, baseNameOf(view.session.cwd))
									)
									: null,
							embed && view.session?.explicit
								? react.createElement("div", { className: "dskm_followbar" },
									react.createElement("button", {
										className: "dskm_btn dskm_followbtn",
										disabled: busy,
										onClick: resetToFollow,
										title: "恢复后本会话技能 = 工作区启用集，工作区后续增删自动同步",
									}, "↩ 回到跟随"),
									react.createElement("span", { className: "dskm_legend" }, "自动启用工作区全部技能，无需逐个勾选")
								)
								: null,
							embed
								? react.createElement("div", { className: "dskm_legend" },
									view.session?.explicit
										? "取消勾选 = 本会话停用；勾选任意技能请直接操作。"
										: "跟随工作区：展示工作区启用集；勾选任意技能即切换为独立自选（可从库中自由选用，不限于工作区）。"
								)
								: react.createElement("div", { className: "dskm_legend" }, "勾选 = 在当前工作区启用"),
							// local name/desc filter for the current view (workspace & session
							// tabs; the library tab keeps the cross-layer search bar)
							react.createElement("div", { className: "dskm_search" },
								react.createElement("input", {
									className: "dskm_input",
									type: "search",
									placeholder: "搜索技能（名称 / 描述）…",
									value: q,
									onChange: (e) => { setQ(e.target.value); setPage(0); },
								}),
								q ? react.createElement("button", { className: "dskm_btn", onClick: () => { setQ(""); setPage(0); } }, "清除") : null,
								react.createElement(ViewSwitch, { mode: layout, onChange: (m) => { setLayout(m); setPage(0); } })
							),
														(() => {
								const kw = q.trim().toLowerCase();
								const all = (view.skills ?? [])
									.filter((s) => !kw
										|| (s.name ?? "").toLowerCase().includes(kw)
										|| (s.description ?? "").toLowerCase().includes(kw))
									.slice().sort((a, b) => {
										// enabled first, then name; presets always last
										const rank = (x) => x.origin === "preset" ? 2
											: (x.sessionEnabled || x.layer === "workspace") ? 0 : 1;
										const ra = rank(a), rb = rank(b);
										if (ra !== rb) return ra - rb;
										return a.name.localeCompare(b.name);
									});
								const pages = Math.ceil(all.length / PAGE_SIZE);
								const cur = Math.min(page, Math.max(pages - 1, 0));
								const items = all.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE);
								const itemCls = layout === "g4" ? "dskm_grid dskm_g4"
									: layout === "g2" ? "dskm_grid dskm_g2"
									: "dskm_layers";
								return react.createElement(react.Fragment, null,
									kw && all.length === 0
										? react.createElement("div", { className: "dskm_empty" }, `没有找到匹配 "${q}" 的技能`)
										: null,
									react.createElement("div", { className: itemCls }, items.map((s) => {
										const isPreset = s.origin === "preset";
										const enabled = isPreset || (embed
											? s.sessionEnabled
											: s.layer === "workspace");
										const warn = s.engineState === "missing"
											? { text: "未加载", title: "已启用，但 dsh 引擎实际未加载此技能（同名冲突、调用策略过滤或链接位置不符）" }
											: s.engineState === "shadowed"
												? { text: "被覆盖", title: `引擎加载了同名技能但来源是 ${s.engineSource ?? "其他层"}，本项目启用未生效` }
												: null;
										const shared = {
											key: s.name,
											name: s.name,
											desc: s.description || "",
											checked: enabled,
											disabled: isPreset || busy,
											onToggle: (v) => embed ? toggleSession(s.name, v) : toggleWorkspace(s.name, v),
											tag: isPreset ? (s.preset?.label ?? "preset") : null,
											warn,
										};
										return layout === "rows"
											? react.createElement(SkillRow, shared)
											: react.createElement(SkillCard, shared);
									})),
									pages > 1
										? react.createElement("div", { className: "dskm_pager" },
											react.createElement("button", { className: "dskm_btn", disabled: cur <= 0, onClick: () => setPage(cur - 1) }, "‹ 上一页"),
											react.createElement("span", { className: "dskm_legend" }, `第 ${cur + 1} / ${pages} 页（共 ${all.length} 个）`),
											react.createElement("button", { className: "dskm_btn", disabled: cur >= pages - 1, onClick: () => setPage(cur + 1) }, "下一页 ›")
										)
										: null
								);
							})()
						)
			);
		}
		// ---------- conversation view tab (like Trajectory) ----------
		// A full session-level page tab beside Chat/Trajectory: edit which
		// global skills this session uses. By default the session follows the
		// workspace (all workspace-enabled skills are on); toggling any skill
		// pins an explicit subset, and re-enabling everything restores follow.
		function SkillView(props) {
			const { useSession } = props;
			const sessionId = useSession((s) => s?.sessionId ?? "");
			if (!sessionId) return null;
			return react.createElement(PanelBoundary, null,
				react.createElement(WorkspaceSkillsPanel, { initialSessionId: sessionId, embed: true }));
		}
		const inject = ["slots", "sessions"];
		function apply(ctx) {
			// The settings panel is a root-scope surface, so it cannot receive
			// the conversation session kit; read the current session id from the
			// client sessions store directly and hand it down so the workspace
			// picker resolves "the workspace of the session I'm looking at".
			const CurrentSessionPanel = () => {
				const [sessionId, setSessionId] = useState("");
				useEffect(() => {
					const listen = () => {
						const cur = ctx.sessions?.list?.getSnapshot?.().current;
						setSessionId(cur ?? "");
					};
					listen();
					const dispose = ctx.sessions?.list?.subscribe?.(listen) ?? null;
					return () => { if (dispose) dispose(); };
				}, []);
				return react.createElement(PanelBoundary, null,
					react.createElement(SkillManagerPanel, { initialSessionId: sessionId }));
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skill-manager",
				order: 30,
				label: "技能管理",
			}, CurrentSessionPanel));
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "skill-manager",
				order: 20,
				label: "技能",
			}, SkillView));
		}

		exports.SkillManagerPanel = SkillManagerPanel;
		exports.WorkspaceSkillsPanel = WorkspaceSkillsPanel;
		exports.SkillView = SkillView;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
