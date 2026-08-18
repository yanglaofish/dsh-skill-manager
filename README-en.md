# dsh-skill-manager

Skill lifecycle manager for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — list, view, edit, import, enable/disable skills across the global / workspace / session three-layer model, with a full settings UI and a conversation-page tab.

---

## What it does

Skills (`.md` files with YAML frontmatter) are the reusable capability packages of DSH agents. This plugin gives them a management plane:

- **One skill, three layers** — a skill can be enabled globally, in a workspace, or for a single session; the effective set is the layered merge.
- **No manual path fiddling** — the workspace picker resolves the current session's workspace automatically.
- **Full UI** — a settings page and a conversation-page tab, with an identical row layout across all three surfaces.

---

## Three-layer model

```
┌─ Session layer  (Session)     ~/.dsh/skill-manager/sessions/<sessionId>.json
│    explicit subset of the workspace set; default: follow workspace
├─ Workspace layer (Workspace)  <cwd>/.dsh/skills/
│    symlink → global file (degrades to copy on Windows without Developer Mode)
│    presence here == enabled in this workspace, overrides global by name
└─ Global layer    (Global)     ~/.dsh/skills/          (enabled)
                                ~/.dsh/skills-disabled/ (disabled)
```

| Layer | Where | Effective scope | Same-name priority |
|---|---|---|---|
| Global | `~/.dsh/skills` | every workspace & session | low |
| Workspace | `<cwd>/.dsh/skills` | that workspace (and sessions following it) | high (wins over global) |
| Session | session config | that session only | highest (subset of the visible set) |

Key semantics:

- A **globally enabled** skill is visible everywhere; workspace enablement is **not a whitelist** — it is a same-name override (the dsh engine merges `project-dsh` roots above `user-dsh` roots, and the nearest layer wins).
- **Workspace enablement** creates a symlink to the global file (single copy, edits propagate instantly). On Windows without Developer Mode, symlinks need admin rights, so the plugin **auto-degrades to a copy** — still cross-volume, still flagged by name.
- **Session selection**: default `follow workspace` (auto-syncs workspace changes); toggling any skill pins an explicit subset; re-checking everything restores follow.

---

## Features

### Host (lib/index.js)
- `list / get / edit / delete / enable / disable` — global-layer CRUD on disk
- `import` — skill `.zip` (root `SKILL.md` with a kebab-case `name`) or **batch folder import**
- `search` — cross-layer full-text search over name / description / whenToUse / body, with hit-field tags and snippets
- `workspace` — register / rebind / forget workspaces, toggle skills in a workspace
- `session` — view / set the per-session skill subset (validated against the workspace allowed set)
- Preset catalog — reads skills physically bundled inside agent presets (e.g. the `cordis` preset ships `cordis-plugin-development`, `editing-cordis-compositions`) via the `agent-presets` service

### Client (lib/client.js) — settings page + conversation tab
- Stats strip: total / global enabled / global disabled / preset count / registered workspaces
- Two tabs: **Global skills** (toggle rows, detail modal, delete) and **Workspace skills** (picker row above the search box)
- Search box with debounced cross-layer results
- **Skill detail modal**: GFM preview via dsh's own `MarkdownText` (KaTeX math, syntax-highlighted fences) + a raw edit tab, with frontmatter/body validation
- Consistent **SkillRow** everywhere: whole-row click toggles, enabled = highlighted + solid dot, disabled = greyed + hollow dot; preset skills are read-only with their owning preset label
- **Pagination** (10/page) on the global list, search results, and workspace & session lists — enabled skills first, preset last
- Workspace picker auto-resolves the current session's workspace (via `ctx.sessions` + the `agent-presets` service)

---

## Install

The plugin is developed in-place as a git repo and installed into a profile as a `link:` dependency (a junction on Windows), so restarts pick up the latest code:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-skill-manager": "link:D:\\path\\to\\dsh-skill-manager"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* ... */ "dsh-skill-manager" ]
    }
  }
}
```

Then restart `dsh web`. The bundle patch (`cordis.patch.yml`) mounts the host half; the client half registers the settings section and the conversation tab.

---

## Development

```bash
node --check lib/index.js lib/client.js   # syntax
node test/unit.mjs                         # 83 assertions, isolated DSH_HOME
```

- All file operations are module-level and testable without a live `ctx`; `apply()` wraps tool registration with schema normalization (equivalent to `defineTool`), which is why all 15 tools pass the model projection.
- The plugin injects `tools`, `webServer`, `sessions`, and `agentPresets` — `sessions` resolves the current workspace, `agentPresets` supplies the authoritative preset roots (the bundle is junction-installed, so module-relative preset discovery would break).

---

## Tech notes

- **Windows cross-volume**: `~/.dsh` on C:, workspace on D: → hard links fail (`EXDEV`), symlinks need Developer Mode. The plugin tries symlink first, then silently degrades to a copy.
- **UTF-8 BOM**: Windows editors often prepend a BOM that breaks the strict `^---` frontmatter delimiter — `parseSkillDoc` strips it.
- **Tool schema**: bare `parameters` maps must be normalized to `{type:'object', properties, required}` (the model projection rejects `type: null`).
- **Reusing dsh's renderer**: the client `require`s the seed module `@deepseek-ai/dsh-client-ui-primitives` for `MarkdownText` instead of bundling a markdown library.

---

## License

MIT (or as you prefer).
