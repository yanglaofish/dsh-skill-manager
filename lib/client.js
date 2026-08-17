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

		const API = "/skill-manager/api";
		const css =
			".dskm{display:flex;flex-direction:column;gap:12px;padding:4px 0}" +
			".dskm_h{display:flex;align-items:center;justify-content:space-between;gap:8px}" +
			".dskm_hbtn{flex:none}" +
			".dskm_row{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-tip)}" +
			".dskm_ws{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-tip)}" +
			".dskm_wsbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
			".dskm_input{flex:1 1 220px;min-width:160px;font-size:12px;line-height:16px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary)}" +
			".dskm_layers{display:flex;flex-direction:column;gap:4px}" +
			".dskm_litem{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;font-size:12px;line-height:16px;cursor:pointer}" +
			".dskm_litem:hover{background:var(--dsw-alias-state-hover)}" +
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
			".dskm_empty{font-size:12px;color:var(--dsw-alias-label-caption);padding:16px 0;text-align:center}";
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

		function SkillManagerPanel() {
			const [skills, setSkills] = useState([]);
			const [stats, setStats] = useState(null);
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState("");
			const [editing, setEditing] = useState(null); // skill object being edited
			const [draft, setDraft] = useState("");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [tab, setTab] = useState("global"); // 'global' | 'workspace'
			const [wsStats, setWsStats] = useState(null); // { cwd, enabledCount } from workspace panel

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
						setEditing(null);
						await refresh();
					}
				} catch (e) {
					setNotice(String(e));
				} finally {
					setBusy(false);
				}
			}, [refresh]);

			const onImportFile = async (e) => {
				const file = e.target.files?.[0];
				if (!file) return;
				setBusy(true);
				setNotice("");
				try {
					const data = await api("/import", { method: "POST", body: file });
					setNotice(data.ok ? `已导入 ${data.name}` : data.error ?? "导入失败");
					await refresh();
				} catch (err) {
					setNotice(String(err));
				} finally {
					setBusy(false);
					e.target.value = "";
				}
			};

			const startEdit = (skill) => {
				api("/get?name=" + encodeURIComponent(skill.name)).then((data) => {
					if (data.ok) {
						const fm = data.skill.frontmatter ?? {};
						const fmText = Object.keys(fm).length ? "---\n" + JSON.stringify(fm, null, 2).slice(1, -1) + "\n---\n" : "";
						setEditing(data.skill);
						setDraft(fmText + data.skill.body);
					} else {
						setNotice(data.error ?? "读取失败");
					}
				});
			};

			const saveEdit = async () => {
				if (!editing) return;
				setBusy(true);
				setNotice("");
				try {
					// naive frontmatter split: reuse the same --- rules as host
					const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(draft);
					let frontmatter = {};
					let body = draft;
					if (m) {
						try { frontmatter = JSON.parse("{" + m[1] + "}"); } catch { frontmatter = {}; }
						body = m[2] ?? "";
					}
					const data = await api("/edit", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: editing.name, frontmatter, body }),
					});
					setNotice(data.ok ? "已保存" : data.error ?? "保存失败");
					if (data.ok) {
						setEditing(null);
						await refresh();
					}
				} catch (err) {
					setNotice(String(err));
				} finally {
					setBusy(false);
				}
			};

			const s = stats ?? { total: 0, globalEnabled: 0, globalDisabled: 0, preset: 0, workspaceCount: 0 };

			return react.createElement("div", { className: "dskm" },
				// header: title + import
				react.createElement("div", { className: "dskm_h" },
					react.createElement("div", { className: "dskm_name" }, "技能管理"),
					react.createElement("label", { className: "dskm_btn dskm_hbtn" },
						"导入 .zip",
						react.createElement("input", {
							type: "file",
							accept: ".zip,application/zip",
							style: { display: "none" },
							disabled: busy,
							onChange: onImportFile,
						})
					)
				),
				// stats strip
				tab === "global"
					? react.createElement("div", { className: "dskm_stats" },
						react.createElement("span", { className: "dskm_stat dskm_stat_total" }, `${s.total} 个技能`),
						react.createElement("span", { className: "dskm_stat dskm_on" }, `全局启用 ${s.globalEnabled}`),
						react.createElement("span", { className: "dskm_stat dskm_off" }, `全局禁用 ${s.globalDisabled}`),
						react.createElement("span", { className: "dskm_stat dskm_stat_preset" }, `preset ${s.preset}`),
						react.createElement("span", { className: "dskm_stat dskm_stat_ws" }, `登记工作区 ${s.workspaceCount}`)
					)
					: react.createElement("div", { className: "dskm_stats" },
						react.createElement("span", { className: "dskm_stat dskm_stat_total" }, "工作区技能"),
						react.createElement("span", { className: "dskm_stat dskm_stat_ws" },
							wsStats && wsStats.cwd
								? `${baseNameOf(wsStats.cwd)}：启用 ${wsStats.enabledCount} 个`
								: "（未选择工作区）"
						)
					),
				// tab bar
				react.createElement("div", { className: "dskm_tabs" },
					react.createElement("button", {
						className: "dskm_tab " + (tab === "global" ? "dskm_tab_on" : ""),
						onClick: () => setTab("global"),
					}, "全局技能"),
					react.createElement("button", {
						className: "dskm_tab " + (tab === "workspace" ? "dskm_tab_on" : ""),
						onClick: () => setTab("workspace"),
					}, "工作区技能")
				),
				notice ? react.createElement("div", { className: "dskm_desc" }, notice) : null,
				error ? react.createElement("div", { className: "dskm_desc" }, error) : null,
				tab === "global"
					? (loading
						? react.createElement("div", { className: "dskm_empty" }, "加载中…")
						: skills.length === 0
							? react.createElement("div", { className: "dskm_empty" }, "全局技能目录为空。点右上角导入 .zip 技能包。")
							: react.createElement(react.Fragment, null,
								skills.map((s) => react.createElement("div", { key: s.name, className: "dskm_row" },
									react.createElement("span", { className: "dskm_badge " + (s.enabled ? "dskm_on" : "dskm_off") }, s.enabled ? "启用" : "禁用"),
									react.createElement("div", { style: { minWidth: 0, flex: "1 1 auto" } },
										react.createElement("div", { className: "dskm_name" }, s.name),
										react.createElement("div", { className: "dskm_desc" }, s.description || "（无描述）")
									),
									react.createElement("div", { className: "dskm_acts" },
										react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: () => startEdit(s) }, "查看/编辑"),
										s.enabled
											? react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: () => run("disable", s.name) }, "禁用")
											: react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: () => run("enable", s.name) }, "启用"),
										react.createElement("button", { className: "dskm_btn dskm_danger", disabled: busy, onClick: () => { if (window.confirm("确认永久删除技能 " + s.name + " ？")) run("delete", s.name); } }, "删除")
									),
									editing && editing.name === s.name
										? react.createElement("div", { className: "dskm_edit" },
											react.createElement("textarea", {
												value: draft,
												onChange: (e) => setDraft(e.target.value),
												spellCheck: false,
											}),
											react.createElement("div", { className: "dskm_acts" },
												react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: saveEdit }, "保存"),
												react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: () => setEditing(null) }, "取消")
											)
										)
										: null
								))
							))
					: react.createElement(WorkspaceSkillsPanel, { hideCwdInput: true, onStats: setWsStats })
			);
		}

		// browser-safe path basename
		function baseNameOf(p) {
			if (!p) return "";
			const parts = p.split(/[\\/]/).filter(Boolean);
			return parts[parts.length - 1] ?? "";
		}

		// ---------- workspace (L1) + session (L2) panel ----------
		// Shows the layered skill view for a workspace (global/preset read-only,
		// workspace hard-link switches, session subset). cwd is user-editable so
		// it works from settings without a session; session-level controls only
		// appear when sessionId is provided (conversation dock panel).
		function WorkspaceSkillsPanel(props) {
			const { initialCwd, initialSessionId, embed, hideCwdInput, onStats } = props;
			const [cwd, setCwd] = useState(initialCwd ?? "");
			const [sessionId] = useState(initialSessionId ?? "");
			const [view, setView] = useState(null);
			const [loading, setLoading] = useState(false);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [known, setKnown] = useState([]);

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
						// session-backed panels: host resolves cwd from the session
						if (!c && data.session?.cwd) setCwd(data.session.cwd);
						if (onStats) onStats({ cwd: data.session?.cwd ?? c, enabledCount: data.workspaceEnabled?.length ?? 0 });
					} else setNotice(data.error ?? "加载失败");
				} catch (e) { setNotice(String(e)); }
				finally { setLoading(false); }
			}, [cwd, sessionId, onStats]);

			useEffect(() => {
				// Always refresh on mount: with a sessionId the host resolves cwd
				// from the session; with neither, it falls back to the most recent
				// live session's cwd so the settings panel needs no manual input.
				refresh();
				/* eslint-disable-line */
			}, [sessionId]);

			const loadKnown = useCallback(async () => {
				try {
					const data = await api("/workspaces");
					if (data.ok) {
						setKnown(data.workspaces);
						// picker mode: default-select the first registered workspace
						if (hideCwdInput && !cwd && data.workspaces.length > 0) {
							const first = data.workspaces.find((w) => w.exists) ?? data.workspaces[0];
							if (first) { setCwd(first.cwd); refresh(first.cwd); }
						}
					}
				} catch { /* non-fatal */ }
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [hideCwdInput, cwd]);

			useEffect(() => { loadKnown(); }, [loadKnown]);

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
					await loadKnown();
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
				// explicit subset == full workspace set → follow workspace again
				const everyWs = [...wsSet].every((n) => next.has(n)) && next.size === wsSet.size;
				const explicit = !everyWs || wsSet.size === 0 ? [...next] : [];
				setBusy(true);
				setNotice("");
				try {
					const data = await api("/session/set", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, cwd, enabled: explicit, explicit: everyWs }),
					});
					setNotice(data.ok ? "会话技能已更新" : data.error ?? "操作失败");
					await refresh();
				} catch (e) { setNotice(String(e)); } finally { setBusy(false); }
			};

			const register = async () => {
				if (!cwd) return;
				await api("/workspace/register", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ cwd }),
				});
				await loadKnown();
			};

			const badges = (s) => {
				const tags = [];
				if (s.origin === "preset") tags.push({ t: "preset", l: "preset" });
				else if (s.layer === "workspace") tags.push({ t: "ws", l: "workspace" });
				else if (s.layer === "global" && s.enabled) tags.push({ t: "gl", l: "global" });
				else if (s.layer === "global") tags.push({ t: "gl", l: "global" });
				return tags.map((tg) => react.createElement("span", {
					key: tg.t,
					className: "dskm_tag dskm_tag_" + (tg.t === "ws" ? "ws" : tg.t === "preset" ? "preset" : "gl")
				}, tg.l));
			};

			return react.createElement("div", { className: "dskm_ws" },
				react.createElement("div", { className: "dskm_h" },
					react.createElement("span", { className: "dskm_name" },
						embed ? "会话技能" : (sessionId ? "工作区 / 会话技能" : "工作区技能")
					),
					react.createElement("button", {
						className: "dskm_btn dskm_hbtn",
						disabled: loading || busy,
						onClick: () => refresh(),
					}, "刷新")
				),
				!embed && hideCwdInput
					? react.createElement("div", { className: "dskm_wsbar" },
						react.createElement("select", {
							className: "dskm_input dskm_select",
							value: cwd,
							disabled: busy || loading,
							onChange: (e) => { const v = e.target.value; setCwd(v); refresh(v); },
						},
							known.length === 0
								? react.createElement("option", { value: "" }, "（暂无已登记工作区，请先在工作区打开会话）")
								: known.map((w) => react.createElement("option", { key: w.cwd, value: w.cwd },
									(w.exists ? "" : "⚠ ") + w.cwd + (w.enabledCount ? `（启用 ${w.enabledCount}）` : "")
								))
						),
						react.createElement("button", { className: "dskm_btn", disabled: busy || !cwd, onClick: () => refresh() }, "刷新"),
						react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: register }, "登记当前")
					)
					: !embed && !hideCwdInput
					? react.createElement("div", { className: "dskm_wsbar" },
						react.createElement("input", {
							className: "dskm_input",
							value: cwd,
							placeholder: "工作区绝对路径（如 D:\\projects\\demo）",
							onChange: (e) => setCwd(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") refresh(); },
						}),
						react.createElement("button", { className: "dskm_btn", disabled: busy || !cwd, onClick: () => refresh() }, "加载"),
						react.createElement("button", { className: "dskm_btn", disabled: busy || !cwd, onClick: register }, "登记")
					)
					: null,
				!embed && known.length > 0
					? react.createElement("div", { className: "dskm_legend" },
						"已登记：",
						known.map((w) => react.createElement("button", {
							key: w.cwd,
							className: "dskm_btn",
							style: { marginRight: 4 },
							onClick: () => { setCwd(w.cwd); refresh(w.cwd); },
						}, (w.exists ? "" : "⚠ ") + w.cwd + (w.enabledCount ? ` (${w.enabledCount})` : "")))
					)
					: null,
				notice ? react.createElement("div", { className: "dskm_desc" }, notice) : null,
				loading
					? react.createElement("div", { className: "dskm_empty" }, "加载中…")
					: !view
						? react.createElement("div", { className: "dskm_legend" }, embed ? "加载中…" : "输入工作区路径后点「加载」，查看该工作区启用了哪些技能。")
						: react.createElement("div", { className: "dskm_layers" },
							embed
								? react.createElement("div", { className: "dskm_legend" },
									view.session?.explicit
										? "已固定为自选子集（下面的会话勾选生效；工作区增删不再自动同步）。工作区新启用技能需手动勾选。"
										: "跟随工作区：会话自动启用工作区的全部技能，工作区增删即时同步。取消任一勾选即切换为自选。"
								)
								: react.createElement("div", { className: "dskm_sect" }, "技能清单（勾选 = 在工作区启用，硬链接到全局单副本）"),
							(view.skills ?? []).map((s) => {
								const inSession = !!sessionId && s.sessionEnabled;
								const isPreset = s.origin === "preset";
								const wsChecked = s.layer === "workspace" || s.enabled && s.layer === "workspace";
								const disabled = isPreset || busy;
								const showWsCheck = !embed;
								return react.createElement("label", { key: s.name, className: "dskm_litem" },
									showWsCheck
										? react.createElement("input", {
											type: "checkbox",
											checked: !!wsChecked && !isPreset,
											disabled: isPreset || busy,
											onChange: (e) => toggleWorkspace(s.name, e.target.checked),
										})
										: null,
									react.createElement("span", { style: { minWidth: 0, flex: "1 1 auto" } },
										react.createElement("span", { className: "dskm_name" }, s.name),
										react.createElement("span", { className: "dskm_desc" }, s.description || "")
									),
									react.createElement(react.Fragment, null, badges(s)),
									sessionId && !isPreset && (s.layer === "workspace" || s.enabled)
										? react.createElement("label", { className: "dskm_check" },
											react.createElement("input", {
												type: "checkbox",
												checked: inSession,
												disabled: busy,
												onChange: (e) => { e.stopPropagation(); toggleSession(s.name, e.target.checked); },
											}),
											"会话"
										)
										: null
								);
							})
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
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skill-manager",
				order: 30,
				label: "技能管理",
			}, SkillManagerPanel));
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
