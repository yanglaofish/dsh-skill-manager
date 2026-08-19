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
		// (note: the preview tab that used dsh's MarkdownText renderer was
		// removed in v4.1 — the detail modal opens into the file browser now)

		const API = "/skill-manager/api";

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
		".dskm_btn:disabled{opacity:.6;cursor:not-allowed}" +
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
			".dskm_pager{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 0 2px}" +
		".dskm_modal_wide{width:min(1100px,94vw)}" +
		".dskm_badge{font-size:11px;font-weight:600;color:var(--dsw-alias-accent);border:1px solid var(--dsw-alias-accent);border-radius:6px;padding:1px 6px;margin-left:8px}" +
		".dskm_ftwrap{display:flex;gap:0;min-height:56vh;max-height:72vh;padding:0;flex-direction:row}" +
		".dskm_ftleft{flex:0 0 200px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:8px 4px;max-height:72vh}" +
		".dskm_ftright{flex:1;overflow:hidden;display:flex;flex-direction:column}" +
		".dskm_ftnode{cursor:pointer;padding:3px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none}" +
		".dskm_ftnode:hover{background:var(--dsw-alias-state-hover)}" +
		".dskm_ftsel{background:var(--dsw-alias-state-selected);color:var(--dsw-alias-accent)}" +
		".dskm_fview{flex:1;margin:0;padding:10px 14px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);max-height:72vh}" +
		".dskm_ftbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}" +
		".dskm_ftpath{flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
		".dskm_ftbtns{display:flex;gap:6px;flex:none;align-items:center}" +
		".dskm_ftedit{flex:none}" +
		".dskm_ftsave{flex:none}" +
		".dskm_savebtn{flex:none;border-color:var(--dsw-alias-accent);color:var(--dsw-alias-accent);font-weight:600}" +
		".dskm_fta{flex:1;width:100%;margin:0;padding:10px 14px;border:none;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;white-space:pre;overflow-y:auto;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);resize:none;outline:none;max-height:72vh}" +
		".dskm_fview{flex:1;margin:0;padding:10px 14px;overflow-y:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);max-height:55vh}";
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
					}, (open ? "▼ " : "▶ ") + "📁 " + node.name),
					open && node.children ? node.children.map((c) =>
						react.createElement(FileTreeNode, { key: c.path, node: c, depth: depth + 1, selected, onSelect })
					) : null
				);
			}
			return react.createElement("div", {
				className: "dskm_ftnode" + (selected === node.path ? " dskm_ftsel" : ""),
				style: { paddingLeft: (depth * 14) + "px" },
				onClick: () => onSelect(node.path)
			}, "📄 " + node.name);
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
			const [selFile, setSelFile] = useState("");
			const [fileContent, setFileContent] = useState(null);
			const [fileDraft, setFileDraft] = useState("");
			const [fileLoading, setFileLoading] = useState(false);
			const [fileDirty, setFileDirty] = useState(false);
			const [fileSaving, setFileSaving] = useState(false);
			const [fileEditing, setFileEditing] = useState(false);

			useEffect(() => {
				let cancelled = false;
				setFileTree(null);
				setTreeError("");
				setSelFile("");
				setFileContent(null);
				setFileDraft("");
				setFileDirty(false);
				const qs = "/skill-files?name=" + encodeURIComponent(skill?.name ?? "") + (cwd ? "&cwd=" + encodeURIComponent(cwd) : "");
				api(qs).then((data) => {
					if (cancelled) return;
					if (data.ok) {
						setFileTree(data.files ?? []);
						// default to SKILL.md — the skill's main document
						const md = findSkillMdPath(data.files ?? []);
						if (md) loadFile(md);
					} else setTreeError(data.error ?? "文件树加载失败");
				}).catch(() => { if (!cancelled) setTreeError("文件树加载失败"); });
				return () => { cancelled = true; };
			}, [skill?.name, cwd]);

			const loadFile = async (relPath) => {
				setSelFile(relPath);
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
				if (!selFile) return;
				// host readJsonBody caps writes at 2MB — check locally first
				if (fileDraft.length > 2 * 1024 * 1024) {
					setErr("内容超过 2MB 保存上限（单文件 ≤2MB）");
					return;
				}
				await withBusy(setFileSaving, setErr, async () => {
					const data = await api("/skill-file", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: skill.name, path: selFile, content: fileDraft, cwd: cwd || undefined }),
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
					react.createElement("div", { className: "dskm_mbody dskm_ftwrap" },
							react.createElement("div", { className: "dskm_ftleft" },
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
							react.createElement("div", { className: "dskm_ftright" },
								fileLoading
									? react.createElement("div", { className: "dskm_empty" }, "加载中…")
									: fileContent != null
										? react.createElement(react.Fragment, null,
											react.createElement("div", { className: "dskm_ftbar" },
												react.createElement("span", { className: "dskm_ftpath", style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, selFile),
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
												: react.createElement("pre", { className: "dskm_fview" }, fileContent)
										)
										: selFile
											? react.createElement("div", { className: "dskm_empty" }, "无法读取该文件")
											: react.createElement("div", { className: "dskm_empty" }, "选择左侧文件查看/编辑内容")
							)
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
				// front-end size pre-checks — surface the server's limits before
				// uploading, instead of failing after the transfer
				const MAX_ZIP = 50 * 1024 * 1024; // host: /import cap
				const overZip = zipFiles.filter((f) => f.size > MAX_ZIP);
				if (overZip.length) {
					setError(`跳过超限 zip（单个 >50MB）：${overZip.map((f) => f.name).join("、")}\n技能包请在 50MB 内（含解压后总大小 ≤100MB）`);
					e.target.value = "";
					return;
				}
				await withBusy(setBusy, setNotice, async () => {
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
				});
				e.target.value = "";
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

			// One pool row (library or search hit): immutable checkbox + dimmed
			// body, optional action cluster. Preset rows get their tag and stay
			// visually dimmed + unclickable.
			const poolRow = (item, actions) => {
				const isPreset = item.origin === "preset" || item.preset;
				return react.createElement(SkillRow, {
					key: item.name,
					name: item.name,
					desc: item.description || "",
					checked: true, // in the pool; enablement is per-workspace
					disabled: isPreset, // preset rows stay visually dimmed + unclickable
					notoggle: true, // library rows can't be toggled
					lib: true, // dim the non-button area; action buttons stay bright
					onToggle: null,
					tag: isPreset ? (item.preset?.label ?? "preset") : null,
					actions,
				});
			};

			// search results: same SkillRow layout as the library list — pure pool,
			// NO enable/disable and NO snippet line here (rows look exactly
			// like the library list: name + description).
			const renderSearchResults = () => {
				const sorted = sortPool(results);
				const pg = paginate(sorted);
				return react.createElement("div", { className: "dskm_layers" },
					react.createElement("div", { className: "dskm_legend" }, `找到 ${(results ?? []).length} 个匹配 "${query.trim()}"`),
					pg.items.map((r) => poolRow(r, null)),
					renderPager(pg)
				);
			};

			// global tab list, paginated; preset entries are read-only rows
			const renderGlobalList = () => {
				const pg = paginate(skills);
				return react.createElement("div", { className: "dskm_layers" },
					react.createElement("div", { className: "dskm_legend" }, "技能库 = 可用技能池。是否在工作区生效请到「工作区技能」勾选。"),
					pg.items.map((s) => poolRow(s, s.origin === "preset"
						? react.createElement("span", { className: "dskm_legend" }, "只读（预设捆绑）")
						: react.createElement("div", { className: "dskm_acts" },
							react.createElement("button", { className: "dskm_btn", disabled: busy, onClick: (e) => { e.preventDefault(); startEdit(s); } }, "查看/编辑"),
							react.createElement("button", { className: "dskm_btn dskm_danger", disabled: busy, onClick: (e) => { e.preventDefault(); if (window.confirm("确认永久删除技能 " + s.name + " ？")) run("delete", s.name); } }, "删除")
						)
					)),
					renderPager(pg)
				);
			};

			return react.createElement("div", { className: "dskm" },
				// header: title + scan + import
				react.createElement("div", { className: "dskm_h" },
					react.createElement("div", { className: "dskm_name" }, "技能管理"),
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

			return react.createElement("div", { className: "dskm_ws" },
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
								q ? react.createElement("button", { className: "dskm_btn", onClick: () => { setQ(""); setPage(0); } }, "清除") : null
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
