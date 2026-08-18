# dsh-skill-manager

A DeepSeek Harness (DSH) plugin that provides a complete **management plane for agent skills** — unified listing, viewing, editing, importing, and enable/disable, with fine-grained control over *where and when* each skill takes effect via a three-layer model: **global / workspace / session**.

DSH "skills" are Markdown files with YAML frontmatter — the reusable capability packages of agents. Once you accumulate many of them, they scatter across the global directory, per-project directories, and even presets, becoming hard to manage. dsh-skill-manager gathers all of that into a single management plane:

- **Global skills** — list / view / edit / import / delete / enable / disable every skill; enabled state at a glance.
- **Workspace skills** — each project maintains its own skill set (living in the project directory); switch workspaces to switch views.
- **Session skills** — temporarily toggle skills for the current session; defaults to *follow workspace*, can pin an explicit subset.
- **Cross-layer search** — full-text matching over name / description / whenToUse / body, with hit-field annotations.
- **Unified UI** — a settings page with two tabs plus a conversation-page skill panel; all three surfaces share the same row component (whole-row click toggles, enabled highlighted, disabled greyed, presets read-only, automatic pagination).

It does not change how DSH loads skills — it manages how skills are organized on disk, so the native DSH engine reads exactly the set you intend.

## Install

```sh
dsh plugin --profile web add github:yanglaofish/dsh-skill-manager
```

Then start:

```sh
dsh web
```

## Usage

**Recommended: manage from the UI** — after starting `dsh web`, open Settings → Skill Management:

- **Global skills** tab: click a row to toggle enable/disable; "View/Edit" opens a detail modal (rendered Markdown preview + raw edit); the "Import skill" button in the header accepts a skill zip or an entire folder for batch import.
- **Workspace skills** tab: pick a workspace from the dropdown at the top (auto-resolves the current session's workspace); the list below shows which skills are enabled there; preset skills are read-only and labelled with their owning preset.
- **Search box**: type a keyword for cross-layer full-text search (name / description / whenToUse / body); results annotate hit fields and show context snippets.
- **Conversation "Skills" tab**: view and temporarily adjust the current session's enabled skills.

**Alternative: manage via chat** — just tell the agent:

- "List my skills"
- "Enable markdown-formatter in this workspace"
- "Import this skill zip"
- "Search for skills mentioning SQL optimization"

The agent drives the operation through the 15 registered `skill_manager_*` tools.

## Uninstall

```sh
dsh plugin --profile web remove dsh-skill-manager
```

## Technical overview

### Architecture

The plugin has a **host half** (Node, runs inside the DSH main process) and a **client half** (browser bundle, runs inside the Web UI), connected through a self-registered HTTP API at `/skill-manager/api/*`. The host is plain ESM (no build step); the client is a hand-written `react.createElement` bundle.

```
dsh-skill-manager
├── lib/
│   ├── index.js               host half (plain ESM, no compilation)
│   │   ├── module-level fns    scanning / parsing / CRUD / import / search /
│   │   │                       workspace / session / preset
│   │   └── apply()             wires 15 skill_manager_* tools + HTTP routes
│   │                           + sessions/agentPresets injection
│   └── client.js               client bundle (__ModuleLoader__ wrapper)
│       ├── SkillManagerPanel     settings: stats strip + two tabs + search +
│       │                         pagination + detail modal
│       ├── WorkspaceSkillsPanel  workspace/session skill panel
│       └── SkillRow              shared row component for all three surfaces
├── cordis.patch.yml          bundle patch: mounts the host plugin row
├── test/
│   ├── unit.mjs              83 isolated assertions (temporary DSH_HOME)
│   └── seed-sample.mjs       sample-skill writer (dev verification)
├── README.md / README-en.md
└── package.json              bundle manifest: exports + dsh.client
```

**Core design principle**: a skill's state has a single source of truth — the on-disk directory layout. Global enablement lives in `~/.dsh/skills`, workspace enablement in `<cwd>/.dsh/skills`, session selection in a dedicated JSON; every UI and tool reads the same disk facts, so there is never a fork between in-memory state and disk state.

### Three-layer model

```
┌─ Session layer  (Session)     ~/.dsh/skill-manager/sessions/<sessionId>.json
│    subset of the workspace set; default: follow workspace
├─ Workspace layer (Workspace)  <cwd>/.dsh/skills/
│    symlink → global file (degrades to copy on Windows without Developer Mode)
└─ Global layer    (Global)     ~/.dsh/skills/          (enabled)
                                ~/.dsh/skills-disabled/ (disabled)
```

Layers merge along the global → workspace → session scope chain; **the nearest layer wins a duplicate name**. A globally enabled skill is visible everywhere; workspace enablement is a same-name override (the dsh engine ranks `project-dsh` roots above `user-dsh` roots); session selection is a subset of the visible set.

### Key modules

| Module | Responsibility |
| --- | --- |
| `parseSkillDoc / serializeSkillDoc` | skill doc parsing/serialization: YAML frontmatter + body, strips UTF-8 BOM |
| `scanDir / findSkill / searchSkills` | directory scanning, lookup by name, cross-layer full-text search (hit fields + snippet) |
| `importSkillDocs / importSkillZipFromBuffer` | folder batch import / zip import, per-item validation, partial failure tolerated |
| `linkGlobalSkillToWorkspace / unlink…` | workspace enable/disable: symlink first, degrades to copyFile |
| `readSessionConfig / setSessionSkills` | session selection read/write: explicit subset vs follow-workspace, intersection-validated against the workspace allowed set |
| `scanPresetSkills` | reads skills physically bundled inside presets via the `agent-presets` service |
| `normalizeParameters / registerTool` | normalizes tool parameters to standard JSON Schema (equivalent to defineTool) |
| `SkillManagerPanel / WorkspaceSkillsPanel / SkillRow` | settings + conversation UI, shared row component, pagination & sorting |

### Data flow

**List view (/list)**

`scanDir(skillsRoot()) + scanDir(disabledRoot()) + scanPresetSkills() + listWorkspaces()` collected in parallel and merged into an enabled → disabled → preset array, returned together with the stats strip (total / global enabled / global disabled / preset count / registered workspaces).

**Workspace resolution (/view)**

The client takes the current sessionId from the session store → `/view?sessionId=` → the host resolves the workspace via `ctx.sessions.get(id).header.cwd` (no manual path entry) and auto-registers it; the same response carries the workspace list for the picker, eliminating the stale "no workspaces" race.

**Workspace enablement (/workspace/toggle)**

Prefers `symlink(source, target)` pointing at the global file (single copy, edits propagate instantly); when Windows lacks Developer Mode and symlink throws a privilege error, it silently degrades to `copyFile` (cross-volume capable, still recognized as enabled by name). Re-enabling unlinks the stale entry first, so it is idempotent.

**Session selection (/session/set)**

The client computes the target subset and whether it equals the whole workspace set: equal → restore follow (`explicit=false`); otherwise pin an explicit subset (`explicit=true`), which the host intersects against the workspace allowed set before persisting.

**Search (/search?q=)**

Collects across global (enabled + disabled) / presets / all registered workspaces; case-insensitive substring match on name / description / whenToUse / body; same-name dedup by workspace > global > preset priority; returns hit fields (`why`) and a body snippet (`snippet`).

### Design details

- **Windows cross-volume**: with `~/.dsh` on C: and the workspace on D:, hard links always fail (`EXDEV`); symlinks need Developer Mode/admin rights. The design is therefore *symlink first, auto-degrade to copy* — both transports behave identically from the outside.
- **UTF-8 BOM**: Windows editors often prepend a BOM that breaks the strict `^---` frontmatter delimiter and silently drops the whole frontmatter — `parseSkillDoc` strips it up front.
- **Tool schema**: a bare `parameters` map (`{key: spec}`) is read as a JSON Schema during model projection, yielding `type: null` and a hard error. `registerTool` normalizes every tool to `{type:'object', properties, required}` (equivalent to `defineTool`), so all 15 tools pass validation.
- **Reusing dsh's renderer**: Markdown preview `require`s the seed module `@deepseek-ai/dsh-client-ui-primitives` for the official `MarkdownText` (KaTeX math + syntax-highlighted fences + tables), bundling no markdown library of its own.
- **Preset root resolution**: when the bundle is installed via a junction, `import.meta.dirname` points into the workspace and module-relative preset discovery breaks — the plugin reads the authoritative roots from the `agent-presets` service's `resolvedRoots` instead.
- **No build step**: both halves are plain JS; the client bundle is hand-written `react.createElement`, no JSX/TS/bundler required — install and run.

## Development

```sh
# syntax check
node --check lib/index.js lib/client.js

# run 83 isolated assertions (temporary DSH_HOME, no pollution)
node test/unit.mjs
```

- All file operations are module-level functions testable without a live runtime; `apply()` only works during assembly.
- **GitHub-install mode**: after changing code, `git push`, then `pnpm update dsh-skill-manager` and restart `dsh web`.
- **Local-dev mode** (changes take effect on restart): `dsh plugin --profile web add .` or a manual link dependency.

## License

MIT
