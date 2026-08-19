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
	id: "dsh-skill-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { useEffect, useState, useCallback } = react;
		// dsh's own GFM renderer (seed word): full CommonMark + tables + TeX math
		// (KaTeX) + syntax-highlighted code fences, raw HTML disabled. Reusing it
		// beats hand-rolling a markdown pipeline.
		const MarkdownText = require("@deepseek-ai/dsh-client-ui-primitives").MarkdownText;

		const API = "/skill-manager/api";
		const css =
			".dskm{display:flex;flex-direction:column;gap:12px;padding:4px 0}" +
			".dskm_h{display:flex;align-items:center;justify-content:space-between;gap:8px}" +
			".dskm_hbtn{flex:none}" +
			".dskm_row{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-tip)}" +
			".dskm_ws{display:flex;flex-direction:column;gap:8px}" +
			".dskm_wsbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
			".dskm_wsrow{margin:2px 0 8px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-tip)}" +
			".dskm_libhint{opacity:.75}" +
			".dskm_wsrow .dskm_select{flex:1;min-width:0}" +
			".dskm_input{flex:1 1 220px;min-width:160px;font-size:12px;line-height:16px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary)}" +
			".dskm_layers{display:flex;flex-direction:column;gap:4px}" +
			".dskm_litem{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:16px;cursor:pointer;border:1px solid transparent;user-select:none;transition:opacity .12s,background .12s}" +
			".dskm_litem:hover{background:var(--dsw-alias-state-hover)}" +
			".dskm_litem:active{transform:translateY(.5px)}" +
			".dskm_litem_on{background:rgba(16,185,129,.09);border-color:rgba(16,185,129,.25)}" +
			".dskm_litem_on:hover{background:rgba(16,185,129,.14)}" +
			".dskm_litem_on .dskm_name{color:var(--dsw-alias-label-primary)}" +
			".dskm_litem_on .dskm_desc{color:var(--dsw-alias-label-secondary)}" +
			".dskm_litem_off{opacity:.45;filter:grayscale(.55)}" +
			".dskm_litem_off:hover{opacity:.85;filter:grayscale(.25)}" +
			".dskm_litem_dis{cursor:default;opacity:.6}" +
			".dskm_litem_lib .dskm_name{color:var(--dsw-alias-label-secondary)}" +
			".dskm_litem_lib .dskm_desc{color:var(--dsw-alias-label-tertiary)}" +
			".dskm_litem_lib .dskm_dot_on{background:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-label-tertiary);box-shadow:none}" +
			".dskm_litem_lib{cursor:default}" +
			".dskm_dot{flex:none;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--dsw-alias-label-tertiary);box-sizing:border-box;background:transparent}" +
			".dskm_dot_on{background:#10b981;border-color:#10b981;box-shadow:0 0 0 1px rgba(16,185,129,.25)}" +
			".dskm_litem input{accent-color:var(--dsw-alias-accent)}" +
			".dskm_tag{flex:none;font-size:10px;line-height:14px;padding:0 6px;border-radius:999px;font-weight:600}" +
			".dskm_tag_gl{color:#1d4ed8;background:rgba(59,130,246,.15)}" +
			".dskm_tag_ws{color:#0c7a3d;background:rgba(16,185,129,.14)}" +
			".dskm_tag_preset{color:#6d28d9;background:rgba(139,92,246,.16)}" +
			".dskm_tag_sess{color:#b45309;background:rgba(245,158,11,.16)}" +
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
			".dskm_desc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-all}" +
			".dskm_acts{display:flex;gap:6px;margin-left:auto;flex:none}" +
			".dskm_btn{font-size:12px;line-height:16px;padding:3px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}" +
			".dskm_btn:hover{background:var(--dsw-alias-state-hover)}" +
			".dskm_danger{color:#dc2626}" +
			".dskm_edit{display:flex;flex-direction:column;gap:8px;margin-top:8px}" +
			".dskm_edit textarea{width:100%;min-height:220px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);box-sizing:border-box}" +
			".dskm_empty{font-size:12px;color:var(--dsw-alias-label-caption);padding:16px 0;text-align:center}" +
			".dskm_errblock{white-space:pre-wrap;color:#dc2626;border:1px solid rgba(220,38,38,.3);background:rgba(220,38,38,.08);border-radius:8px;padding:8px 10px;margin:6px 0;font-size:12px;line-height:18px}" +
			".dskm_search{display:flex;gap:6px;margin-bottom:8px}" +
			".dskm_search .dskm_input{flex:1;min-width:0}" +
			".dskm_snip{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:4px;background:var(--dsw-alias-state-hover);border-radius:6px;padding:4px 8px;font-family:ui-monospace,Consolas,monospace;word-break:break-all}" +
			".dskm_mask{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}" +
			".dskm_modal{width:min(780px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:var(--dsw-shadow-lv3);overflow:hidden}" +
			".dskm_mhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}" +
			".dskm_mbody{flex:1;min-height:0;overflow-y:auto;padding:14px 18px}" +
			".dskm_mfoot{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}" +
			".dskm_btnp{background:var(--dsw-alias-accent);border-color:var(--dsw-alias-accent);color:#fff;font-weight:600}" +
			".dskm_mta{width:100%;min-height:46vh;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);box-sizing:border-box}" +
			".dskm_mdesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-bottom:10px;padding:6px 10px;background:var(--dsw-alias-state-hover);border-radius:8px}" +
			".dskm_md{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}" +
			".dskm_md h2{font-size:16px;font-weight:700;margin:14px 0 8px}" +
			".dskm_md h3{font-size:14px;font-weight:700;margin:12px 0 6px}" +
			".dskm_md h4{font-size:13px;font-weight:600;margin:10px 0 4px}" +
			".dskm_md p{margin:6px 0}" +
			".dskm_md ul,.dskm_md ol{margin:6px 0 6px 20px}" +
			".dskm_md li{margin:2px 0}" +
			".dskm_md pre{margin:8px 0;padding:10px 12px;background:var(--dsw-specific-input);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow-x:auto;font-size:12px;line-height:17px}" +
			".dskm_md code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--dsw-alias-state-hover);border-radius:4px;padding:1px 4px}" +
			".dskm_md pre code{background:none;padding:0}" +
			".dskm_md blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--dsw-alias-accent);color:var(--dsw-alias-label-secondary)}" +
			".dskm_md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0}" +
			".dskm_md a{color:var(--dsw-alias-accent);text-decoration:underline}" +
			".dskm_md table{border-collapse:collapse;margin:8px 0;font-size:12px;line-height:17px}" +
			".dskm_md th,.dskm_md td{border:1px solid var(--dsw-alias-border-l2);padding:4px 10px;text-align:left}" +
			".dskm_md th{background:var(--dsw-alias-state-hover);font-weight:600}" +
			".dskm_pager{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 0 2px}";
		const tagId = "dsh-skill-manager/styles.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-skill-manager";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		async function api(path, options) {
			const res = await fetch(API + path, options);
			return res.json();
		}

		const PRESET_LABEL_TEXT = "preset";

		// ---------- skill detail modal (GFM preview + raw edit) ----------
		function SkillDetailModal({ skill, onClose, onSave, saving }) {
			const [mode, setMode] = useState("preview"); // 'preview' | 'edit'
			const [draft, setDraft] = useState(skill?.body ?? "");
			const [fmText, setFmText] = useState(() => {
				const fm = skill?.frontmatter ?? {};
				return Object.keys(fm).length ? "---\n" + JSON.stringify(fm, null, 2).slice(1, -1) + "\n---\n" : "";
			});
			const [err, setErr] = useState("");
			if (!skill) return null;
			const fullDoc = fmText + draft;
			const save = () => {
				const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(fullDoc);
				let frontmatter = {};
				let body = fullDoc;
				if (m) {
					try { frontmatter = JSON.parse("{" + m[1] + "}"); } catch { frontmatter = {}; }
					body = m[2] ?? "";
				}
				if (!frontmatter.name || !String(frontmatter.name).trim()) { setErr("frontmatter 必须包含 name"); return; }
				if (!frontmatter.description || !String(frontmatter.description).trim()) { setErr("frontmatter 必须包含 description"); return; }
				if (!body.trim()) { setErr("正文不能为空"); return; }
				setErr("");
				onSave(frontmatter, body);
			};
			return react.createElement("div", { className: "dskm_mask",
					onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				react.createElement("div", { className: "dskm_modal" },
					react.createElement("div", { className: "dskm_mhead" },
						react.createElement("span", { className: "dskm_name" }, skill.name || "技能详情"),
						react.createElement("button", { className: "dskm_btn", onClick: onClose }, "✕ 关闭")
					),
					react.createElement("div", { className: "dskm_tabs" },
						react.createElement("button", { className: "dskm_tab " + (mode === "preview" ? "dskm_tab_on" : ""), onClick: () => setMode("preview") }, "预览"),
						react.createElement("button", { className: "dskm_tab " + (mode === "edit" ? "dskm_tab_on" : ""), onClick: () => setMode("edit") }, "编辑")
					),
					mode === "preview"
						? react.createElement("div", { className: "dskm_mbody dskm_md" },
							(skill.description ? react.createElement("p", { key: "d", className: "dskm_mdesc" }, skill.description) : null),
							react.createElement(MarkdownText, { text: draft })
						)
						: react.createElement("div", { className: "dskm_mbody" },
							react.createElement("textarea", {
								className: "dskm_mta",
								value: fullDoc,
								spellCheck: false,
								onChange: (e) => {
									const v = e.target.value;
									const mm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(v);
									if (mm) {
										setFmText("---\n" + mm[1] + "\n---\n");
										setDraft(mm[2] ?? "");
									} else {
										setFmText("");
										setDraft(v);
									}
								},
							})
						),
					err ? react.createElement("div", { className: "dskm_errblock" }, err) : null,
					react.createElement("div", { className: "dskm_mfoot" },
						react.createElement("button", { className: "dskm_btn", onClick: onClose, disabled: saving }, "取消"),
						react.createElement("button", { className: "dskm_btn dskm_btnp", onClick: save, disabled: saving }, saving ? "保存中…" : "保存")
					)
				)
			);
		}

		function SkillManagerPanel(props) {
			const { initialSessionId = "" } = props;
			const [skills, setSkills] = useState([]);
			const [stats, setStats] = useState(null);
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState("");
			const [modalSkill, setModalSkill] = useState(null); // skill being viewed/edited in modal
			const [saveErr, setSaveErr] = useState("");
			const [saving, setSaving] = useState(false);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [tab, setTab] = useState("global"); // 'global' | 'workspace'
			const [wsCwd, setWsCwd] = useState(""); // workspace picker selection
			const [wsKnown, setWsKnown] = useState([]); // known workspaces for the picker
			const [query, setQuery] = useState("");
			const [results, setResults] = useState(null); // search results or null=idle
			const [searching, setSearching] = useState(false);
			const [page, setPage] = useState(0); // list pagination page index
			const PAGE_SIZE = 10;

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
				setBusy(true);
				setNotice("");
				try {
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
				} catch (e) {
					setNotice(String(e));
				} finally {
					setBusy(false);
				}
			}, [refresh, modalSkill]);

			const onImportDir = async (e) => {
				// multi-pick folder input: every file carries webkitRelativePath.
				// Collect any SKILL.md (each = one skill doc) AND any .zip (packed
				// skill bundle), then import them all, reporting per-item results.
				const files = e.target.files ? Array.from(e.target.files) : [];
				if (files.length === 0) return;
				const mdFiles = files.filter((f) => f.name === "SKILL.md" && f.webkitRelativePath);
				const zipFiles = files.filter((f) => /\.zip$/i.test(f.name));
				if (mdFiles.length === 0 && zipFiles.length === 0) {
					setNotice("所选内容里没有 SKILL.md 或 .zip 文件（每个技能目录应含一个 SKILL.md）");
					e.target.value = "";
					return;
				}
				setBusy(true);
				try {
					const batch = [];
					const zips = [];
					for (const f of mdFiles) {
						batch.push({ source: f.webkitRelativePath, content: await f.text() });
					}
					for (const f of zipFiles) {
						zips.push({ source: f.name, buf: await f.arrayBuffer() });
					}
					// folder docs first
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
					const bad = all.filter((r) => !r.ok);
					setNotice(`导入完成：成功 ${okN} / ${all.length}` + (bad.length ? `，失败 ${bad.length} 个` : ""));
					if (bad.length) {
						setError(bad.map((r) => `✗ ${r.source}：${r.error}`).join("\n"));
					} else {
						setError("");
					}
					await refresh();
					if (all.length === 0) setNotice("没有可导入的内容");
				} catch (err) {
					setNotice(String(err));
				} finally {
					setBusy(false);
					e.target.value = "";
				}
			};

			const startEdit = (skill) => {
				api("/get?name=" + encodeURIComponent(skill.name)).then((data) => {
					if (data.ok) setModalSkill(data.skill);
					else setNotice(data.error ?? "读取失败");
				});
			};

			const saveEdit = async (frontmatter, body) => {
				if (!modalSkill) return;
				setSaving(true);
				setSaveErr("");
				try {
					const data = await api("/edit", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: modalSkill.name, frontmatter, body }),
					});
					if (data.ok) {
						setModalSkill(null);
						setNotice("已保存");
						await refresh();
					} else {
						setSaveErr(data.error ?? "保存失败");
					}
				} catch (err) {
					setSaveErr(String(err));
				} finally {
					setSaving(false);
				}
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

			// enable/disable a search result directly in the current workspace
			// (same semantics as the workspace panel row toggle)
			const toggleSearchSkill = async (r, enable) => {
				if (!wsCwd) {
					setNotice("未选择工作区：请先到「工作区技能」tab 选择目标工作区");
					return;
				}
				setBusy(true);
				setNotice("");
				try {
					const data = await api("/workspace/toggle", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ cwd: wsCwd, name: r.name, enable }),
					});
					setNotice(data.ok ? (enable ? `已在工作区启用 ${r.name}` : `已停用 ${r.name}`) : data.error ?? "操作失败");
					const q = query.trim();
					if (q && data.ok) doSearch(q, wsCwd); // refresh wsEnabled marks
				} catch (e) {
					setNotice(String(e));
				} finally {
					setBusy(false);
				}
			};

			// search results: same SkillRow layout as the lists, plus snippet
			// underneath; checked = enabled in the CURRENT workspace, click
			// toggles enablement (preset rows stay read-only)
			const renderSearchResults = () => {
				const sorted = (results ?? []).slice().sort((a, b) => {
					// preset always last; otherwise alphabetical
					const rank = (x) => x.origin === "preset" || x.preset ? 1 : 0;
					const ra = rank(a), rb = rank(b);
					if (ra !== rb) return ra - rb;
					return a.name.localeCompare(b.name);
				});
				const pg = paginate(sorted);
				const wsName = wsCwd ? baseNameOf(wsCwd) : "";
				return react.createElement("div", { className: "dskm_layers" },
					react.createElement("div", { className: "dskm_legend" },
						`找到 ${(results ?? []).length} 个匹配 "${query.trim()}"` +
						(wsName ? ` · 点击行 = 在当前工作区（${wsName}）启用/停用` : " · 未定位工作区，无法启用/停用")
					),
					pg.items.map((r) => {
						const isPreset = r.origin === "preset" || r.preset;
						return react.createElement(SkillRow, {
							key: r.name,
							name: r.name,
							desc: r.description || "",
							checked: !!r.wsEnabled,
							disabled: isPreset || busy,
							notoggle: isPreset, // preset rows stay read-only
							onToggle: (v) => toggleSearchSkill(r, v),
							tag: isPreset ? (r.preset?.label ?? "preset") : null,
							sub: react.createElement(react.Fragment, null,
								r.snippet ? react.createElement("div", { className: "dskm_snip" }, r.snippet) : null
							)
						});
					}),
					renderPager(pg)
				);
			};

			// global tab list, paginated; preset entries are read-only rows
			const renderGlobalList = () => {
				const pg = paginate(skills);
				return react.createElement("div", { className: "dskm_layers" },
					react.createElement("div", { className: "dskm_legend" }, "技能库 = 可用技能池。是否在工作区生效请到「工作区技能」勾选。"),
					pg.items.map((s) => {
						const isPreset = s.origin === "preset";
						return react.createElement(SkillRow, {
							key: s.name,
							name: s.name,
							desc: s.description || "",
							checked: true, // in the library; enablement is per-workspace
							disabled: isPreset, // preset rows stay visually dimmed + unclickable
							notoggle: true, // library rows can't be toggled
							lib: true, // dim the non-button area; action buttons stay bright
							onToggle: null,
							tag: isPreset ? (s.preset?.label ?? "preset") : null,
							actions: isPreset
								? react.createElement("span", { className: "dskm_legend" }, "只读（预设捆绑）")
								: react.createElement("div", { className: "dskm_acts" },
									react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: (e) => { e.preventDefault(); startEdit(s); } }, "查看/编辑"),
									react.createElement("button", { className: "dskm_btn dskm_danger", disabled: busy, onClick: (e) => { e.preventDefault(); if (window.confirm("确认永久删除技能 " + s.name + " ？")) run("delete", s.name); } }, "删除")
								)
						});
					}),
					renderPager(pg)
				);
			};

			return react.createElement("div", { className: "dskm" },
				// header: title + import
				react.createElement("div", { className: "dskm_h" },
					react.createElement("div", { className: "dskm_name" }, "技能管理"),
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
				),
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
								? `${baseNameOf(wsCwd)}：启用 ${(wsKnown.find((w) => w.cwd === wsCwd)?.enabledCount ?? 0)} 个`
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
									(w.exists ? "" : "⚠ ") + w.cwd + (w.enabledCount ? `（启用 ${w.enabledCount}）` : "")
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
						query ? react.createElement("button", { className: "dskm_btn", onClick: () => setQuery("") }, "清除") : null
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
						: (loading
							? react.createElement("div", { className: "dskm_empty" }, "加载中…")
							: skills.length === 0
								? react.createElement("div", { className: "dskm_empty" }, "全局技能目录为空。点右上角导入 skill 技能包。")
								: renderGlobalList()))
					: react.createElement(WorkspaceSkillsPanel, { cwd: wsCwd, initialSessionId, onWorkspaces: setWsKnown }),
				// skill detail modal (GFM preview + edit) covers the panel
				modalSkill
					? react.createElement(SkillDetailModal, {
						skill: modalSkill,
						saving,
						onClose: () => setModalSkill(null),
						onSave: saveEdit,
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

		// Shared skill row used by all three surfaces (settings global tab,
		// settings workspace tab, conversation tab). The WHOLE ROW toggles:
		// click anywhere → enable/disable. checked → highlighted (green tint +
		// bright text + solid dot), unchecked → greyed out (dimmed + hollow dot).
		// Buttons inside `actions` do not trigger the toggle. `notoggle` keeps
		// the row from responding to clicks/keyboard (library rows) WITHOUT the
		// dimmed disabled look, so action buttons stay fully bright and usable.
		function SkillRow({ name, desc, checked, disabled, notoggle, lib, onToggle, actions, tag, sub }) {
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
				react.createElement("span", { style: { minWidth: 0, flex: "1 1 auto", display: "flex", flexDirection: "column" } },
					react.createElement("span", { className: "dskm_name" }, name),
					react.createElement("span", { className: "dskm_desc" }, desc || ""),
					sub || null
				),
				tag ? react.createElement("span", { className: "dskm_tag dskm_tag_preset" }, tag) : null,
				actions || null
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
			const PAGE_SIZE = 10;

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
				setBusy(true);
				setNotice("");
				try {
					const data = await api("/workspace/toggle", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ cwd, name, enable }),
					});
					setNotice(data.ok ? (enable ? `已在工作区启用 ${name}` : `已停用 ${name}`) : data.error ?? "操作失败");
					await refresh();
				} catch (e) { setNotice(String(e)); } finally { setBusy(false); }
			};

			const toggleSession = async (name, targetChecked) => {
				if (!sessionId) return;
				const wsSet = new Set(view?.workspaceEnabled ?? []);
				const curEff = new Set((view?.skills ?? [])
					.filter((s) => s.sessionEnabled)
					.map((s) => s.name));
				let next;
				if (targetChecked) next = new Set([...curEff, name]);
				else next = new Set([...curEff].filter((n) => n !== name));
				// explicit subset == the whole workspace set → follow workspace again
				const everyWs = [...wsSet].every((n) => next.has(n)) && next.size === wsSet.size;
				const isExplicit = !everyWs || wsSet.size === 0;
				const enabledList = isExplicit ? [...next] : [];
				setBusy(true);
				setNotice("");
				try {
					const data = await api("/session/set", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, cwd, enabled: enabledList, explicit: isExplicit }),
					});
					setNotice(data.ok ? "会话技能已更新" : data.error ?? "操作失败");
					await refresh();
				} catch (e) { setNotice(String(e)); } finally { setBusy(false); }
			};

			return react.createElement("div", { className: "dskm_ws" },
				notice ? react.createElement("div", { className: "dskm_desc" }, notice) : null,
				loading
					? react.createElement("div", { className: "dskm_empty" }, "加载中…")
					: !view
						? react.createElement("div", { className: "dskm_empty" }, "加载中…")
						: react.createElement("div", { className: "dskm_layers" },
							view.session?.cwd && view.session?.cwd !== ""
								? react.createElement("div", { className: "dskm_legend" },
									"当前工作区：", react.createElement("span", { className: "dskm_name" }, baseNameOf(view.session.cwd))
								)
								: null,
							embed
								? react.createElement("div", { className: "dskm_legend" },
									view.session?.explicit
										? "已固定自选：取消勾选=停用。重新勾选全部即回到跟随工作区。"
										: "跟随工作区：勾选=启用，未勾选=停用。"
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
								q ? react.createElement("button", { className: "dskm_btn", onClick: () => { setQ(""); setPage(0); } }, "清除") : null
							),
														(() => {
								const kw = q.trim().toLowerCase();
								const all = (view.skills ?? [])
									.filter((s) => !kw
										|| (s.name ?? "").toLowerCase().includes(kw)
										|| (s.description ?? "").toLowerCase().includes(kw))
									.slice().sort((a, b) => {
										// preset always last; otherwise enabled first, then name
										const rank = (x) => x.origin === "preset" ? 2
											: (x.sessionEnabled || x.layer === "workspace") ? 0 : 1;
										const ra = rank(a), rb = rank(b);
										if (ra !== rb) return ra - rb;
										return a.name.localeCompare(b.name);
									});
								const pages = Math.ceil(all.length / PAGE_SIZE);
								const cur = Math.min(page, Math.max(pages - 1, 0));
								const items = all.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE);
								return react.createElement(react.Fragment, null,
									kw && all.length === 0
										? react.createElement("div", { className: "dskm_empty" }, `没有找到匹配 "${q}" 的技能`)
										: null,
									items.map((s) => {
										const isPreset = s.origin === "preset";
										const enabled = isPreset || (embed
											? s.sessionEnabled
											: s.layer === "workspace");
										return react.createElement(SkillRow, {
											key: s.name,
											name: s.name,
											desc: s.description || "",
											checked: enabled,
											disabled: isPreset || busy,
											onToggle: (v) => embed ? toggleSession(s.name, v) : toggleWorkspace(s.name, v),
											tag: isPreset ? (s.preset?.label ?? "preset") : null,
										});
									}),
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
			return react.createElement(WorkspaceSkillsPanel, { initialSessionId: sessionId, embed: true });
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
				return react.createElement(SkillManagerPanel, { initialSessionId: sessionId });
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
