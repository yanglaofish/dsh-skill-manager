// dsh-skill-manager — Skill lifecycle manager (host half)
// Views the full skill spectrum: user-layer skills (~/.dsh/skills) are fully
// manageable (list / view / edit / import(zip) / delete / enable / disable);
// preset-bound skills (shipped + user agent-presets) are read-only catalog
// entries labelled with their owning mode — the preset owns their lifecycle.
import { readdir, readFile, writeFile, mkdir, rename, unlink, copyFile, stat, readlink, symlink, link } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, extname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import AdmZip from 'adm-zip';

export const name = 'dsh-skill-manager';
const inject = ['tools', 'webServer', 'sessions', 'agentPresets'];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

// Active skills root and the disabled holding area (user layer).
function skillsRoot() {
  return join(dshHome(), 'skills');
}
function disabledRoot() {
  return join(dshHome(), 'skills-disabled');
}

// Preset label map: directory id -> { label, order }. User-authored presets
// live under $DSH_HOME/.agent-presets/<id>; shipped presets next to the app.
const PRESET_LABELS = new Map([
  ['standard', { label: '标准模式', order: 1 }],
  ['code', { label: 'PTC 模式', order: 2 }],
  ['minimal', { label: '极简模式', order: 3 }],
  ['cordis', { label: '创造模式', order: 4 }],
]);

// Shipped preset root: the agent-presets directory beside this deployment's
// own config. This bundle is installed as a junction into the profile's
// node_modules, so `import.meta.dirname` resolves to the workspace — walking
// up from the module never reaches the deployment. In the live process the
// authoritative roots come from the `agent-presets` service (inject), which
// carries `resolvedRoots` ([...system roots, <DSH_HOME>/.agent-presets]).
// `apply` sets this from ctx when available; the fallback below is for tests
// and read-only tool calls where the service isn't injectable.
let presetRootsOverride = null;
function shippedPresetRoot() {
  const candidates = [
    // dsh package adjacent to us (deployment node_modules)
    resolve(import.meta.dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets'),
    // profile node_modules hoist
    resolve(import.meta.dirname, '..', '..', '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'cordis', 'preset.yml')) || existsSync(join(c, 'standard', 'preset.yml'))) return c;
  }
  return candidates[0];
}
// User-authored preset root.
function userPresetRoot() {
  return join(dshHome(), '.agent-presets');
}

// Parse a SKILL.md file into { frontmatter, body }.
function parseSkillDoc(raw) {
  // strip a UTF-8 BOM if present — Windows editors/pickers often add one,
  // and a leading BOM breaks the strict ^--- frontmatter delimiter match.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  try {
    const fm = parseYaml(match[1]) || {};
    return { frontmatter: typeof fm === 'object' ? fm : {}, body: match[2] ?? '' };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

function serializeSkillDoc(frontmatter, body) {
  const head = Object.keys(frontmatter).length ? `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n` : '';
  return `${head}${body.startsWith('\n') ? body : '\n' + body}`;
}

// Read one skill entry from a directory (active or disabled).
async function readSkillEntry(dir, fileName) {
  const filePath = join(dir, fileName);
  const raw = await readFile(filePath, 'utf8');
  const { frontmatter, body } = parseSkillDoc(raw);
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : basename(fileName, extname(fileName));
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  return {
    name,
    description,
    whenToUse: typeof frontmatter.whenToUse === 'string' ? frontmatter.whenToUse : '',
    fileName,
    filePath,
    enabled: dir === skillsRoot(),
    body,
    frontmatter,
    origin: 'user',
  };
}

async function scanDir(dir) {
  try {
    const names = await readdir(dir, { withFileTypes: true });
    const entries = [];
    for (const ent of names) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      try {
        entries.push(await readSkillEntry(dir, ent.name));
      } catch {
        // skip unreadable entries
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function summarize(entry) {
  const summary = {
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    enabled: entry.enabled,
    fileName: entry.fileName,
    bodyLength: entry.body.length,
    origin: entry.origin ?? 'user',
  };
  if (entry.preset) {
    summary.preset = {
      id: entry.preset.id,
      label: entry.preset.label,
      order: entry.preset.order,
    };
  }
  return summary;
}

// Read one preset-bound skill entry (directory-bundle form: <preset>/skills/<name>/SKILL.md).
async function readPresetSkillEntry(skillMdPath, presetId) {
  const raw = await readFile(skillMdPath, 'utf8');
  const { frontmatter, body } = parseSkillDoc(raw);
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : basename(dirname(skillMdPath));
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  const meta = PRESET_LABELS.get(presetId) ?? { label: presetId, order: 99 };
  return {
    name,
    description,
    whenToUse: typeof frontmatter.whenToUse === 'string' ? frontmatter.whenToUse : '',
    fileName: basename(skillMdPath),
    filePath: skillMdPath,
    enabled: true, // preset layer is always active for its own agents
    body,
    frontmatter,
    origin: 'preset',
    preset: { id: presetId, label: meta.label, order: meta.order },
  };
}

// Scan one preset root (<root>/<presetId>/skills/**/SKILL.md).
async function scanPresetRoot(root) {
  try {
    const presetDirs = await readdir(root, { withFileTypes: true });
    const entries = [];
    for (const presetDir of presetDirs) {
      if (!presetDir.isDirectory()) continue;
      const skillsDir = join(root, presetDir.name, 'skills');
      let skillNames;
      try {
        skillNames = await readdir(skillsDir, { withFileTypes: true });
      } catch {
        continue; // preset without a skills/ dir
      }
      for (const skillItem of skillNames) {
        if (!skillItem.isDirectory()) continue;
        const skillMd = join(skillsDir, skillItem.name, 'SKILL.md');
        try {
          entries.push(await readPresetSkillEntry(skillMd, presetDir.name));
        } catch { /* skip */ }
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// All preset-bound skills across shipped + user preset roots.
async function scanPresetSkills() {
  // Live process: use the agent-presets service's resolved roots (authoritative,
  // includes the deployment's shipped root + $DSH_HOME/.agent-presets).
  if (presetRootsOverride && presetRootsOverride.length) {
    const seen = new Set();
    const entries = [];
    for (const root of presetRootsOverride) {
      entries.push(...await scanPresetRoot(root));
    }
    return entries.filter((e) => {
      const key = `${e.preset.id}/${e.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const [shipped, user] = await Promise.all([
    scanPresetRoot(shippedPresetRoot()),
    scanPresetRoot(userPresetRoot()),
  ]);
  const seen = new Set();
  return [...shipped, ...user].filter((e) => {
    const key = `${e.preset.id}/${e.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Validate a skill file name: kebab-case, .md.
function validSkillFileName(name) {
  return /^[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(name);
}

// ---------- workspace (L1) and session (L2) layers ----------

// Plugin private data root.
function managerRoot() {
  return join(dshHome(), 'skill-manager');
}

// Workspace skill-link directory: <cwd>/.dsh/skills — exists == workspace
// enabled set (links to the global source, single copy).
function workspaceSkillDir(cwd) {
  return join(resolve(cwd), '.dsh', 'skills');
}

// The workspace .dsh dir always exists after first toggle; keep the
// workspace's own .dsh/skills isolated from plugin bookkeeping.
function ensureWorkspaceSkillDir(cwd) {
  return mkdir(workspaceSkillDir(cwd), { recursive: true });
}

// List enabled workspace skills: every entry under <cwd>/.dsh/skills.
// Workspace-enabled entries are copies of a global skill (cross-volume
// hard links are impossible: ~/.dsh is on C:, the workspace on D:), so a
// same-named file under the workspace dir means "enabled here". Real local
// files are workspace-authored.
async function listWorkspaceSkills(cwd) {
  const dir = workspaceSkillDir(cwd);
  try {
    const names = await readdir(dir, { withFileTypes: true });
    const skills = [];
    for (const ent of names) {
      if (!ent.name.endsWith('.md')) continue;
      const filePath = join(dir, ent.name);
      // same filename in the global root → this entry is a workspace copy
      // of that global skill (copy semantics now that hard links can't cross
      // volumes); anything else is a workspace-authored local skill.
      let linked = false;
      let linkTarget = null;
      try {
        const globalPath = join(skillsRoot(), ent.name);
        const gi = await stat(globalPath);
        if (gi.isFile()) {
          linked = true;
          linkTarget = globalPath;
        }
      } catch { /* no such global file → local workspace skill */ }
      let raw;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      const { frontmatter, body } = parseSkillDoc(raw);
      const name = typeof frontmatter.name === 'string' ? frontmatter.name : basename(ent.name, extname(ent.name));
      skills.push({
        name,
        fileName: ent.name,
        linked,
        linkTarget,
        body,
        frontmatter,
        enabled: true, // presence in the workspace dir == enabled
      });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
  } catch {
    return [];
  }
}

// Enable a global skill in a workspace. Preferred transport: a symbolic link
// to the global file — single copy, global edits propagate instantly, and the
// dsh skill engine follows symlinks (nodeEntryKind: symlink → stat → file;
// followSymlinks defaults true). Windows only allows symlinks with Developer
// Mode / admin (SeCreateSymbolicLinkPrivilege); when that's missing the call
// degrades to a plain copy so enable still works. Copy loses auto-sync but is
// flagged by name in listWorkspaceSkills; a later toggle refreshes it.
async function linkGlobalSkillToWorkspace(cwd, skillName) {
  const entry = await findSkill(skillName);
  if (!entry) return { ok: false, error: `skill ${skillName} not found` };
  if (entry.origin === 'preset') return { ok: false, error: `preset skill ${skillName} is not workspace-manageable` };
  const dir = workspaceSkillDir(cwd);
  const targetName = `${entry.name}.md`;
  const targetPath = join(dir, targetName);
  await ensureWorkspaceSkillDir(cwd);
  const source = resolve(entry.filePath);
  // unlink any existing stale copy/symlink first (idempotent re-enable)
  try { await unlink(targetPath); } catch { /* ENOENT fine */ }
  let transport = 'copy';
  try {
    await symlink(source, targetPath, 'file');
    transport = 'symlink';
  } catch {
    try {
      await copyFile(source, targetPath);
      transport = 'copy';
    } catch (err) {
      return { ok: false, error: `enable failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true, name: entry.name, fileName: targetName, targetPath, transport };
}

// Disable a global skill in a workspace by removing its link.
async function unlinkGlobalSkillFromWorkspace(cwd, skillName) {
  const dir = workspaceSkillDir(cwd);
  const fileName = skillName.endsWith('.md') ? skillName : `${skillName}.md`;
  const linkPath = join(dir, fileName);
  try {
    await unlink(linkPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, name: skillName }; // already off
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, name: skillName };
}

// ---------- workspace registry + lifecycle (rename/delete) ----------

// Known-workspace registry: { registrations: { <absPath>: { registeredAt } } }
function workspacesFilePath() {
  return join(managerRoot(), 'workspaces.json');
}

async function readWorkspaceRegistry() {
  try {
    const raw = await readFile(workspacesFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.registrations
      ? parsed.registrations
      : {};
  } catch {
    return {};
  }
}

async function writeWorkspaceRegistry(reg) {
  await mkdir(managerRoot(), { recursive: true });
  await writeFile(workspacesFilePath(), JSON.stringify({ registrations: reg }, null, 2), 'utf8');
}

// Register (or refresh) a known workspace so the panel can list it across
// project switches. Does not change skill links.
async function registerWorkspace(cwd) {
  const abs = resolve(cwd);
  const reg = await readWorkspaceRegistry();
  reg[abs] = { registeredAt: Date.now() };
  await writeWorkspaceRegistry(reg);
  return { ok: true, cwd: abs, registeredAt: reg[abs].registeredAt };
}

// List known workspaces with their skill link counts and session counts.
async function listWorkspaces() {
  const reg = await readWorkspaceRegistry();
  const result = [];
  for (const [cwd, meta] of Object.entries(reg)) {
    let skills = [];
    let exists = true;
    try {
      await stat(cwd);
    } catch {
      exists = false;
    }
    if (exists) skills = await listWorkspaceSkills(cwd);
    result.push({
      cwd,
      registeredAt: typeof meta.registeredAt === 'number' ? meta.registeredAt : 0,
      exists,
      enabled: skills.map((s) => s.name),
      enabledCount: skills.length,
    });
  }
  result.sort((a, b) => a.cwd.localeCompare(b.cwd));
  return result;
}

// Rename a registered workspace: update the registry key and migrate every
// session config whose cwd pointed at the old path. `.dsh/skills` links move
// with the directory itself, so only bookkeeping changes here.
async function renameWorkspace(oldCwd, newCwd) {
  const oldAbs = resolve(oldCwd);
  const newAbs = resolve(newCwd);
  const reg = await readWorkspaceRegistry();
  if (!(oldAbs in reg)) return { ok: false, error: `workspace ${oldAbs} not registered` };
  if (oldAbs === newAbs) return { ok: true, cwd: newAbs };
  const meta = reg[oldAbs];
  delete reg[oldAbs];
  reg[newAbs] = { ...meta, renamedAt: Date.now() };
  await writeWorkspaceRegistry(reg);
  // migrate session configs pointing at the old cwd
  const sessionsDir = join(managerRoot(), 'sessions');
  let migrated = 0;
  try {
    const files = await readdir(sessionsDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const p = join(sessionsDir, f);
      try {
        const cfg = JSON.parse(await readFile(p, 'utf8'));
        if (typeof cfg.cwd === 'string' && resolve(cfg.cwd) === oldAbs) {
          cfg.cwd = newAbs;
          await writeFile(p, JSON.stringify(cfg, null, 2), 'utf8');
          migrated++;
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* no sessions dir yet */ }
  return { ok: true, cwd: newAbs, migratedSessions: migrated };
}

// Forget a workspace: drop the registry entry and any session configs whose
// cwd points there. SKILL LINKS LIVE INSIDE THE WORKSPACE DIRECTORY — this
// function never touches the workspace itself; the user's rename/delete of
// the folder (dsh-native behavior) already moved or removed the links.
async function forgetWorkspace(cwd) {
  const abs = resolve(cwd);
  const reg = await readWorkspaceRegistry();
  const existed = abs in reg;
  delete reg[abs];
  await writeWorkspaceRegistry(reg);
  const sessionsDir = join(managerRoot(), 'sessions');
  let removedSessions = 0;
  try {
    const files = await readdir(sessionsDir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const p = join(sessionsDir, f);
      try {
        const cfg = JSON.parse(await readFile(p, 'utf8'));
        if (typeof cfg.cwd === 'string' && resolve(cfg.cwd) === abs) {
          await unlink(p);
          removedSessions++;
        }
      } catch { /* skip */ }
    }
  } catch { /* no sessions dir */ }
  return { ok: true, existed, removedSessions };
}

// ---------- session (L2) layer ----------

function sessionConfigPath(sessionId) {
  return join(managerRoot(), 'sessions', `${sessionId}.json`);
}

// Read one session's skill selection { cwd, explicit, enabled: [] }.
// explicit=false (or missing file) means "follow the workspace": the session
// enables every skill the workspace has on, automatically tracking changes.
async function readSessionConfig(sessionId) {
  const p = sessionConfigPath(sessionId);
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? {
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      explicit: parsed.explicit === true,
      enabled: Array.isArray(parsed.enabled) ? parsed.enabled.filter((n) => typeof n === 'string') : [],
    } : { cwd: '', explicit: false, enabled: [] };
  } catch {
    return { cwd: '', explicit: false, enabled: [] };
  }
}

async function writeSessionConfig(sessionId, cfg) {
  await mkdir(join(managerRoot(), 'sessions'), { recursive: true });
  await writeFile(sessionConfigPath(sessionId), JSON.stringify(cfg, null, 2), 'utf8');
}

// Set the session skill selection. `explicit=true` pins a user-chosen subset
// (validated against the workspace allowed set); `explicit=false` restores
// follow-workspace semantics (session = full workspace set).
async function setSessionSkills(sessionId, cwd, enabled, explicit = true) {
  const workspace = await listWorkspaceSkills(cwd);
  const allowed = new Set(workspace.map((s) => s.name));
  const clean = Array.isArray(enabled)
    ? enabled.filter((n) => allowed.has(n))
    : [];
  const cfg = {
    cwd,
    explicit: explicit === true,
    enabled: explicit === true ? [...new Set(clean)] : [],
  };
  await writeSessionConfig(sessionId, cfg);
  return { ok: true, cfg };
}

// Effective session view: global + preset (always visible), workspace
// enabled set, and the session selection layered on top (subset of workspace).
async function sessionSkillView(sessionId, cwd) {
  const [globals, presets, workspace] = await Promise.all([
    Promise.all([scanDir(skillsRoot()), scanDir(disabledRoot())]).then(([a, d]) => [...a, ...d]),
    scanPresetSkills(),
    cwd ? listWorkspaceSkills(cwd) : Promise.resolve([]),
  ]);
  const cfg = sessionId ? await readSessionConfig(sessionId) : { cwd, explicit: false, enabled: [] };
  const workspaceNames = new Set(workspace.map((w) => w.name));
  // explicit=false → follow workspace (every enabled workspace link is session-enabled)
  const sessionEffective = cfg.explicit ? new Set(cfg.enabled) : workspaceNames;
  // merge: globals (user layer), workspace links, presets
  const merged = [];
  const seen = new Set();
  const push = (e) => {
    if (seen.has(e.name)) return;
    seen.add(e.name);
    merged.push(e);
  };
  // global-user skills: enabled state reflects disabled dir
  for (const g of globals) push({ ...g, layer: 'global' });
  // workspace links override globals (same name) — mark them active
  for (const w of workspace) {
    const base = merged.find((m) => m.name === w.name);
    if (base && base.origin === 'user') {
      base.layer = 'workspace';
      base.enabled = true;
    } else if (!base) {
      push({ ...w, enabled: true, layer: 'workspace', origin: 'user', preset: undefined });
    }
  }
  for (const p of presets) push({ ...p, layer: 'preset' });
  return {
    ok: true,
    skills: merged.map((s) => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      fileName: s.fileName,
      enabled: s.enabled,
      origin: s.origin,
      layer: s.layer,
      preset: s.preset,
      sessionEnabled: sessionEffective.has(s.name),
    })),
    session: { id: sessionId, cwd: cfg.cwd, explicit: cfg.explicit, enabled: cfg.enabled },
    workspaceEnabled: [...workspaceNames],
  };
}

// ---------- module-level operations (shared by tools + HTTP API) ----------

// Look up one skill across the active and disabled roots.
async function findSkill(name) {
  const fileName = name.endsWith('.md') ? name : `${name}.md`;
  for (const dir of [skillsRoot(), disabledRoot()]) {
    try {
      const raw = await readFile(join(dir, fileName), 'utf8');
      return await readSkillEntry(dir, fileName);
    } catch { /* continue */ }
  }
  return undefined;
}

// Build a compact body snippet around the first match for `q`.
function snippetAround(body, q, radius = 40) {
  const idx = body.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + q.length + radius);
  return (start > 0 ? '…' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? '…' : '');
}

// Search every skill across layers (global user skills, presets, and all
// registered workspaces) by name / description / whenToUse / body content
// (case-insensitive substring). Returns deduped matches with per-layer
// provenance and a body snippet so the caller can locate the right skill.
// Priority on name collisions follows the view rule: workspace > global > preset.
async function searchSkills(query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return { ok: true, results: [] };
  const matches = [];
  const seen = new Set();
  const add = (e) => {
    // full text windows to match against (body only when available)
    const windows = [
      (e.name ?? '').toLowerCase(),
      (e.description ?? '').toLowerCase(),
      (e.whenToUse ?? '').toLowerCase(),
      (e.body ?? '').toLowerCase(),
    ];
    if (!windows.some((w) => w.includes(q))) return;
    const why = [];
    if ((e.name ?? '').toLowerCase().includes(q)) why.push('name');
    if ((e.description ?? '').toLowerCase().includes(q)) why.push('desc');
    if ((e.whenToUse ?? '').toLowerCase().includes(q)) why.push('whenToUse');
    if ((e.body ?? '').toLowerCase().includes(q)) why.push('body');
    const key = e.name;
    const existing = matches.find((m) => m.name === key);
    const rank = (l) => (l === 'workspace' ? 0 : l === 'global' ? 1 : 2);
    if (!existing || rank(e.layer) < rank(existing.layer)) {
      if (existing) matches.splice(matches.indexOf(existing), 1);
      matches.push({
        name: e.name,
        description: e.description ?? '',
        whenToUse: e.whenToUse ?? '',
        enabled: !!e.enabled,
        origin: e.origin ?? 'user',
        layer: e.layer,
        preset: e.preset,
        workspace: e.workspace,
        why,
        snippet: e.body ? snippetAround(e.body, q) : '',
      });
    }
    seen.add(key);
  };

  // global user skills (active + disabled)
  const [active, disabled] = await Promise.all([scanDir(skillsRoot()), scanDir(disabledRoot())]);
  for (const g of [...active, ...disabled]) add({ ...g, layer: 'global' });

  // presets
  for (const p of await scanPresetSkills()) add({ ...p, layer: 'preset' });

  // registered workspaces: search the workspace-enabled set per workspace
  for (const ws of await listWorkspaces()) {
    if (!ws.exists) continue;
    const list = await listWorkspaceSkills(ws.cwd);
    for (const w of list) add({ ...w, layer: 'workspace', workspace: ws.cwd, enabled: true });
  }

  matches.sort((a, b) => {
    if (a.layer === b.layer) return a.name.localeCompare(b.name);
    return (a.layer === 'workspace' ? -1 : a.layer === 'global' ? 0 : 1) - (b.layer === 'workspace' ? -1 : b.layer === 'global' ? 0 : 1);
  });
  return { ok: true, results: matches };
}

// Edit one skill file: merge frontmatter, replace body, optional rename.
async function editSkill(name, { frontmatter, body }) {
  const entry = await findSkill(name);
  if (!entry) return { ok: false, error: `skill ${name} not found` };
  const nextFm = frontmatter && typeof frontmatter === 'object' ? { ...entry.frontmatter, ...frontmatter } : entry.frontmatter;
  if (typeof nextFm.name === 'string' && nextFm.name !== entry.name) {
    // rename: write to the new file name, remove the old one
    const newName = `${nextFm.name}.md`;
    if (!validSkillFileName(newName)) return { ok: false, error: `invalid skill name ${nextFm.name}` };
    const nextBody = typeof body === 'string' ? body : entry.body;
    await writeFile(join(dirname(entry.filePath), newName), serializeSkillDoc(nextFm, nextBody), 'utf8');
    await unlink(entry.filePath);
    return { ok: true, name: nextFm.name, fileName: newName };
  }
  const nextBody = typeof body === 'string' ? body : entry.body;
  await writeFile(entry.filePath, serializeSkillDoc(nextFm, nextBody), 'utf8');
  return { ok: true, name: entry.name, fileName: entry.fileName };
}

// Enable/disable a skill by moving it between the active and disabled roots.
async function setSkillEnabled(name, enable) {
  const fileName = name.endsWith('.md') ? name : `${name}.md`;
  const from = enable ? disabledRoot() : skillsRoot();
  const to = enable ? skillsRoot() : disabledRoot();
  try {
    await mkdir(to, { recursive: true });
    await rename(join(from, fileName), join(to, fileName));
    return { ok: true, name, enabled: enable };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Permanently delete a skill file (active or disabled).
async function deleteSkill(name) {
  const entry = await findSkill(name);
  if (!entry) return { ok: false, error: `skill ${name} not found` };
  await unlink(entry.filePath);
  return { ok: true, name };
}

// Import a skill from a zip buffer: must contain a root SKILL.md whose
// frontmatter declares a kebab-case `name`. Extracts into the active root.
async function importSkillZipFromBuffer(buf) {
  if (buf.length === 0) return { ok: false, error: 'empty upload' };
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const mdEntry = entries.find((e) => {
    const n = e.entryName.replace(/\\/g, '/').replace(/^\.\//, '');
    return !e.isDirectory && n.endsWith('.md') && basename(n) === 'SKILL.md';
  });
  if (!mdEntry) return { ok: false, error: 'zip must contain a SKILL.md file' };
  const raw = mdEntry.getData().toString('utf8');
  const { frontmatter } = parseSkillDoc(raw);
  const skillName = typeof frontmatter.name === 'string' ? frontmatter.name : '';
  if (!skillName || !validSkillFileName(`${skillName}.md`)) {
    return { ok: false, error: 'SKILL.md must declare a kebab-case `name` in its frontmatter' };
  }
  await mkdir(skillsRoot(), { recursive: true });
  const target = join(skillsRoot(), `${skillName}.md`);
  await writeFile(target, raw, 'utf8');
  return { ok: true, name: skillName, fileName: `${skillName}.md` };
}

// Import many SKILL.md documents at once (folder batch upload). Each item is
// `{ source, content }` where source is a human label (e.g. the relative path
// inside the picked folder). Per-item validation: must parse, declare a
// kebab-case `name`, a non-empty `description`, and a non-empty body — the
// definition of "actually a skill". Partial failure does not abort the rest.
async function importSkillDocs(items) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'no skill files received' };
  const results = [];
  for (const item of items.slice(0, 200)) {
    const source = typeof item?.source === 'string' && item.source ? item.source : `skill #${results.length + 1}`;
    const raw = typeof item?.content === 'string' ? item.content : '';
    if (!raw.trim()) {
      results.push({ source, ok: false, error: '文件为空' });
      continue;
    }
    const { frontmatter } = parseSkillDoc(raw);
    const skillName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
    if (!skillName || !validSkillFileName(`${skillName}.md`)) {
      results.push({ source, ok: false, error: 'frontmatter 缺少 kebab-case 的 name（如 skill-name）' });
      continue;
    }
    if (!/[\s\S]/.test(raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim())) {
      results.push({ source, ok: false, error: '正文为空，不是有效技能' });
      continue;
    }
    const noDesc = typeof frontmatter.description !== 'string' || !frontmatter.description.trim();
    if (noDesc) {
      results.push({ source, ok: false, error: 'frontmatter 缺少非空 description' });
      continue;
    }
    try {
      await mkdir(skillsRoot(), { recursive: true });
      await writeFile(join(skillsRoot(), `${skillName}.md`), raw, 'utf8');
      results.push({ source, ok: true, name: skillName, fileName: `${skillName}.md` });
    } catch (err) {
      results.push({ source, ok: false, error: `写入失败: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { ok: true, results };
}

export function apply(ctx) {
  const routePath = '/skill-manager/api';

  // The agent-presets service owns the authoritative preset roots; use them
  // for the read-only preset catalog instead of guessing from module paths
  // (this bundle is junction-installed, so relative resolution breaks).
  try {
    const roots = ctx.agentPresets?.resolvedRoots?.map((r) => r.path).filter((p) => typeof p === 'string' && p);
    if (roots && roots.length) presetRootsOverride = roots;
  } catch { /* service unavailable → fallback scanning */ }

  // Normalize a bare `parameters` property map ({ key: spec, ... }) into a
  // standard JSON Schema object ({ type:'object', properties, required }) the
  // way dsh's defineTool() would — the model projection rejects bare maps
  // ("schema must be a JSON Schema of type object, got type: null"). We can't
  // import defineTool from this bundle, so we inline the equivalent shape.
  function normalizeParameters(params) {
    if (!params || typeof params !== 'object') return { type: 'object', properties: {} };
    const properties = {};
    const required = [];
    for (const [key, spec] of Object.entries(params)) {
      if (!spec || typeof spec !== 'object') continue;
      const { required: isRequired, ...rest } = spec;
      properties[key] = rest;
      if (isRequired) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    };
  }

  function registerTool(definition) {
    registerTool({
      ...definition,
      parameters: normalizeParameters(definition.parameters),
    });
  }

  // Resolve a working directory for a skill view when the caller supplies
  // neither cwd nor sessionId: fall back to the most recently touched live
  // session's cwd (the session store is keyed by creation time). This lets
  // the settings panel show the current workspace without manual input.
  function resolveSessionCwd(sessionId, fallbackCwd) {
    if (fallbackCwd) return fallbackCwd;
    try {
      const sessions = ctx.sessions?.list?.();
      if (sessionId) {
        const session = ctx.sessions?.get?.(sessionId) ?? sessions?.find((s) => s.id === sessionId);
        const cwd = session?.header?.cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      }
      if (Array.isArray(sessions) && sessions.length > 0) {
        const latest = sessions
          .filter((s) => typeof s.header?.cwd === 'string' && s.header.cwd)
          .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))[0];
        if (latest) return latest.header.cwd;
      }
    } catch { /* session store unavailable */ }
    return '';
  }

  // ---------- JSON helper ----------
  function sendJson(res, status, body) {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    } catch {
      /* client gone */
    }
  }

  async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  }

  // ---------- HTTP API (for the client settings panel) ----------
  const unregisterRoute = ctx.webServer.register({
    kind: 'prefix',
    path: routePath,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        // GET /list — all skills with enabled state + stats
        if (url.pathname === `${routePath}/list` && req.method === 'GET') {
          const [active, disabled, preset, workspaces] = await Promise.all([
            scanDir(skillsRoot()),
            scanDir(disabledRoot()),
            scanPresetSkills(),
            listWorkspaces(),
          ]);
          const skills = [...active, ...disabled].map(summarize);
          sendJson(res, 200, {
            ok: true,
            skills,
            stats: {
              total: skills.length + preset.length,
              globalEnabled: active.length,
              globalDisabled: disabled.length,
              preset: preset.length,
              workspaceCount: workspaces.filter((w) => w.exists).length,
              currentCwd: workspaces[0]?.cwd ?? '',
            },
          });
          return;
        }
        // GET /get?name= — full content
        if (url.pathname === `${routePath}/get` && req.method === 'GET') {
          const name = url.searchParams.get('name') ?? '';
          const entry = await findSkill(name);
          if (!entry) { sendJson(res, 404, { ok: false, error: `skill ${name} not found` }); return; }
          sendJson(res, 200, { ok: true, skill: entry });
          return;
        }
        // POST /edit — { name, frontmatter?, body? }
        if (url.pathname === `${routePath}/edit` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await editSkill(body.name, body);
          sendJson(res, 200, result);
          return;
        }
        // POST /enable | /disable — { name }
        if ((url.pathname === `${routePath}/enable` || url.pathname === `${routePath}/disable`) && req.method === 'POST') {
          const body = await readJsonBody(req);
          const enable = url.pathname.endsWith('/enable');
          const result = await setSkillEnabled(body.name, enable);
          sendJson(res, 200, result);
          return;
        }
        // POST /delete — { name }
        if (url.pathname === `${routePath}/delete` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await deleteSkill(body.name);
          sendJson(res, 200, result);
          return;
        }
        // POST /import — raw zip body upload
        if (url.pathname === `${routePath}/import` && req.method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const result = await importSkillZipFromBuffer(Buffer.concat(chunks));
          sendJson(res, 200, result);
          return;
        }
        // POST /import/batch — { items: [{ source, content }] } validate + write each
        if (url.pathname === `${routePath}/import/batch` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await importSkillDocs(body?.items);
          sendJson(res, 200, result);
          return;
        }
        // GET /search?q= — cross-layer skill search (name/desc/whenToUse/body)
        if (url.pathname === `${routePath}/search` && req.method === 'GET') {
          const q = url.searchParams.get('q') ?? '';
          sendJson(res, 200, await searchSkills(q));
          return;
        }
        // GET /view?cwd=&sessionId= — full layered view (global/workspace/preset/session)
        // Any resolved cwd is auto-registered so the panel's picker keeps
        // growing with the workspaces actually used — no manual "register".
        // The response also carries the full workspaces list so the picker
        // reflects the just-registered cwd without a second round-trip.
        if (url.pathname === `${routePath}/view` && req.method === 'GET') {
          const cwd = resolveSessionCwd(url.searchParams.get('sessionId') ?? '', url.searchParams.get('cwd') ?? '');
          const sessionId = url.searchParams.get('sessionId') ?? '';
          let workspaces = [];
          if (cwd) {
            try { await registerWorkspace(cwd); } catch { /* non-fatal */ }
          }
          try { workspaces = await listWorkspaces(); } catch { /* non-fatal */ }
          sendJson(res, 200, { ok: true, workspaces, ...await sessionSkillView(sessionId, cwd) });
          return;
        }
        // POST /workspace/toggle — { cwd, name, enable }
        if (url.pathname === `${routePath}/workspace/toggle` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const cwd = String(body.cwd ?? '');
          const name = String(body.name ?? '');
          const result = body.enable
            ? await linkGlobalSkillToWorkspace(cwd, name)
            : await unlinkGlobalSkillFromWorkspace(cwd, name);
          sendJson(res, 200, { ok: result.ok, ...(result.error ? { error: result.error } : { name: result.name }) });
          return;
        }
        // GET /workspaces — known workspaces with existence + enabled skills
        if (url.pathname === `${routePath}/workspaces` && req.method === 'GET') {
          sendJson(res, 200, { ok: true, workspaces: await listWorkspaces() });
          return;
        }
        // POST /workspace/register — { cwd } remember a workspace for the panel
        if (url.pathname === `${routePath}/workspace/register` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await registerWorkspace(String(body.cwd ?? ''));
          sendJson(res, 200, result);
          return;
        }
        // POST /workspace/rebind — { oldCwd, newCwd } after a folder rename:
        // migrate the registry key and any session configs pointing at oldCwd.
        if (url.pathname === `${routePath}/workspace/rebind` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await renameWorkspace(String(body.oldCwd ?? ''), String(body.newCwd ?? ''));
          sendJson(res, 200, result);
          return;
        }
        // POST /workspace/forget — { cwd } forget registry entry + orphan
        // session configs. Never touches the workspace directory itself.
        if (url.pathname === `${routePath}/workspace/forget` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await forgetWorkspace(String(body.cwd ?? ''));
          sendJson(res, 200, result);
          return;
        }
        // POST /session/set — { sessionId, cwd?, enabled?: [], explicit?: bool }
        if (url.pathname === `${routePath}/session/set` && req.method === 'POST') {
          const body = await readJsonBody(req);
          const sessionId = String(body.sessionId ?? '');
          if (!sessionId) { sendJson(res, 400, { ok: false, error: 'sessionId required' }); return; }
          const cwd = resolveSessionCwd(sessionId, String(body.cwd ?? ''));
          const result = await setSessionSkills(sessionId, cwd, body.enabled, body.explicit === true);
          sendJson(res, 200, result);
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
  ctx.on('dispose', () => {
    try { unregisterRoute(); } catch { /* already gone */ }
  });

  // ---------- model-facing tools ----------
  registerTool({
    name: 'skill_manager_list',
    description: '列出用户技能目录中全部技能（含已禁用的），返回名称、描述、启用状态与文件长度。管理技能生命周期时先用它探测。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: formatList(value) }],
    },
    isConcurrencySafe: () => true,
    execute: async () => {
      const [active, disabled, preset] = await Promise.all([scanDir(skillsRoot()), scanDir(disabledRoot()), scanPresetSkills()]);
      const skills = [...active, ...disabled].map(summarize).concat(preset.map(summarize))
        .sort((a, b) => (a.origin === b.origin ? a.name.localeCompare(b.name) : a.origin === 'user' ? -1 : 1));
      const byOrigin = (o) => skills.filter((s) => s.origin === o).length;
      return {
        skills,
        stats: {
          user: `启用 ${byOrigin('user') && active.length}`, // active contains only user entries
          userEnabled: active.length,
          userDisabled: disabled.length,
          preset: preset.length,
        },
        note: `用户层：启用 ${active.length} 个，禁用 ${disabled.length} 个；preset 捆绑：${preset.length} 个。用户目录 ${skillsRoot()}，preset 目录 ${shippedPresetRoot()} / ${userPresetRoot()}`,
      };
    },
  });

  registerTool({
    name: 'skill_manager_get',
    description: '读取指定技能的完整内容（frontmatter + 正文 markdown），用于查看或准备修改。',
    parameters: {
      name: { type: 'string', required: true, description: '技能名（kebab-case，可不带 .md 后缀）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: value.error ?? 'error' }];
        return [{ type: 'text', text: `# ${value.skill.name}\n\n${value.skill.body}` }];
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const entry = await findSkill(String(args.name ?? ''));
      if (!entry) return { ok: false, error: `skill ${args.name} not found` };
      return { ok: true, skill: { name: entry.name, description: entry.description, whenToUse: entry.whenToUse, enabled: entry.enabled, fileName: entry.fileName, frontmatter: entry.frontmatter, body: entry.body } };
    },
  });

  registerTool({
    name: 'skill_manager_edit',
    description: '修改磁盘上的技能文件：可更新 frontmatter（name/description/whenToUse 等）与正文 body。修改直接写回 skills 目录中的 .md 文件。',
    parameters: {
      name: { type: 'string', required: true, description: '要修改的技能名（kebab-case）' },
      frontmatter: { type: 'object', description: '要合并写入 frontmatter 的字段（可含 name/description/whenToUse 或自定义字段）' },
      body: { type: 'string', description: '新的 markdown 正文（不含 frontmatter）。省略则保留原正文' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `已修改技能 ${value.name} → ${value.fileName}` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => editSkill(String(args.name ?? ''), args),
  });

  registerTool({
    name: 'skill_manager_enable',
    description: '启用一个已禁用的技能：把文件从 skills-disabled 移回 skills 目录。',
    parameters: {
      name: { type: 'string', required: true, description: '技能名（kebab-case）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `✅ 已启用技能 ${value.name}` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => setSkillEnabled(String(args.name ?? ''), true),
  });

  registerTool({
    name: 'skill_manager_disable',
    description: '禁用指定技能：把文件从 skills 目录移出到 skills-disabled（不删除），filesystem provider 将不再发现它。',
    parameters: {
      name: { type: 'string', required: true, description: '技能名（kebab-case）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `⏸ 已禁用技能 ${value.name}（移入 skills-disabled）` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => setSkillEnabled(String(args.name ?? ''), false),
  });

  registerTool({
    name: 'skill_manager_delete',
    description: '从磁盘永久删除一个技能文件（含已禁用的）。删除前请先 skill_manager_get 确认内容。',
    parameters: {
      name: { type: 'string', required: true, description: '技能名（kebab-case）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `🗑 已删除技能 ${value.name}` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => deleteSkill(String(args.name ?? '')),
  });

  registerTool({
    name: 'skill_manager_import',
    description: '从本地 zip 文件导入技能包：zip 根目录须包含 SKILL.md（frontmatter 声明 kebab-case name），导入到 skills 目录并自动启用。',
    parameters: {
      path: { type: 'string', required: true, description: 'zip 文件的绝对路径' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `📦 已导入技能 ${value.name} → ${value.fileName}` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const p = resolve(String(args.path ?? ''));
      try {
        const st = await stat(p);
        if (!st.isFile()) return { ok: false, error: `${p} 不是文件` };
        const buf = await readFile(p);
        return await importSkillZipFromBuffer(buf);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registerTool({
    name: 'skill_manager_workspace_list',
    description: '列出指定工作区（cwd）已启用的技能：返回 .dsh/skills 下的 link（指向全局，单副本）与本地产文件。用于查看某项目当前开放了哪些技能。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径（如会话的工作目录）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: formatWorkspaceList(value) }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const cwd = String(args.cwd ?? '');
      const skills = await listWorkspaceSkills(cwd);
      return { ok: true, cwd, skills, count: skills.length };
    },
  });

  registerTool({
    name: 'skill_manager_workspace_toggle',
    description: '在工作区（cwd）启用或停用一个全局技能：启用=在 <cwd>/.dsh/skills 建指向全局源的 link（单副本，全局演进自动同步）；停用=删除该 link。项目无 link 默认不启用任何全局技能（preset 技能除外）。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      name: { type: 'string', required: true, description: '技能名（kebab-case）' },
      enable: { type: 'boolean', required: true, description: 'true=启用建 link，false=停用删 link' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `${value.enable ? '🟢 已在工作区启用' : '⚪ 已在工作区停用'} ${value.name}` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const cwd = String(args.cwd ?? '');
      const name = String(args.name ?? '');
      const enable = args.enable === true;
      const result = enable
        ? await linkGlobalSkillToWorkspace(cwd, name)
        : await unlinkGlobalSkillFromWorkspace(cwd, name);
      return { ok: result.ok, ...(result.error ? { error: result.error } : { name: result.name, enable }) };
    },
  });

  registerTool({
    name: 'skill_manager_session_view',
    description: '查看一个会话（sessionId）在指定工作区（cwd）的技能视图：全局层（用户技能）、工作区启用集（link）、preset 捆绑层、以及会话勾选子集（sessionEnabled）。会话可选范围受限于工作区启用集。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
      sessionId: { type: 'string', description: '会话 id（省略则只看工作区层面）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: formatSessionView(value) }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => true,
    execute: async (args) => sessionSkillView(String(args.sessionId ?? ''), String(args.cwd ?? '')),
  });

  registerTool({
    name: 'skill_manager_session_set',
    description: '设置一个会话在指定工作区的技能勾选子集。传 explicit=true 会固定用户自选子集（enabled ⊆ 工作区启用集，交集校验）；传 explicit=false 恢复「跟随工作区」——会话技能 = 工作区全部启用技能，工作区增删自动同步。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '会话 id' },
      cwd: { type: 'string', required: true, description: '工作区绝对路径（可省略，host 从会话自动解析）' },
      enabled: { type: 'array', items: { type: 'string' }, description: '会话勾选的技能名数组（explicit=true 时 ⊆ 工作区启用集）' },
      explicit: { type: 'boolean', description: 'true=固定自选；false=跟随工作区全开' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: value.cfg.explicit ? `会话技能已固定：${value.cfg.enabled.join(', ') || '（空）'}` : '会话技能已恢复：跟随工作区（全开）' }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => setSessionSkills(String(args.sessionId ?? ''), String(args.cwd ?? ''), args.enabled, args.explicit === true),
  });

  registerTool({
    name: 'skill_manager_workspace_list_all',
    description: '列出已登记的工作区（workspaces.json 注册表）及各自启用的技能与存在状态。配合 dsh 原生工作区重命名/删除：目录改名后 link 自动跟随（.dsh/skills 在目录内），删除后 link 随目录消失，本工具标记 exists:false 供你判断是否 rebind/forget。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: formatWorkspaceRegistry(value.workspaces) }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => true,
    execute: async () => ({ ok: true, workspaces: await listWorkspaces() }),
  });

  registerTool({
    name: 'skill_manager_workspace_register',
    description: '把工作区登记进插件注册表（供管理面板跨项目回切时列出；不影响技能链接）。dsh 原生会维护自己的工作区列表，本注册表只是为了让技能配置可查。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `已登记工作区 ${value.cwd}` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => registerWorkspace(String(args.cwd ?? '')),
  });

  registerTool({
    name: 'skill_manager_workspace_rebind',
    description: '工作区目录改名后（dsh 原生层面或文件系统层面），把注册表记录与关联会话配置从旧路径迁移到新路径。链接本身不需要动（在目录内自动跟随）。',
    parameters: {
      oldCwd: { type: 'string', required: true, description: '旧路径' },
      newCwd: { type: 'string', required: true, description: '新路径' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `工作区 ${value.cwd} 已重新绑定` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => renameWorkspace(String(args.oldCwd ?? ''), String(args.newCwd ?? '')),
  });

  registerTool({
    name: 'skill_manager_workspace_forget',
    description: '忘记一个工作区：从注册表移除并清理其关联的孤儿会话配置。绝不删除工作区目录或其中的技能链接（那是 dsh 原生删除操作与用户自己的职责）。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `已忘记工作区（曾清理 ${value.removedSessions} 个孤儿会话配置）` }]
        : [{ type: 'text', text: value.error ?? 'error' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args) => forgetWorkspace(String(args.cwd ?? '')),
  });

  return {};
}

function formatList(value) {
  if (!value?.skills?.length) return '技能目录为空。';
  const lines = value.skills.map((s) => {
    const flag = s.enabled ? '✅' : '⏸';
    return `${flag} ${s.name} — ${s.description || '(无描述)'}${s.whenToUse ? `（${s.whenToUse}）` : ''}`;
  });
  return lines.join('\n') + `\n\n${value.note ?? ''}`;
}

function formatWorkspaceList(value) {
  if (!value.ok) return value.error ?? 'error';
  if (!value.skills?.length) return `工作区 ${value.cwd} 未启用任何技能（.dsh/skills 为空，默认全关）。`;
  const lines = value.skills.map((s) => {
    const src = s.linked ? `🔗 全局link → ${s.linkTarget}` : '📄 本地产';
    return `  ${s.name} (${src})`;
  });
  return `工作区 ${value.cwd} 已启用 ${value.count} 个技能：\n` + lines.join('\n');
}

function formatWorkspaceRegistry(workspaces) {
  if (!workspaces?.length) return '尚未登记任何工作区。';
  return workspaces.map((w) => {
    const state = w.exists ? `✅ 存在（启用 ${w.enabledCount} 个：${w.enabled.join(', ') || '无'}）` : '⚠️ 路径不存在（目录可能已改名/删除 → rebind 或 forget）';
    return `  ${w.cwd} — ${state}`;
  }).join('\n');
}

function formatSessionView(value) {
  if (!value.ok) return value.error ?? 'error';
  const lines = value.skills.map((s) => {
    const layerTag = { global: '🌐', workspace: '📁', preset: '📦' }[s.layer] ?? '❔';
    const se = s.sessionEnabled ? '✓会话' : '';
    const on = s.enabled ? '启用' : '停用';
    return `  ${layerTag} ${s.name} [${on}]${s.preset ? ` @${s.preset.label}` : ''} ${se}`;
  });
  const mode = value.session.explicit ? `固定自选（${value.session.enabled.join(', ') || '空'}）` : '跟随工作区（全开）';
  return `会话 ${value.session.id ?? '(无)'} 技能视图（cwd=${value.session.cwd || '(未指定)'}，模式：${mode}）：\n`
    + (lines.join('\n') || '  （无技能）')
    + `\n工作区已启用：${value.workspaceEnabled.join(', ') || '（无）'}`;
}

export { inject, skillsRoot, disabledRoot, parseSkillDoc, serializeSkillDoc, validSkillFileName, scanDir, readSkillEntry, summarize, findSkill, searchSkills, editSkill, setSkillEnabled, deleteSkill, importSkillZipFromBuffer, importSkillDocs, formatList, formatWorkspaceList, formatWorkspaceRegistry, formatSessionView, listWorkspaceSkills, linkGlobalSkillToWorkspace, unlinkGlobalSkillFromWorkspace, sessionSkillView, setSessionSkills, readSessionConfig, listWorkspaces, registerWorkspace, renameWorkspace, forgetWorkspace };
