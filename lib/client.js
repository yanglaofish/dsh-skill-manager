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
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState("");
			const [editing, setEditing] = useState(null); // skill object being edited
			const [draft, setDraft] = useState("");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");

			const refresh = useCallback(async () => {
				try {
					const data = await api("/list");
					if (data.ok) {
						setSkills(data.skills);
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

			return react.createElement("div", { className: "dskm" },
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
				notice ? react.createElement("div", { className: "dskm_desc" }, notice) : null,
				error ? react.createElement("div", { className: "dskm_desc" }, error) : null,
				loading
					? react.createElement("div", { className: "dskm_empty" }, "加载中…")
					: skills.length === 0
						? react.createElement("div", { className: "dskm_empty" }, "技能目录为空。点右上角导入 .zip 技能包。")
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
						)
			);
		}

		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skill-manager",
				order: 30,
				label: "技能管理",
			}, SkillManagerPanel));
		}

		exports.SkillManagerPanel = SkillManagerPanel;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
