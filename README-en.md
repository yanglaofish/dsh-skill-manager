# dsh-skill-manager

A DeepSeek Harness (DSH) plugin that provides a complete **management plane for agent skills** — unified listing, viewing, editing, importing, and enable/disable, with fine-grained control over *where and when* each skill takes effect via a three-layer model: **library / workspace / session**. The library only *stores* skills; enablement follows the project — a skill becomes visible to a workspace (and its sessions) only after it is toggled on there.

DSH "skills" are Markdown files with YAML frontmatter — the reusable capability packages of agents. Once you accumulate many of them, they scatter across the global directory, per-project directories, and even presets, becoming hard to manage. dsh-skill-manager gathers all of that into a single management plane:

- **Global skills** — list / view / edit / import / delete every skill (directory form: folder + SKILL.md). The library is a pure skill pool; it does not decide enablement.
- **Workspace skills** — each project maintains its own skill set (living in the project directory); **the only enable switch**: checked = enabled there, unchecked = invisible there.
- **Session skills** — temporarily toggle skills for the current session; defaults to *follow workspace*, can pin an explicit subset chosen freely from the whole library (not limited to the workspace set).
- **Cross-layer search** — full-text matching over name / description / whenToUse / body, with hit-field annotations.
- **Unified UI** — a settings page with two tabs plus a conversation-page skill panel; all three surfaces share the same row component (whole-row click toggles, enabled highlighted, disabled greyed with an outline, presets read-only, automatic pagination).
- **Cross-plugin integration** — a host-side `skillManager` service façade; other Cordis plugins can `inject: ['skillManager']` and call every capability.

It does not change how DSH loads skills — it manages how skills are organized on disk, so the native DSH engine reads exactly the set you intend.

> **v4.0 milestone**: single-file compatibility fully removed (directory form only), security hardening (path-traversal / zip-bomb / cwd-escape defenses), cross-platform (Windows / Linux / macOS), front-end size pre-checks, host service façade, error-boundary tests (165 assertions).

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

- **Global skills** tab: click a row to toggle enable/disable; "View/Edit" opens a detail modal (rendered Markdown preview + 📁 file browser: read-only by default, click "✏ Edit" to edit, save/cancel in the top bar, 2MB save cap); the "Import skill" button accepts a skill zip (≤50MB, ≤100MB expanded) or an entire folder for batch import.
- **Workspace skills** tab: pick a workspace from the dropdown at the top (auto-resolves the current session's workspace); the list below shows which skills are enabled there (disabled rows get a grey outline); preset skills are read-only and labelled with their owning preset.
- **Search box**: type a keyword for cross-layer full-text search (name / description / whenToUse / body); results annotate hit fields and show context snippets.
- **Conversation "Skills" tab**: view and temporarily adjust the current session's enabled skills.

**Alternative: manage via chat** — just tell the agent:

- "List my skills"
- "Enable markdown-formatter in this workspace"
- "Import this skill zip"
- "Search for skills mentioning SQL optimization"

The agent drives the operation through the 13 registered `skill_manager_*` tools. Other plugins can call the host `skillManager` service façade directly via `inject: ['skillManager']` (17 methods: list/get/edit/delete/importZip/workspaceToggle/sessionSet etc.).

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
│   │   │                       workspace / session / preset / security gates
│   │   │                       (isValidIdentifier / isAbsolutePath / samePath /
│   │   │                       assertRegisteredWorkspace)
│   │   └── apply()             wires 13 skill_manager_* tools + HTTP routes
│   │                           + skillManager service façade + sessions/
│   │                           agentPresets injection
│   └── client.js               client bundle (__ModuleLoader__ wrapper)
│       ├── SkillManagerPanel     settings: stats strip + two tabs + search +
│       │                         pagination + detail modal
│       ├── WorkspaceSkillsPanel  workspace/session skill panel
│       ├── SkillDetailModal      detail modal: preview + file browser/editor
│       └── SkillRow              shared row component for all three surfaces
├── cordis.patch.yml          bundle patch: mounts the host plugin row
├── test/
│   ├── unit.mjs              165 isolated assertions (temporary DSH_HOME, error boundaries)
│   └── seed-sample.mjs       sample-skill writer (dev verification)
├── README.md / README-en.md
└── package.json              bundle manifest: exports + dsh.client (v4.0.0)
```

**Core design principle**: a skill's state has a single source of truth — the on-disk directory layout. Skills live in the library (`~/.dsh/skill-manager/library/`, not scanned by the engine), workspace enablement is the whitelist in `<cwd>/.dsh/skills` (the only engine-visible source), session selection sits in a dedicated JSON; every UI and tool reads the same disk facts, so there is never a fork between in-memory state and disk state.

### Three-layer model

```
┌─ Session layer  (Session)     ~/.dsh/skill-manager/sessions/<sessionId>.json
│    follows the workspace by default; an explicit subset may freely pick any library skill
├─ Workspace layer (Workspace)  <cwd>/.dsh/skills/   ← the engine's only scanned workspace root
│    dir symlink/copy → library entry; presence == enabled here
└─ Library layer   (Library)    ~/.dsh/skill-manager/library/  ← pure skill pool, not scanned
                                every user skill lives here; no enable/disable concept
```

**Key semantics**: the library is **not** "globally enabled" — a skill in the library is invisible to every workspace until a workspace checks it into `<cwd>/.dsh/skills` (whitelist). This removes the old-model conflict ("enabled globally but this project doesn't want it"): enablement is decided by each project. The dsh engine only scans the workspace's `.dsh/skills` (project-dsh root) and presets; the library under `~/.dsh/skill-manager/` is never discovered, so the whitelist is enforced natively.

### Key modules

| Module | Responsibility |
| --- | --- |
| `parseSkillDoc / serializeSkillDoc` | skill doc parsing/serialization: YAML frontmatter + body, strips UTF-8 BOM |
| `scanDir / findSkill / searchSkills` | directory scanning, lookup by name, cross-layer full-text search (hit fields + snippet) |
| `importSkillDocs / importSkillZipFromBuffer` | folder batch import / zip import, per-item validation, partial failure tolerated |
| `linkGlobalSkillToWorkspace / unlink…` | workspace enable/disable: directory symlink first, degrades to whole-dir copy (fs.cp) |
| `readSessionConfig / setSessionSkills` | session selection read/write: explicit subset (free pick from the whole library) vs follow-workspace |
| `scanPresetSkills` | reads skills physically bundled inside presets via the `agent-presets` service |
| `normalizeParameters / registerTool` | normalizes tool parameters to standard JSON Schema (equivalent to defineTool) |
| `isValidIdentifier / isAbsolutePath / samePath / assertRegisteredWorkspace` | security gates: identifier whitelist, platform-neutral absolute paths, case-insensitive path equality, writes limited to registered workspaces |
| `SkillManagerPanel / WorkspaceSkillsPanel / SkillDetailModal / SkillRow` | settings + conversation UI, shared row component, detail modal, pagination & sorting |

### Data flow

**List view (/list)**

`scanDir(skillsRoot()) + scanPresetSkills() + listWorkspaces()` collected in parallel and merged into a library → preset array, returned together with the stats strip (library total / preset count / registered workspaces).

**Workspace resolution (/view)**

The client takes the current sessionId from the session store → `/view?sessionId=` → the host resolves the workspace via `ctx.sessions.get(id).header.cwd` (no manual path entry) and auto-registers it; the same response carries the workspace list for the picker, eliminating the stale "no workspaces" race.

**Workspace enablement (/workspace/toggle)**

Whole-directory enablement: prefers `symlink(sourceDir, targetDir, 'dir')` (single copy, edits propagate instantly; degrades automatically when Windows lacks Developer Mode); the fallback is a whole-directory `fs.cp` copy (cross-volume capable). Re-enabling clears the stale entry first, so it is idempotent. Write operations (toggle / file writes / session set) only target **registered workspaces**, preventing crafted HTTP calls from modifying arbitrary paths.

**Session selection (/session/set)**

Toggling any skill pins an explicit subset (`explicit=true`): the host accepts any library skill (the workspace enabled set only defines the *follow* default, it does not restrict an explicit pick); the "↩ back to follow" button restores `explicit=false` with an empty subset, returning the session to the workspace enabled set.

**Search (/search?q=)**

Collects across global (enabled + disabled) / presets / all registered workspaces; case-insensitive substring match on name / description / whenToUse / body; same-name dedup by workspace > global > preset priority; returns hit fields (`why`) and a body snippet (`snippet`).

### Design details

- **Windows cross-volume**: with `~/.dsh` on C: and the workspace on D:, hard links always fail (`EXDEV`); symlinks need Developer Mode/admin rights. The design is therefore *directory symlink first, auto-degrade to whole-dir copy* — both transports behave identically from the outside.
- **Cross-platform deployment** (v4.0): absolute-path checks use `node:path.isAbsolute` (Windows `/` `\`, POSIX `/`, UNC all handled); `samePath` compares case-insensitively on Windows; the client normalizes path separators. Runs on Windows / Linux / macOS.
- **Security gates** (v4.0): skill-name/sessionId whitelists (`isValidIdentifier`) block path traversal; write-side cwds must be registered workspaces (`assertRegisteredWorkspace`); caps: 2MB HTTP body, 50MB zip upload / 1000 entries / 100MB expansion; all error text is localized (Chinese) and the UI pre-checks size limits before upload/save.
- **UTF-8 BOM**: Windows editors often prepend a BOM that breaks the strict `^---` frontmatter delimiter and silently drops the whole frontmatter — `parseSkillDoc` strips it up front.
- **Tool schema**: a bare `parameters` map (`{key: spec}`) is read as a JSON Schema during model projection, yielding `type: null` and a hard error. `registerTool` normalizes every tool to `{type:'object', properties, required}` (equivalent to `defineTool`), so all 13 tools pass validation.
- **Host service façade** (v4.0): `ctx.provide('skillManager', …)` exposes a 17-method programming interface; other plugins `inject: ['skillManager']` — no HTTP or model tools required.
- **Reusing dsh's renderer**: Markdown preview `require`s the seed module `@deepseek-ai/dsh-client-ui-primitives` for the official `MarkdownText` (KaTeX math + syntax-highlighted fences + tables), bundling no markdown library of its own.
- **Preset root resolution**: when the bundle is installed via a junction, `import.meta.dirname` points into the workspace and module-relative preset discovery breaks — the plugin reads the authoritative roots from the `agent-presets` service's `resolvedRoots` instead.
- **No build step**: both halves are plain JS; the client bundle is hand-written `react.createElement`, no JSX/TS/bundler required — install and run.

## Development

```sh
# syntax check
node --check lib/index.js lib/client.js

# run 165 isolated assertions (temporary DSH_HOME, no pollution)
node test/unit.mjs
```

- All file operations are module-level functions testable without a live runtime; `apply()` only works during assembly.
- **GitHub-install mode**: after changing code, `git push`, then `pnpm update dsh-skill-manager` and restart `dsh web`.
- **Local-dev mode** (changes take effect on restart): `dsh plugin --profile web add .` or a manual link dependency.

## License

MIT
