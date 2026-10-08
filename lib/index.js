// dsh-skill-manager — Skill lifecycle manager (host half)
// Views the full skill spectrum: user-layer skills (~/.dsh/skills) are fully
// manageable (list / view / edit / import(zip) / delete / enable / disable);
// preset-bound skills (shipped + user agent-presets) are read-only catalog
// entries labelled with their owning mode — the preset owns their lifecycle.
import { readdir, readFile, writeFile, mkdir, rename, unlink, copyFile, cp, stat, lstat, readlink, symlink, link, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import AdmZip from 'adm-zip';

export const name = '@yanglaofish/dsh-skill-manager';
// Only the two services this plugin truly cannot work without. Everything else
// is read through `ctx.get()` at call time, so the plugin still applies where a
// service is absent:
//
//  * `webServer` — dsh 0.2 mounts dsh-host-webserver AFTER plugin rows apply, so
//    a required-service entry would hold the plugin pending until then, and in a
//    composition that never grows a web server (headless / TUI) it would stay
//    pending forever, silently — even though the tools are perfectly usable
//    there. The panel API is attached lazily through ctx.inject(['webServer']).
//  * `agentPresets` / `skills` — only mounted by the bundles that own them
//    (the preset registry ships with the web-app bundle). The code already
//    treats both as optional (`?.`, try/catch, graceful fallback), so making
//    them hard dependencies would contradict that and take the whole plugin
//    down on a composition that simply has no preset registry.
const inject = ['tools', 'sessions'];

// Plugin version surfaced to the settings panel. Read from the bundle's own
// package.json at load time; falls back to 'dev' when running unpackaged.
const PKG_VERSION = (() => {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(p, 'utf8')).version ?? 'dev';
  } catch {
    return 'dev';
  }
})();

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

// Skill LIBRARY root: the single pool of all user skills. NOT scanned by the
// dsh engine (it lives under ~/.dsh/skill-manager/, not ~/.dsh/skills), so a
// skill is only visible to an agent when a workspace links/copies it into
// <cwd>/.dsh/skills — the workspace is the whitelist. This root replaces the
// old ~/.dsh/skills "global enabled" concept: the library only stores skills,
// enablement is decided per workspace.
function skillsRoot() {
  return join(managerRoot(), 'library');
}
// Legacy holding area for the old global disable concept; kept for migration.
// No longer written by the plugin; removed skills are deleted outright.
function disabledRoot() {
  return join(dshHome(), 'skills-disabled');
}

// Preset label fallback: preset id -> { label, order }.
//
// dsh 0.1 kept presets on disk under `<root>/<id>/` with a `preset.yml`; the
// shipped ids were standard / code / minimal / cordis. dsh 0.2 declares presets
// as `@deepseek-ai/dsh-agent-preset` loader rows and the shipped roster is
// standard / ptc / minimal / cordis. The live names and order now come from the
// `agentPresets` service, so this map is only a fallback for a preset whose
// service row carries neither `name` nor `order`.
const PRESET_LABELS = new Map([
  ['standard', { label: '标准模式', order: 1 }],
  ['ptc', { label: 'PTC 模式', order: 2 }],
  ['code', { label: 'PTC 模式', order: 2 }],
  ['minimal', { label: '极简模式', order: 3 }],
  ['cordis', { label: '创造模式', order: 4 }],
]);

// ---- preset catalog source --------------------------------------------------
//
// The preset layer answers "what does the engine itself add on top of my user
// skills, and which preset adds it". Where that comes from changed with the
// runtime generation:
//
//   dsh 0.1 — presets were directories; the `agent-presets` service exposed
//             `resolvedRoots` and the plugin scanned
//             `<root>/<id>/skills/<name>/SKILL.md`. That is the fallback below.
//
//   dsh 0.2 — @deepseek-ai/dsh-agent-preset-registry "does not scan directories
//             and does not accept preset paths"; `resolvedRoots` no longer
//             exists anywhere in the runtime. A preset is a loader row whose
//             `plugins` mount their own providers into that preset's own scope,
//             and the supported read is
//             `agentPresets.acquireScope(id)` + `skills.list({ scope })`.
//
// `apply()` installs a provider for the 0.2 shape; `presetCatalogProvider` stays
// null for 0.1 runtimes and for unit tests that never call apply().
let presetCatalogProvider = null;
// dsh 0.1 only: the authoritative preset roots from the old service.
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

// ---- identifier / path hygiene guards -------------------------------------
// Every user-supplied string that ends up inside join()/resolve() must pass
// these before touching the filesystem. The canonical skill files are always
// located afterwards by scanning real directories (scanDir), never by
// interpolating the raw name into a path.

// Skill names, session ids, file relPaths segments: a safe character set that
// structurally excludes path traversal (".", "..", "/", "\", ":" etc).
function isValidIdentifier(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) && !v.includes('..');
}

// Uniform way to surface an fs/parse error as a one-line string.
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

// ---- browser-trust fence (mirrors dsh's /api fence) ------------------------
// dsh's own RPC channels run every request through isTrustedApiRequest
// (dsh-client-connection): Host must be loopback (DNS rebinding cannot forge
// Host), sec-fetch-site=cross-site is refused (browser CSRF marker), and an
// attached Origin must be same-host. Our panel API is registered directly on
// ctx.webServer (not through connection.rpc), so we replicate that fence here
// to give /skill-manager/api the same confused-deputy defense as /api.
// Purely header-based: no dependencies on connection/trustedHosts, matching
// the loopback verdict of the official fence.

// Normalized URL of a Host-header authority (hostname lowercased), or undefined.
function parseHostHeader(host) {
  if (typeof host !== 'string' || !host) return undefined;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch { return undefined; }
}

// localhost | [::1] | any IPv4 in 127/8 — the loopback authority set.
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// Decides whether one request may reach the panel API. Returns true when the
// Host is loopback and any attached browser markers are same-origin.
function isTrustedPanelRequest(headers) {
  const host = typeof headers?.get === 'function' ? headers.get('host') : headers?.host;
  const hostname = parseHostHeader(host);
  if (!hostname || !isLoopbackHostname(hostname)) return false;
  if (headers?.get && headers.get('sec-fetch-site') === 'cross-site') return false;
  if (!headers?.get && headers?.['sec-fetch-site'] === 'cross-site') return false;
  const originRaw = typeof headers?.get === 'function' ? headers.get('origin') : headers?.origin;
  if (originRaw === undefined || originRaw === null || originRaw === '') return true;
  try {
    return new URL(originRaw).hostname.toLowerCase() === hostname;
  } catch { return false; }
}

// HTTP-layer wrapper used by the route handler: writes 403 and returns false
// when the request fails the fence.
function denyIfUntrusted(req, res) {
  const ok = isTrustedPanelRequest(req.headers);
  if (!ok) {
    try {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
    } catch { /* client gone */ }
    return true; // request denied (already answered)
  }
  return false;
}

// Platform-neutral absolute-path check: node's isAbsolute() handles Windows
// drive paths (C:\… and C:/…), POSIX roots (/home/…) and UNC — unlike a
// drive-letter regex or a resolve() === v comparison (resolve() normalizes
// the separator, so an absolute path written with / would look "relative").
function isAbsolutePath(v) {
  return typeof v === 'string' && isAbsolute(v);
}

// Path equality that tolerates Windows case-insensitivity (C:\Foo == c:\foo).
function samePath(a, b) {
  const pa = resolve(a);
  const pb = resolve(b);
  return process.platform === 'win32'
    ? pa.toLowerCase() === pb.toLowerCase()
    : pa === pb;
}

// Canonical skill identifier: strip a trailing `.md` if a caller passed one.
function bareSkillName(name) {
  return typeof name === 'string' && name.endsWith('.md') ? name.slice(0, -3) : name;
}

// Write-side cwd gate: only registered workspaces may be targeted by toggle /
// file-write operations, so a crafted HTTP call cannot rm/write arbitrary
// <path>/.dsh/skills trees elsewhere on disk.
async function assertRegisteredWorkspace(cwd) {
  if (!isAbsolutePath(cwd)) return { ok: false, error: 'invalid cwd: 绝对路径是必需的（Windows: C:\\…；Linux/macOS: /…）' };
  const resolved = resolve(cwd);
  const ws = await listWorkspaces();
  const known = ws.some((w) => w.exists && samePath(w.cwd, resolved));
  return known
    ? { ok: true, cwd: resolved }
    : { ok: false, error: `workspace not registered: ${resolved}` };
}

// Parse raw skill content + assemble a uniform entry object. Directory form
// is canonical (folder + SKILL.md); `form: 'file'` is kept only defensively
// for the never-triggering legacy path.
function assembleSkillEntry(raw, { filePath, form, dir, rootDir, fallbackName }) {
  const { frontmatter, body } = parseSkillDoc(raw);
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : fallbackName;
  return {
    name,
    description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
    whenToUse: typeof frontmatter.whenToUse === 'string' ? frontmatter.whenToUse : '',
    fileName: form === 'dir' ? `${fallbackName}/SKILL.md` : basename(filePath),
    filePath,
    enabled: rootDir === skillsRoot(),
    body,
    frontmatter,
    origin: 'user',
    form,
    ...(form === 'dir' && dir ? { dir } : {}),
  };
}

// Directory-form skill: <rootDir>/<dirName>/SKILL.md (mirrors the engine's
// discoverRoot which supports both layouts).
async function readSkillDirEntry(rootDir, dirName) {
  const skillDir = join(rootDir, dirName);
  const filePath = join(skillDir, 'SKILL.md');
  const raw = await readFile(filePath, 'utf8');
  return assembleSkillEntry(raw, { filePath, form: 'dir', dir: skillDir, rootDir, fallbackName: dirName });
}

async function scanDir(dir) {
  try {
    const names = await readdir(dir, { withFileTypes: true });
    const entries = [];
    for (const ent of names) {
      if (ent.name.startsWith('.')) continue; // skip hidden (.system, .git, etc.)
      if (!ent.isDirectory()) continue; // directory form is the only canonical layout
      // directory-form skill: <dir>/<name>/SKILL.md (mirrors the engine's
      // discoverRoot); single-file skills were removed with the migration.
      try {
        const skillMd = join(dir, ent.name, 'SKILL.md');
        await stat(skillMd); // exists?
        entries.push(await readSkillDirEntry(dir, ent.name));
      } catch {
        // not a skill directory (no SKILL.md) — skip
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

// One skill may be reachable through several preset scopes or roots; the panel
// keys preset rows by `<presetId>/<name>`, so collapse those duplicates.
function dedupePresetEntries(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const key = `${e.preset?.id ?? ''}/${e.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Preset display metadata: the live service row wins, the id table is only a
// fallback for a row that carries neither a name nor an order.
function presetMetaFromRow(row) {
  const id = typeof row?.id === 'string' ? row.id : '';
  const fallback = PRESET_LABELS.get(id) ?? { label: id, order: 99 };
  const meta = {
    id,
    label: typeof row?.name === 'string' && row.name ? row.name : fallback.label,
    order: typeof row?.order === 'number' ? row.order : fallback.order,
  };
  if (typeof row?.description === 'string' && row.description) meta.description = row.description;
  return meta;
}

// Turn a `ctx.skills` summary into a preset catalog entry. The instruction file
// is re-read from the path the summary reports, so the panel keeps showing real
// frontmatter and body length; a summary with no readable local path stays
// summary-only (listed, with no body to preview).
async function presetEntryFromSummary(skill, preset) {
  const entry = {
    name: skill.name,
    description: typeof skill.description === 'string' ? skill.description : '',
    whenToUse: typeof skill.whenToUse === 'string' ? skill.whenToUse : '',
    fileName: `${skill.name}/SKILL.md`,
    enabled: true, // a preset layer is always active for its own agents
    body: '',
    frontmatter: {},
    origin: 'preset',
    preset,
  };
  if (typeof skill.source === 'string' && skill.source) entry.engineSource = skill.source;
  if (typeof skill.provider === 'string' && skill.provider) entry.engineProvider = skill.provider;
  const filePath = typeof skill.path === 'string' ? skill.path : '';
  // only local filesystem paths are readable here; url/opaque resource bases are not
  if (!filePath || /^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) return entry;
  try {
    const raw = await readFile(filePath, 'utf8');
    const { frontmatter, body } = parseSkillDoc(raw);
    entry.filePath = filePath;
    entry.fileName = basename(filePath);
    entry.body = body;
    entry.frontmatter = frontmatter;
    if (!entry.description && typeof frontmatter.description === 'string') entry.description = frontmatter.description;
    if (!entry.whenToUse && typeof frontmatter.whenToUse === 'string') entry.whenToUse = frontmatter.whenToUse;
  } catch { /* unreadable instruction file → keep the summary */ }
  return entry;
}

// All preset-bound skills.
//
// dsh 0.2: the provider installed by apply() leases each preset's scope and
// returns what that preset contributes. The ambient catalog — project and user
// disk roots plus the bundled runtime registrations — is visible from *every*
// preset scope and from the host scope too, so the provider subtracts it;
// otherwise the same user skills would be listed once per preset. What remains
// is genuinely added by a preset's own composition (for example the bundled
// development skills the `cordis` preset mounts through customSkillDirs).
//
// dsh 0.1: preset directories under the shipped + user preset roots.
async function scanPresetSkills() {
  if (presetCatalogProvider) {
    try {
      const provided = await presetCatalogProvider();
      if (Array.isArray(provided)) return dedupePresetEntries(provided);
    } catch { /* fall through to the legacy disk scanner */ }
  }
  if (presetRootsOverride && presetRootsOverride.length) {
    const entries = [];
    for (const root of presetRootsOverride) {
      entries.push(...await scanPresetRoot(root));
    }
    return dedupePresetEntries(entries);
  }
  const [shipped, user] = await Promise.all([
    scanPresetRoot(shippedPresetRoot()),
    scanPresetRoot(userPresetRoot()),
  ]);
  return dedupePresetEntries([...shipped, ...user]);
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

// One-time migration from the old model (global ~/.dsh/skills was the skill
// root AND an engine-scanned enablement layer) to the new library model
// (~/.dsh/skill-manager/library is a pure skill pool; enablement happens per
// workspace). Moves every skill file from the legacy roots into the library,
// deduplicated by name; the legacy dirs are left in place (empty) so nothing
// the engine previously scanned suddenly disappears.
let migrationDone = false;
async function migrateLegacySkills() {
  const lib = skillsRoot();
  await mkdir(lib, { recursive: true });
  if (migrationDone) return { ok: true, migrated: [], alreadyDone: true };
  migrationDone = true;
  const legacy = [join(dshHome(), 'skills'), join(dshHome(), 'skills-disabled')];
  const seen = new Set();
  for (const dir of legacy) {
    let names;
    try { names = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of names) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const base = basename(ent.name, extname(ent.name));
      if (!validSkillFileName(ent.name)) continue;
      const src = join(dir, ent.name);
      const dstDir = join(lib, base);
      const dstFile = join(dstDir, 'SKILL.md');
      let inLibrary = false;
      try { await stat(dstFile); inLibrary = true; } catch { /* absent */ }
      if (!inLibrary) {
        try {
          const raw = await readFile(src, 'utf8');
          await mkdir(dstDir, { recursive: true });
          await writeFile(dstFile, raw, 'utf8');
          seen.add(base);
        } catch { continue; }
      }
      // The library is now the single source of truth. The legacy root
      // (~/.dsh/skills) is ALSO a default engine root that dsh-skill-filesystem
      // loads globally for EVERY session, bypassing the workspace whitelist —
      // so leftover copies would keep these skills visible everywhere. Remove
      // the source once its content lives in the library.
      try { await unlink(src); } catch { /* keep on failure */ }
    }
  }
  // Re-point workspace symlinks that targeted the legacy global root's
  // single-file skills: drop them (the library now stores directory form and
  // normalizeSkillDirs rebuilds workspace entries consistently on next run).
  try {
    const ws = await listWorkspaces();
    for (const w of ws) {
      if (!w.exists) continue;
      const dir = workspaceSkillDir(w.cwd);
      let names;
      try { names = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of names) {
        if (!ent.isFile() && !ent.isSymbolicLink()) continue;
        if (!ent.name.endsWith('.md')) continue;
        const p = join(dir, ent.name);
        try {
          const ls = await lstat(p);
          if (ls.isSymbolicLink()) {
            const linkTarget = await readlink(p);
            const oldTarget = join(dshHome(), 'skills', ent.name);
            if (linkTarget === oldTarget) {
              try { await unlink(p); } catch { /* keep copy */ }
            }
          }
        } catch { /* ignore unreadable entries */ }
      }
    }
  } catch { /* registry read failed — non-fatal */ }
  return { ok: true, migrated: [...seen] };
}

// Normalize single-file skills (<root>/<name>.md) into the canonical
// directory form (<root>/<name>/SKILL.md) across the library and every
// registered workspace. The engine (and now this manager) treats directory
// form as the standard skill layout; single-file .md is legacy. Idempotent:
// runs on apply, converts a stray .md even if a same-name dir already exists
// (then the dir wins and the .md is dropped). Works for regular files and
// symlinks (readFile follows symlinks).
async function normalizeSkillDirs(extraRoots = []) {
  const converted = [];
  const failed = [];
  const roots = new Set([skillsRoot(), ...extraRoots.filter((r) => typeof r === 'string' && r)]);
  try {
    for (const w of await listWorkspaces()) {
      if (!w.exists) continue;
      roots.add(workspaceSkillDir(w.cwd));
    }
  } catch { /* registry unavailable — library only */ }
  // Also cover unregistered project whitelist roots (<cwd>/.dsh/skills) the
  // engine loads — otherwise their single-file skills would stay legacy.
  try {
    for (const s of await scanSkillSources()) {
      if (s.name === 'project-dsh' && typeof s.dir === 'string' && s.dir) roots.add(s.dir);
    }
  } catch { /* source scan unavailable */ }
  for (const root of roots) {
    let names;
    try { names = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const ent of names) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      if (!validSkillFileName(ent.name)) continue;
      const base = basename(ent.name, extname(ent.name));
      const source = join(root, ent.name);
      const targetDir = join(root, base);
      try {
        let dirExists = false;
        try { dirExists = (await stat(targetDir)).isDirectory(); } catch { /* absent */ }
        if (dirExists) {
          // directory form already canonical — drop the stray duplicate .md
          await unlink(source);
          converted.push(`${root}/${base} (dup .md removed)`);
          continue;
        }
        const raw = await readFile(source, 'utf8');
        await mkdir(targetDir, { recursive: true });
        await writeFile(join(targetDir, 'SKILL.md'), raw, 'utf8');
        await unlink(source);
        converted.push(`${root}/${base}`);
      } catch (err) {
        failed.push(`${root}/${base}: ${errMsg(err)}`);
      }
    }
  }
  return { ok: true, converted, failed };
}

// Scan sources for unmanaged skills: everything dsh-skill-filesystem loads
// that is NOT part of this manager's library yet.
//   - ~/.dsh/skills          user-dsh      (engine global root; move)
//   - ~/.agents/skills       user-agents   (engine global root; move)
//   - <cwd>/.agents/skills   project-agents(engine project root; move)
//   - <cwd>/.dsh/skills      project-dsh   (workspace whitelist; keep)
// adopt 'move' → copy into the library, then unlink the engine-root source
// (otherwise it keeps loading in every session, bypassing the whitelist).
// adopt 'keep'  → copy into the library but LEAVE the source (a workspace
// whitelist entry means "enabled in this workspace" — it stays enabled).
function agentsHomeDir() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents');
}

// Recursive directory copy for the symlink-less fallback transport. fs.cp
// handles loops, permissions and file types more robustly than a hand-rolled
// walk, and Node ≥16.7 ships it.
function copyDirRecursive(src, dst) {
  return cp(src, dst, { recursive: true, force: true });
}

async function scanSkillSources() {
  const sources = [
    { name: 'user-dsh', dir: join(dshHome(), 'skills'), adopt: 'move' },
    { name: 'user-agents', dir: join(agentsHomeDir(), 'skills'), adopt: 'move' },
  ];
  let workspaces = [];
  try { workspaces = await listWorkspaces(); } catch { /* registry unavailable */ }
  for (const w of workspaces) {
    if (!w.exists) continue;
    const root = projectRootOf(w.cwd);
    sources.push({ name: 'project-agents', dir: join(root, '.agents', 'skills'), adopt: 'move', workspace: w.cwd });
    sources.push({ name: 'project-dsh', dir: workspaceSkillDir(w.cwd), adopt: 'keep', workspace: w.cwd });
  }
  return sources;
}

// List engine/project-root skills the manager does not own yet. Workspace
// whitelist entries that already match a library skill are NOT unmanaged
// (they are regular "enabled here" copies).
async function listUnmanagedSkills() {
  const libNames = new Set((await scanDir(skillsRoot())).map((s) => s.name));
  const items = [];
  for (const src of await scanSkillSources()) {
    let entries;
    try { entries = await scanDir(src.dir); } catch { continue; }
    for (const e of entries) {
      const inLibrary = libNames.has(e.name);
      if (src.adopt === 'keep' && inLibrary) continue; // managed whitelist copy
      items.push({
        name: e.name,
        description: e.description ?? '',
        source: src.name,
        workspace: src.workspace ?? '',
        adopt: src.adopt,
        path: e.filePath,
        form: e.form ?? 'file',
        dir: e.dir ?? '',
        inLibrary,
      });
    }
  }
  items.sort((a, b) =>
    a.inLibrary === b.inLibrary ? a.name.localeCompare(b.name) : a.inLibrary ? 1 : -1);
  return items;
}

// Adopt every unmanaged skill into the library: copy any that are missing
// (library wins on name collisions), then unlink the engine-root copies so
// nothing keeps bypassing the workspace whitelist globally. Workspace
// whitelist sources (adopt 'keep') are copied but their source stays — that
// workspace remains enabled for the now-library skill.
async function importUnmanagedSkills() {
  const items = await listUnmanagedSkills();
  const imported = [];
  const removed = [];
  const failed = [];
  const lib = skillsRoot();
  for (const it of items) {
    try {
      // directory-form skill (the only canonical layout): copy the whole
      // folder, then remove the source when adopting 'move'
      if (it.form !== 'dir' || !it.dir) {
        failed.push(it.name); // legacy single-file source — not adoptable
        continue;
      }
      const dstDir = join(lib, it.name);
      if (!it.inLibrary) {
        await mkdir(dstDir, { recursive: true });
        await copyDirRecursive(it.dir, dstDir);
        imported.push(it.name);
      }
      if (it.adopt === 'move') {
        await rm(it.dir, { recursive: true, force: true });
        removed.push(it.name);
      }
    } catch {
      failed.push(it.name);
    }
  }
  return { ok: true, imported, removed, failed };
}

// Align with the dsh engine's project-root discovery
// (dsh-skill-filesystem.findProjectRoot): walk UP from the cwd until a
// directory containing `.git` is found — that is the project root the engine
// scans (<projectRoot>/.dsh/skills). No `.git` anywhere → the cwd itself.
// Mirroring this rule exactly is what makes links we create land where the
// engine actually reads them (fixes subdirectory-cwd workspaces).
function projectRootOf(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

// Workspace skill-link directory: <projectRoot(cwd)>/.dsh/skills — exists ==
// workspace enabled set (links to the global source, single copy).
function workspaceSkillDir(cwd) {
  // defense in depth: every caller routes through a gate or the registry,
  // whose keys are resolved absolute paths — a relative/empty cwd here is a
  // programming error, not a valid target (it would resolve against process cwd)
  if (!isAbsolutePath(cwd)) throw new Error(`invalid cwd (absolute path required): ${String(cwd).slice(0, 64)}`);
  return join(projectRootOf(cwd), '.dsh', 'skills');
}

// The workspace .dsh dir always exists after first toggle; keep the
// workspace's own .dsh/skills isolated from plugin bookkeeping.
function ensureWorkspaceSkillDir(cwd) {
  return mkdir(workspaceSkillDir(cwd), { recursive: true });
}

// List enabled workspace skills: every entry under <projectRoot(cwd)>/.dsh/skills
// (directory form only). linked=true means a same-named skill exists in the
// library (this workspace entry is a copy/symlink of it).
async function listWorkspaceSkills(cwd) {
  const dir = workspaceSkillDir(cwd);
  // one-time migration: pre-projectRoot builds placed links at <cwd>/.dsh/skills.
  // If the engine-aligned root does not exist yet and the legacy location does,
  // move it over so previously enabled skills actually take effect.
  const legacyDir = join(resolve(cwd), '.dsh', 'skills');
  if (legacyDir !== dir) {
    // merge each legacy entry into the engine-aligned root (skip collisions),
    // then drop the legacy dir once empty — pre-alignment enablements apply
    try {
      await mkdir(dirname(dir), { recursive: true });
      try { await mkdir(dir, { recursive: true }); } catch { /* exists */ }
      let legacyEntries = [];
      try { legacyEntries = await readdir(legacyDir, { withFileTypes: true }); } catch { legacyEntries = []; }
      for (const ent of legacyEntries) {
        const src = join(legacyDir, ent.name);
        const dst = join(dir, ent.name);
        try { await stat(dst); continue; } catch { /* dst free */ }
        try { await rename(src, dst); } catch { /* skip entry */ }
      }
      try {
        const rest = await readdir(legacyDir);
        if (rest.length === 0) await rm(legacyDir, { recursive: true, force: true });
      } catch { /* already gone */ }
    } catch { /* migration failed — non-fatal */ }
  }
  let entries;
  try { entries = await scanDir(dir); } catch { return []; }
  const skills = entries.map((e) => ({ ...e, linked: false, linkTarget: null, enabled: true }));
  for (const s of skills) {
    try {
      const globalPath = join(skillsRoot(), s.name);
      const gi = await stat(globalPath);
      if (gi.isDirectory()) {
        s.linked = true;
        s.linkTarget = globalPath;
      }
    } catch { /* not in library */ }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// Enable a global skill in a workspace. Preferred transport: a symbolic link
// to the global file — single copy, global edits propagate instantly, and the
// dsh skill engine follows symlinks (nodeEntryKind: symlink → stat → file;
// followSymlinks defaults true). Windows only allows symlinks with Developer
// Mode / admin (SeCreateSymbolicLinkPrivilege); when that's missing the call
// degrades to a plain copy so enable still works. Copy loses auto-sync but is
// flagged by name in listWorkspaceSkills; a later toggle refreshes it.
async function linkGlobalSkillToWorkspace(cwd, skillName) {
  const gate = await assertRegisteredWorkspace(cwd);
  if (!gate.ok) return { ok: false, error: gate.error };
  const r = await requireSkillEntry(skillName);
  if (!r.ok) return r;
  const { entry } = r;
  if (entry.origin === 'preset') return { ok: false, error: `preset skill ${skillName} is not workspace-manageable` };
  await ensureWorkspaceSkillDir(gate.cwd);
  const dir = workspaceSkillDir(gate.cwd);
  // directory-form skill (the only canonical layout): symlink/copy the folder
  if (entry.form !== 'dir' || !entry.dir) return { ok: false, error: '只支持目录形式技能（文件夹 + SKILL.md）' };
  const targetDir = join(dir, entry.name);
  try { await rm(targetDir, { recursive: true, force: true }); } catch { /* absent */ }
  let transport = 'copy';
  try {
    await symlink(resolve(entry.dir), targetDir, 'dir');
    transport = 'symlink';
  } catch {
    try {
      await copyDirRecursive(entry.dir, targetDir);
      transport = 'copy';
    } catch (err) {
      return { ok: false, error: `enable failed: ${errMsg(err)}` };
    }
  }
  return { ok: true, name: entry.name, targetPath: targetDir, transport };
}

// Disable a skill in a workspace by removing its link/copy.
async function unlinkGlobalSkillFromWorkspace(cwd, skillName) {
  const gate = await assertRegisteredWorkspace(cwd);
  if (!gate.ok) return { ok: false, error: gate.error };
  const base = bareSkillName(skillName);
  // path-traversal guard: the base is interpolated into join() + rm()
  if (!isValidIdentifier(base) || !validSkillFileName(`${base}.md`)) {
    return { ok: false, error: 'invalid skill name' };
  }
  const dir = workspaceSkillDir(gate.cwd);
  // directory form: <dir>/<skillName>/
  const dirPath = join(dir, base);
  try {
    const st = await stat(dirPath);
    if (st.isDirectory()) {
      await rm(dirPath, { recursive: true, force: true });
      return { ok: true, name: base };
    }
  } catch { /* not a directory */ }
  // stale single-file artifact — clean it if present
  try { await unlink(join(dir, `${base}.md`)); return { ok: true, name: base }; } catch { /* absent */ }
  return { ok: true, name: base }; // already off
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
// Entries whose directory no longer exists (deleted or renamed away) are
// pruned from the registry on read — the manager only tracks live
// workspaces, so neither the panel nor the tool layer ever sees dead paths.
async function listWorkspaces() {
  const reg = await readWorkspaceRegistry();
  const result = [];
  const stale = [];
  for (const [cwd, meta] of Object.entries(reg)) {
    let skills = [];
    let exists = true;
    try {
      await stat(cwd);
    } catch {
      exists = false;
    }
    if (!exists) {
      stale.push(cwd);
      continue;
    }
    skills = await listWorkspaceSkills(cwd);
    result.push({
      cwd,
      registeredAt: typeof meta.registeredAt === 'number' ? meta.registeredAt : 0,
      exists,
      enabled: skills.map((s) => s.name),
      enabledCount: skills.length,
    });
  }
  if (stale.length) {
    for (const cwd of stale) delete reg[cwd];
    try { await writeWorkspaceRegistry(reg); } catch { /* best-effort prune */ }
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
        if (typeof cfg.cwd === 'string' && samePath(cfg.cwd, oldAbs)) {
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
        if (typeof cfg.cwd === 'string' && samePath(cfg.cwd, abs)) {
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
  // path-traversal guard: session ids are opaque identifiers, never path-like
  if (!isValidIdentifier(sessionId)) throw new Error(`invalid sessionId: ${String(sessionId).slice(0, 32)}`);
  return join(managerRoot(), 'sessions', `${sessionId}.json`);
}

// Read one session's skill selection { cwd, explicit, enabled: [] }.
// explicit=false (or missing file) means "follow the workspace": the session
// enables every skill the workspace has on, automatically tracking changes.
async function readSessionConfig(sessionId) {
  let p;
  try { p = sessionConfigPath(sessionId); } catch { return { cwd: '', explicit: false, enabled: [] }; }
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? {
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      explicit: parsed.explicit === true,
      enabled: Array.isArray(parsed.enabled) ? parsed.enabled.filter((n) => typeof n === 'string' && n.trim()) : [],
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
// picked freely from the LIBRARY (workspace enablement only defines the
// follow-workspace default — an explicit session may enable any library skill,
// including ones a workspace hasn't enabled); `explicit=false` restores
// follow-workspace semantics (session = full workspace set).
async function setSessionSkills(sessionId, cwd, enabled, explicit = true) {
  // session selections are always against a concrete workspace
  if (!isAbsolutePath(cwd)) return { ok: false, error: 'cwd 必须为工作区绝对路径' };
  const globals = await scanDir(skillsRoot());
  const allowed = new Set(globals.map((s) => s.name));
  const requested = Array.isArray(enabled)
    ? [...new Set(enabled.filter((n) => typeof n === 'string' && n))]
    : [];
  const clean = requested.filter((n) => allowed.has(n));
  // Names outside the library can never be session-selected: the library is the
  // only writable pool, and workspace/preset layers are not the session's to
  // change. Dropping them SILENTLY made the panel report success while the
  // toggle visibly bounced back, so report them and let the UI say why.
  const dropped = requested.filter((n) => !allowed.has(n));
  const cfg = {
    cwd,
    explicit: explicit === true,
    enabled: explicit === true ? clean : [],
  };
  await writeSessionConfig(sessionId, cfg);
  return { ok: true, cfg, ...(dropped.length ? { dropped } : {}) };
}

// Effective session view: global + preset (always visible), workspace
// enabled set, and the session selection layered on top (subset of workspace).
async function sessionSkillView(sessionId, cwd) {
  const [globals, presets, workspace] = await Promise.all([
    scanDir(skillsRoot()),
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
    // `cwd` here is the workspace this view was actually built from — NOT the
    // one the session's saved plugin state happens to carry. Those differ for a
    // session that has never written plugin state (saved cwd is still ''), and
    // the panel uses this field to seed its own cwd for the write path, so
    // returning the saved value left the client with an empty cwd and made
    // every toggle/`回到跟随` POST die as "cwd 必须为工作区绝对路径".
    session: { id: sessionId, cwd: cwd || cfg.cwd, explicit: cfg.explicit, enabled: cfg.enabled },
  };
}

// ---------- module-level operations (shared by tools + HTTP API) ----------

// Engine-visibility (v4.2): use dsh's native ctx.skills.list({ cwd }) as the
// "what the engine actually loads" reference and annotate each view skill with
// its load state, so the UI can flag enablements that never take effect.
// States:
//   'unknown'  — engine catalog unavailable/empty: can't judge (no badge).
//                An EMPTY list is treated as unknown, NOT as "nothing loaded":
//                the host-side list() may not see providers that live in a
//                scope layer, so the engine may still be loading skills even
//                when our read returns []. Silent beats false alarm.
//   'off'      — not enabled (workspace nor session): no badge
//   'ok'       — enabled AND the engine loads it as project-dsh
//   'shadowed' — workspace-enabled, engine loads the SAME name from another
//                layer (preset etc.): enablement is silently overridden
//   'missing'  — workspace-enabled via the whitelist (the disk contract the
//                engine is supposed to load) but the engine loads no such
//                skill at all. Session-only picks (view layer) never produce
//                'missing'/'shadowed': the engine is NOT supposed to load
//                them per the v4.1 session semantics.
// Pure over { skills: [{name, layer, sessionEnabled, origin}], engineLoaded }.
function engineLoadState(skill, engineLoaded) {
  if (!skill || !skill.name) return 'off';
  // preset-layer skills are provided by the engine itself: always fine
  if (skill.layer === 'preset' || skill.origin === 'preset') return 'ok';
  // only workspace whitelist entries carry the engine-load contract; a pure
  // session pick (view layer) is never judged against the engine catalog
  if (skill.layer !== 'workspace') return 'off';
  if (engineLoaded === undefined || engineLoaded === null || engineLoaded.length === 0) return 'unknown';
  const hit = engineLoaded.find((e) => e.name === skill.name);
  if (hit) return hit.source === 'project-dsh' ? 'ok' : 'shadowed';
  // No hit. Only a snapshot that actually covered the project layer can prove
  // absence: dsh's skill service layers results by caller scope, and a
  // scope-less list() returns the global layer alone — project .dsh/skills
  // entries are invisible there by construction, not by being unloaded. In
  // that case 'missing' would be a false alarm about a skill that loads fine,
  // so report 'unknown' (no warning tag) instead.
  const projectVisible = engineLoaded.some((e) => e.source === 'project-dsh' || e.source === 'project-agents');
  return projectVisible ? 'missing' : 'unknown';
}

// Query the engine's loaded skill summaries for a cwd through the optional
// native skills service. Returns undefined when the service is unavailable or
// the query failed (caller treats it as 'unknown'), else the loaded list.
async function collectEngineLoaded(skillsSvc, cwd) {
  if (!cwd || typeof skillsSvc?.list !== 'function') return undefined;
  try {
    const items = await skillsSvc.list({ cwd });
    return (Array.isArray(items) ? items : []).map((s) => ({
      name: s.name,
      source: s.source,
      provider: s.provider,
    }));
  } catch { return undefined; }
}

// Look up one skill in the library. Directory form (<name>/SKILL.md) is the
// only canonical layout since the single-file migration; a name ending in
// .md is normalized to its base name.
async function findSkill(name) {
  const base = bareSkillName(name);
  try {
    const all = await scanDir(skillsRoot());
    return all.find((e) => e.name === base);
  } catch { return undefined; }
}

// ---------- directory-form skill file tree ----------

// Recursively list files under a directory-form skill's folder, skipping
// hidden entries (.git, .nojekyll, etc.). Returns a nested tree shaped for
// the client file-tree component: [{ name, type:'dir'|'file', path, children? }].
// Caps total entries so a pathological folder cannot stall the panel.
const MAX_TREE_ENTRIES = 2000;
async function buildFileTree(dir, base = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const ent of entries) {
    if (result.length >= MAX_TREE_ENTRIES) return result;
    if (ent.name.startsWith('.')) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      result.push({ name: ent.name, type: 'dir', path: rel, children: await buildFileTree(join(dir, ent.name), rel) });
    } else if (ent.isFile()) {
      let size = 0;
      try { size = (await stat(join(dir, ent.name))).size; } catch { /* ignore */ }
      result.push({ name: ent.name, type: 'file', path: rel, size });
    }
  }
  return result;
}

// Find a skill entry by name in a specific workspace dir (project .dsh/skills),
// falling back to the library. Used by the file-tree APIs so a directory-form
// skill living in a workspace (not yet imported to the library) is reachable.
async function findSkillIn(name, cwd) {
  if (cwd && isAbsolutePath(cwd)) {
    try {
      const ws = await scanDir(workspaceSkillDir(cwd));
      const e = ws.find((s) => s.name === name);
      if (e) return e;
    } catch { /* workspace dir absent */ }
  }
  return findSkill(name); // library
}

// Resolve a skill entry (workspace-first, library fallback) with the standard
// "not found" wrapper, trimming the repeated entry checks callers used to do.
async function requireSkillEntry(name, cwd) {
  const entry = await findSkillIn(name, cwd);
  if (!entry) return { ok: false, error: `skill ${name} not found` };
  return { ok: true, entry };
}

// List the file tree of a directory-form skill. Single-file skills return
// an empty tree (their content IS the SKILL.md, editable in the main editor).
async function listSkillFiles(name, cwd) {
  // Directory form is the only canonical layout; a legacy single-file skill
  // has no file browser.
  const r = await requireSkillEntry(name, cwd);
  if (!r.ok) return r;
  const { entry } = r;
  if (entry.form !== 'dir') return { ok: false, error: '该技能为旧单文件形式，仅支持目录形式技能的文件浏览' };
  const tree = await buildFileTree(entry.dir);
  // the tree is rooted at the skill's own folder so the browser shows the
  // "skill directory" node first, with its contents beneath it
  return { ok: true, form: 'dir', dir: entry.dir, files: [{ name: entry.name, type: 'dir', path: '', children: tree }] };
}

// Read one file inside a directory-form skill's folder. relPath is relative
// to the skill dir (e.g. "reference/react.md"). Guards against path escape.
// Single-file skills are not browsable — directory form is canonical.
async function readSkillFile(name, relPath, cwd) {
  const r = await requireSkillEntry(name, cwd);
  if (!r.ok) return r;
  const { entry } = r;
  if (entry.form !== 'dir') return { ok: false, error: '单文件技能不支持文件读取（目录形式已统一）' };
  if (typeof relPath !== 'string' || !relPath || relPath.includes('..')) return { ok: false, error: 'invalid file path' };
  const filePath = resolve(entry.dir, relPath);
  if (!filePath.startsWith(resolve(entry.dir))) return { ok: false, error: 'path outside skill dir' };
  try {
    const content = await readFile(filePath, 'utf8');
    return { ok: true, path: relPath, content, size: content.length };
  } catch {
    return { ok: false, error: `cannot read ${relPath}` };
  }
}

// Write (overwrite) one file inside a directory-form skill's folder.
// Same path-escape guard as readSkillFile.
async function writeSkillFile(name, relPath, content, cwd) {
  const r = await requireSkillEntry(name, cwd);
  if (!r.ok) return r;
  const { entry } = r;
  if (entry.form !== 'dir') return { ok: false, error: '单文件技能不支持文件写入（目录形式已统一）' };
  if (typeof relPath !== 'string' || !relPath || relPath.includes('..')) return { ok: false, error: 'invalid file path' };
  const filePath = resolve(entry.dir, relPath);
  if (!filePath.startsWith(resolve(entry.dir))) return { ok: false, error: 'path outside skill dir' };
  try {
    await writeFile(filePath, typeof content === 'string' ? content : String(content ?? ''), 'utf8');
    return { ok: true, path: relPath };
  } catch (err) {
    return { ok: false, error: `cannot write ${relPath}: ${errMsg(err)}` };
  }
}

// Build a compact body snippet around the first match for `q`. Strips
// Markdown markers (headings, list bullets, code fences, bold/italic, inline
// code) so the snippet reads as plain inline text instead of raw syntax.
function snippetAround(body, q, radius = 40) {
  const idx = body.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + q.length + radius);
  const raw = body.slice(start, end)
    // per-line: strip leading markers while the text is still line-structured
    .split('\n').map((l) => l
      .replace(/^```[^\s]*\s*/, '')   // code fence opener
      .replace(/^\s*(#{1,6})\s+/, '') // heading markers
      .replace(/^\s*([-*+]|\d+\.)\s+/, '') // list markers
      .replace(/^\s*>\s?/, '')        // blockquote
    ).join(' ')
    .replace(/`/g, '')                 // inline code backticks
    .replace(/(\*\*|\*|__|_)/g, '')    // bold/italic markers
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → label only
    .replace(/\s+/g, ' ')
    .trim();
  return (start > 0 ? '…' : '') + raw + (end < body.length ? '…' : '');
}

// Search every skill across layers (global user skills, presets, and all
// registered workspaces) by name / description / whenToUse / body content
// (case-insensitive substring). Returns deduped matches with per-layer
// provenance and a body snippet so the caller can locate the right skill.
// Priority on name collisions follows the view rule: workspace > global > preset.
// currentCwd (optional) marks each row with wsEnabled — whether the skill is
// currently enabled in THAT workspace — so the search UI can offer
// enable/disable without a second round trip.
async function searchSkills(query, currentCwd) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return { ok: true, results: [] };
  const matches = [];
  const seen = new Set();
  // workspace-enabled names for the given cwd; null when no cwd was supplied
  let wsEnabledSet = null;
  if (typeof currentCwd === 'string' && currentCwd) {
    try {
      wsEnabledSet = new Set((await listWorkspaceSkills(currentCwd)).map((s) => s.name));
    } catch {
      wsEnabledSet = new Set();
    }
  }
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
        wsEnabled: wsEnabledSet ? wsEnabledSet.has(e.name) : !!e.enabled,
        wsCwd: typeof currentCwd === 'string' ? currentCwd : '',
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

  // library skills
  const active = await scanDir(skillsRoot());
  for (const g of active) add({ ...g, layer: 'global' });

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
// Directory-form skills edit their SKILL.md in place (rename only changes
// the frontmatter.name, not the folder — the engine identifies by frontmatter).
async function editSkill(name, { frontmatter, body }) {
  const r = await requireSkillEntry(name);
  if (!r.ok) return r;
  const { entry } = r;
  const nextFm = frontmatter && typeof frontmatter === 'object' ? { ...entry.frontmatter, ...frontmatter } : entry.frontmatter;
  // Directory form is canonical: write the merged doc to SKILL.md in place.
  // A frontmatter.name change updates the identifier only (the engine and
  // scanDir identify by frontmatter.name, not the folder name).
  const nextBody = typeof body === 'string' ? body : entry.body;
  await writeFile(entry.filePath, serializeSkillDoc(nextFm, nextBody), 'utf8');
  return { ok: true, name: entry.name, fileName: entry.fileName };
}

// Deprecated in the library model: global enable/disable no longer exists.
// A skill's availability is decided per workspace (whitelist). Kept as a
// no-op stub so old tool calls fail loudly instead of moving files around.
async function setSkillEnabled(name, enable) {
  return { ok: false, error: '全局启用/停用已移除：技能在当前工作区是否可用请用工作区技能面板勾选（library 为纯技能池，启用跟随项目）' };
}

// Permanently delete a skill: removes the whole skill directory (the only
// canonical layout), then purges same-named leftovers from every engine /
// project source — otherwise listUnmanagedSkills() would immediately report
// the "deleted" skill as unmanaged again (workspace-whitelist copies survive
// the library delete and re-appear as adoptable).
async function deleteSkill(name) {
  const r = await requireSkillEntry(name);
  if (!r.ok) return r;
  const { entry } = r;
  if (entry.form !== 'dir' || !entry.dir) return { ok: false, error: '只支持目录形式技能' };
  await rm(entry.dir, { recursive: true, force: true });
  await purgeSkillSources(name);
  return { ok: true, name };
}

// After deleting a library skill, remove every same-named leftover from the
// sources listUnmanagedSkills() scans: workspace-whitelist entries
// (<root>/.dsh/skills, adopted 'keep') and engine/project roots
// (~/.dsh/skills, ~/.agents/skills, <root>/.agents/skills — adopted 'move').
// A leftover link/copy would otherwise resurrect the skill as "unmanaged"
// and let the user re-import it right after deleting it. Idempotent and
// best-effort: anything already gone or unreadable is skipped.
async function purgeSkillSources(name) {
  const base = bareSkillName(name);
  if (!isValidIdentifier(base) || !validSkillFileName(`${base}.md`)) return;
  const targets = [
    join(dshHome(), 'skills', base),
    join(agentsHomeDir(), 'skills', base),
  ];
  try {
    for (const w of await listWorkspaces()) {
      if (!w.exists) continue;
      const root = projectRootOf(w.cwd);
      targets.push(join(root, '.dsh', 'skills', base));
      targets.push(join(root, '.agents', 'skills', base));
    }
  } catch { /* registry unavailable — global roots only */ }
  for (const t of targets) {
    try { await rm(t, { recursive: true, force: true }); } catch { /* absent */ }
    try { await unlink(`${t}.md`); } catch { /* absent */ }
  }
}

// Mirror import semantics: every import (zip / directory / bare doc)
// replaces the skill directory wholesale — the imported payload IS the
// skill. Stale files from an earlier version (renamed/deleted in the new
// source) are removed instead of silently lingering, so a re-import that
// drops a file shows up immediately instead of surfacing later as drift.
async function resetSkillDir(skillDir) {
  await rm(skillDir, { recursive: true, force: true });
  await mkdir(skillDir, { recursive: true });
}

// Import a skill from a zip buffer: must contain a root SKILL.md whose
// frontmatter declares a kebab-case `name`. Extracts into the active root
// (entry count + total uncompressed size capped against zip-bomb payloads).
async function importSkillZipFromBuffer(buf) {
  if (buf.length === 0) return { ok: false, error: '空文件（zip 包为空）' };
  let entries;
  try {
    entries = new AdmZip(buf).getEntries();
  } catch {
    return { ok: false, error: 'zip 无法解析（文件可能已损坏）' };
  }
  if (entries.length > 1000) return { ok: false, error: 'zip 包含条目过多（>1000，疑似打包炸弹）' };
  const mdEntry = entries.find((e) => {
    const n = e.entryName.replace(/\\/g, '/').replace(/^\.\//, '');
    return !e.isDirectory && n.endsWith('.md') && basename(n) === 'SKILL.md';
  });
  if (!mdEntry) return { ok: false, error: 'zip 根目录须包含 SKILL.md 文件' };
  const raw = mdEntry.getData().toString('utf8');
  const { frontmatter } = parseSkillDoc(raw);
  const skillName = typeof frontmatter.name === 'string' ? frontmatter.name : '';
  if (!skillName || !validSkillFileName(`${skillName}.md`)) {
    return { ok: false, error: 'SKILL.md 的 frontmatter 须声明 kebab-case 的 name（如 skill-name）' };
  }
  // Canonical layout: <library>/<name>/SKILL.md (+ any sibling files from the
  // zip, e.g. reference/, assets/ — restored under the skill directory).
  // Mirror import: wipe any previous version of this name first so stale
  // files from an older zip don't linger alongside the new payload.
  const skillDir = join(skillsRoot(), skillName);
  await resetSkillDir(skillDir);
  await writeFile(join(skillDir, 'SKILL.md'), raw, 'utf8');
  let restored = 0;
  let totalBytes = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    const n = e.entryName.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!n || n === 'SKILL.md') continue;
    // only files logically under the skill root; reject escapes
    const parts = n.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) continue;
    const out = join(skillDir, ...parts);
    if (!out.startsWith(resolve(skillDir))) continue;
    try {
      const data = e.getData();
      totalBytes += data.length;
      if (totalBytes > 100 * 1024 * 1024) return { ok: false, error: 'zip expands too large' };
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, data);
      restored++;
    } catch { /* skip unextractable entries */ }
  }
  return { ok: true, name: skillName, fileName: 'SKILL.md', restored };
}

// Import many skills at once (folder batch upload). The legacy form is
// `{ source, content }` (content = the SKILL.md text, imported as a bare
// doc). The directory form is `{ source, files: [{ path, b64 }] }` where
// `path` is the path relative to the skill directory and `b64` is the file
// content — SKILL.md plus every sibling (scripts/, reference/, assets/,
// …) gets restored under the canonical <library>/<name>/ layout, mirroring
// the zip importer. Per-item validation: must declare a kebab-case `name`,
// a non-empty `description`, and a non-empty body — the definition of
// "actually a skill". Partial failure does not abort the rest.
async function importSkillDocs(items) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'no skill files received' };
  const results = [];
  for (const item of items.slice(0, 200)) {
    const source = typeof item?.source === 'string' && item.source ? item.source : `skill #${results.length + 1}`;
    // Directory form: one item = one skill directory (SKILL.md + siblings).
    // The presence of the `files` key (even an empty array) selects this
    // form; a directory without SKILL.md is rejected outright.
    if (Array.isArray(item?.files)) {
      const md = item.files.find((f) => safeSkillRel(f?.path) === 'SKILL.md');
      if (!md) {
        results.push({ source, ok: false, error: '技能目录缺少 SKILL.md（每个技能目录必须含一个 SKILL.md）' });
        continue;
      }
      const raw = Buffer.from(md.b64 ?? '', 'base64').toString('utf8');
      if (!raw.trim()) {
        results.push({ source, ok: false, error: 'SKILL.md 为空' });
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
        // canonical layout: <library>/<name>/SKILL.md + restored siblings.
        // Mirror import: wipe the previous version of this name first so a
        // re-import that drops a file actually removes it (no stale drift).
        const skillDir = join(skillsRoot(), skillName);
        await resetSkillDir(skillDir);
        await writeFile(join(skillDir, 'SKILL.md'), raw, 'utf8');
        let restored = 0;
        let totalBytes = raw.length;
        let tooBig = false;
        for (const f of item.files) {
          const rel = safeSkillRel(f?.path);
          if (!rel || rel === 'SKILL.md') continue;
          const b64 = typeof f?.b64 === 'string' ? f.b64 : '';
          const data = Buffer.from(b64, 'base64');
          totalBytes += data.length;
          if (totalBytes > 100 * 1024 * 1024) {
            tooBig = true;
            results.push({ source, ok: false, error: '技能目录解包后过大（>100MB）' });
            break;
          }
          const out = join(skillDir, ...rel.split('/'));
          await mkdir(dirname(out), { recursive: true });
          await writeFile(out, data);
          restored++;
        }
        if (!tooBig) results.push({ source, ok: true, name: skillName, fileName: 'SKILL.md', restored });
      } catch (err) {
        results.push({ source, ok: false, error: `写入失败: ${errMsg(err)}` });
      }
      continue;
    }
    // Legacy bare-doc form: `{ source, content }`.
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
      // canonical layout: <library>/<name>/SKILL.md (mirror import: wipe any
      // previous version of this name so a bare-doc re-import reflects the
      // doc as-is, dropping stale siblings from an older directory-form one).
      const skillDir = join(skillsRoot(), skillName);
      await resetSkillDir(skillDir);
      await writeFile(join(skillDir, 'SKILL.md'), raw, 'utf8');
      results.push({ source, ok: true, name: skillName, fileName: 'SKILL.md' });
    } catch (err) {
      results.push({ source, ok: false, error: `写入失败: ${errMsg(err)}` });
    }
  }
  return { ok: true, results };
}

// Normalize a user-supplied relative path from a directory import. Any
// candidate containing `..`, a leading `/` or `\`, an empty segment, or a
// drive letter is rejected outright (mirrors the zip importer's guard);
// the returned path is always forward-slash, dot-free, and safe to join
// under the skill directory. Returns undefined when untrusted.
function safeSkillRel(p) {
  if (typeof p !== 'string' || !p) return undefined;
  const n = p.replace(/\\/g, '/');
  if (n.startsWith('/')) return undefined;
  if (/^[a-zA-Z]:/.test(n)) return undefined;
  const parts = n.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return undefined;
  if (parts.some((s) => s.length > 255)) return undefined;
  return parts.join('/');
}

export function apply(ctx) {
  const routePath = '/skill-manager/api';

  // One-time migration from the legacy global-enabled model to the library +
  // workspace-whitelist model. Runs in the background; idempotent.
  migrateLegacySkills().catch(() => { /* non-fatal */ });
  // Normalize single-file skills into the canonical directory form. Idempotent.
  normalizeSkillDirs().catch(() => { /* non-fatal */ });

  // ---- preset catalog provider (dsh 0.2) -----------------------------------
  //
  // dsh 0.2 removed preset directories and the old service's `resolvedRoots`
  // with them. The supported read is now scope-based: each `@deepseek-ai/
  // dsh-agent-preset` row mounts its `plugins` into its OWN registry scope, so
  // `skills.list({ scope })` is the only way to see what a preset contributes.
  //
  // two rules matter here:
  //   1. acquireScope() throws for an unknown or broken preset, and it is a
  //      refcount lease on an already-mounted generation — it must be released
  //      in a finally block or that generation is never collected. `retain()`
  //      (its implementation) only bumps a counter, so this is cheap, not a
  //      mount.
  //   2. attribution must come from the SCOPE, never from SkillSummary.source:
  //      SkillSource has no 'preset' value at all, and a preset's own bundled
  //      skills arrive through a skill-filesystem row with customSkillDirs
  //      (source 'custom' — indistinguishable from a user's own customSkillDirs).
  //      What separates them is the ambient diff below: the project/user disk
  //      catalog is visible from every preset scope and from the host scope, so
  //      subtracting both host names and "present in every preset" leaves what
  //      this preset genuinely adds.
  presetCatalogProvider = async () => {
    const presets = ctx.get?.('agentPresets') ?? ctx.agentPresets;
    const skills = ctx.get?.('skills') ?? ctx.skills;
    if (!presets?.list || !skills?.list) return null;
    const rows = await presets.list();
    if (!Array.isArray(rows)) return null;

    // Host-scope names = the global layer: runtime/bundled registrations. In the
    // 0.2 web composition the base skill-filesystem row is disabled, so this is
    // runtime skills only — but those are exactly the ones every preset also
    // sees, so they must never be attributed to a preset.
    const hostNames = new Set();
    try {
      for (const s of (await skills.list({})) ?? []) {
        if (s && typeof s.name === 'string') hostNames.add(s.name);
      }
    } catch { /* an unreadable host catalog just means no subtraction */ }

    const perPreset = [];
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id : '';
      if (!id || typeof row.broken === 'string') continue;
      let lease;
      try {
        lease = typeof presets.acquireScope === 'function' ? await presets.acquireScope(id) : undefined;
      } catch { continue; } // unknown/broken preset → skip it, never fail the catalog
      try {
        const found = await skills.list({ scope: lease?.key });
        perPreset.push({ row, found: Array.isArray(found) ? found : [] });
      } catch {
        perPreset.push({ row, found: [] });
      } finally {
        try { await lease?.[Symbol.asyncDispose]?.(); } catch { /* already released */ }
      }
    }

    const counts = new Map();
    for (const { found } of perPreset) {
      for (const s of found) {
        if (s && typeof s.name === 'string') counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
      }
    }
    // Ambient = host layer ∪ (every preset sees it). The "every preset" half only
    // makes sense with at least two readable presets; with one, it would erase
    // that single preset's entire contribution.
    const ambient = new Set(hostNames);
    if (perPreset.length >= 2) {
      for (const [name, n] of counts) if (n === perPreset.length) ambient.add(name);
    }

    const resolved = [];
    for (const { row, found } of perPreset) {
      const meta = presetMetaFromRow(row);
      for (const skill of found) {
        if (!skill || typeof skill.name !== 'string') continue;
        if (ambient.has(skill.name)) continue;
        resolved.push(await presetEntryFromSummary(skill, meta));
      }
    }
    return resolved;
  };

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
    ctx.tools.register({
      ...definition,
      parameters: normalizeParameters(definition.parameters),
    });
  }

  // Resolve the skills registry that the ENGINE ACTUALLY SEES for one session.
  //
  // dsh 0.2 layers the skill catalog by scope, and this composition disables the
  // base host `skill-filesystem` row (presets own local discovery). A scope-less
  // `ctx.skills.list({ cwd })` therefore returns the global layer only —
  // runtime/bundled registrations — so the "is the workspace whitelist really
  // loaded by the engine?" check would be blind to every project skill and could
  // never light up. The supported read is the Agent's own preset-scoped skills
  // service: find the live Agent, then ask the preset registry for the `skills`
  // service inside that Agent's scope (same shape as dsh-api-session-controller's
  // skill catalog). No live Agent → fall back to the global registry.
  function resolveSessionSkillsView(sessionId) {
    const registry = ctx.get?.('skills') ?? ctx.skills;
    if (!registry || !sessionId) return registry;
    try {
      const agent = ctx.get?.('agents')?.get?.(sessionId);
      if (agent === undefined) return registry;
      const scoped = ctx.get?.('agentPresets')?.serviceFor?.(agent, 'skills');
      return scoped && typeof scoped.list === 'function' ? scoped : registry;
    } catch { return registry; }
  }

  // Resolve the working directory a skill view/write belongs to.
  //
  // Order matters, and the second step is the one that makes a JUST-OPENED
  // session work. `ctx.sessions` is an in-memory store: opening a session in the
  // UI does not put it there until a turn runs, so resolving "my session" from
  // the live store alone returns '' for exactly the case users hit — open a
  // session, go to its Skills tab, toggle something. With cwd '' the workspace
  // layer came back empty (every row showed as not-enabled) and every write
  // failed as "cwd 必须为工作区绝对路径". The durable header carries the same
  // cwd and is readable without taking write ownership.
  async function resolveSessionCwd(sessionId, fallbackCwd) {
    // only an absolute path may be used as a working dir; a relative one is
    // ignored so the session store decides (never resolve('') to process cwd)
    if (isAbsolutePath(fallbackCwd)) return fallbackCwd;
    // 1) live session — the fast path
    let sessions;
    try {
      sessions = ctx.sessions?.list?.();
      if (sessionId) {
        const session = ctx.sessions?.get?.(sessionId) ?? sessions?.find((s) => s.id === sessionId);
        const cwd = session?.header?.cwd;
        if (isAbsolutePath(cwd)) return cwd;
      }
    } catch { /* session store unavailable */ }
    if (sessionId) {
      // 2) durable header — the only source that covers a session this process
      //    has not loaded into memory yet.
      try {
        const snapshot = await (ctx.get?.('sessionPersistence'))?.stat?.(sessionId);
        const cwd = snapshot?.header?.cwd;
        if (isAbsolutePath(cwd)) return cwd;
      } catch { /* persistence unavailable */ }
      // 3) whatever this session's own plugin state already recorded
      try {
        const saved = await readSessionConfig(sessionId);
        if (isAbsolutePath(saved.cwd)) return saved.cwd;
      } catch { /* unreadable state */ }
    }
    // 4) last resort: the most recently created live session
    try {
      if (Array.isArray(sessions) && sessions.length > 0) {
        const latest = sessions
          .filter((s) => isAbsolutePath(s.header?.cwd))
          .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))[0];
        if (latest) return latest.header.cwd;
      }
    } catch { /* session store unavailable */ }
    return '';
  }

  // Union every cwd ever seen in the session store into the workspace
  // registry, so the picker lists ALL of the user's workspaces — not just
  // the ones whose skill-manager panel happened to be opened. Keeps the
  // registry a pure superset: session-driven discovery + manual registration.
  async function registerAllSessionCwds() {
    let added = 0;
    try {
      const sessions = ctx.sessions?.list?.() ?? [];
      const cwds = new Set();
      for (const s of sessions) {
        const cwd = s?.header?.cwd;
        if (typeof cwd === 'string' && cwd && isAbsolutePath(cwd)) cwds.add(cwd);
      }
      for (const cwd of cwds) {
        try { await registerWorkspace(cwd); added++; } catch { /* non-fatal */ }
      }
    } catch { /* session store unavailable */ }
    return added;
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

  async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('请求体过大（上限 2MB）');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  }

  // ---------- HTTP API (for the client settings panel) ----------
  //
  // dsh 0.2 mounts dsh-host-webserver AFTER plugin rows apply, so reading
  // `ctx.webServer` once during apply yields undefined and the route is never
  // registered — silently, with no error anywhere. The supported shape is to
  // attach through `ctx.inject(['webServer'], cb)`, which runs immediately when
  // the service already exists and later when it appears. WebServer is
  // deliberately not in this plugin's `inject` list (see the top of this file):
  // that would hold the whole plugin pending in a composition with no web
  // server, while its tools are perfectly usable there.
  const panelRoutes = {
    handler: async (req, res) => {
      // browser-trust fence first: Host must be loopback, cross-site requests
      // (sec-fetch-site=cross-site) and foreign Origins are refused with 403,
      // mirroring dsh's own /api fence (see isTrustedPanelRequest).
      if (denyIfUntrusted(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const is = (p, m) => url.pathname === `${routePath}${p}` && req.method === m;
      try {
        // GET /list — the skill library (all user skills) + presets + stats
        if (is('/list', 'GET')) {
          const [active, preset, workspaces] = await Promise.all([
            scanDir(skillsRoot()),
            scanPresetSkills(),
            listWorkspaces(),
          ]);
          const skills = active.map(summarize).concat(preset.map(summarize));
          sendJson(res, 200, {
            ok: true,
            skills,
            stats: {
              total: skills.length,
              globalEnabled: active.length,
              globalDisabled: 0,
              preset: preset.length,
              workspaceCount: workspaces.filter((w) => w.exists).length,
              currentCwd: workspaces[0]?.cwd ?? '',
            },
          });
          return;
        }
        // GET /get?name=&cwd= — full content (library or workspace)
        if (is('/get', 'GET')) {
          const name = url.searchParams.get('name') ?? '';
          const cwd = url.searchParams.get('cwd') ?? '';
          const entry = await findSkillIn(name, cwd);
          if (!entry) { sendJson(res, 404, { ok: false, error: `skill ${name} not found` }); return; }
          sendJson(res, 200, { ok: true, skill: entry });
          return;
        }
        // GET /skill-files?name=&cwd= — file tree for a directory-form skill
        if (is('/skill-files', 'GET')) {
          const name = url.searchParams.get('name') ?? '';
          const cwd = url.searchParams.get('cwd') ?? '';
          const result = await listSkillFiles(name, cwd);
          sendJson(res, 200, result);
          return;
        }
        // GET /skill-file?name=&path=&cwd= — read one file inside a dir-form skill
        if (is('/skill-file', 'GET')) {
          const name = url.searchParams.get('name') ?? '';
          const relPath = url.searchParams.get('path') ?? '';
          const cwd = url.searchParams.get('cwd') ?? '';
          const result = await readSkillFile(name, relPath, cwd);
          sendJson(res, 200, result);
          return;
        }
        // POST /skill-file — { name, path, content, cwd? } write one file
        // Write-side: cwd must be a registered workspace.
        if (is('/skill-file', 'POST')) {
          const body = await readJsonBody(req);
          if (body.cwd) {
            const gate = await assertRegisteredWorkspace(String(body.cwd));
            if (!gate.ok) { sendJson(res, 403, { ok: false, error: gate.error }); return; }
          } else {
            sendJson(res, 403, { ok: false, error: 'cwd required for file writes' });
            return;
          }
          const result = await writeSkillFile(body.name, body.path, body.content, body.cwd);
          sendJson(res, 200, result);
          return;
        }
        // POST /enable | /disable — { name }
        if (is('/enable', 'POST') || is('/disable', 'POST')) {
          const body = await readJsonBody(req);
          const enable = url.pathname.endsWith('/enable');
          const result = await setSkillEnabled(body.name, enable);
          sendJson(res, 200, result);
          return;
        }
        // POST /delete — { name }
        if (is('/delete', 'POST')) {
          const body = await readJsonBody(req);
          const result = await deleteSkill(body.name);
          sendJson(res, 200, result);
          return;
        }
        // POST /import — raw zip body upload (capped against zip bombs)
        if (is('/import', 'POST')) {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 50 * 1024 * 1024) { sendJson(res, 413, { ok: false, error: 'zip 超过 50MB 上传上限' }); return; }
            chunks.push(chunk);
          }
          const result = await importSkillZipFromBuffer(Buffer.concat(chunks));
          sendJson(res, 200, result);
          return;
        }
        // POST /import/batch — { items: [...] } validate + write each
        // (directory form carries base64 file payloads, so the JSON body may
        // be large; the 100MB cap mirrors the zip importer's expand limit).
        if (is('/import/batch', 'POST')) {
          const body = await readJsonBody(req, 100 * 1024 * 1024);
          const result = await importSkillDocs(body?.items);
          sendJson(res, 200, result);
          return;
        }
        // GET /search?q=&cwd=&sessionId= — cross-layer skill search
        // (name/desc/whenToUse/body). The resolved cwd marks every match with
        // its wsEnabled state so the search UI can toggle enablement.
        if (is('/search', 'GET')) {
          const q = url.searchParams.get('q') ?? '';
          const cwd = await resolveSessionCwd(url.searchParams.get('sessionId') ?? '', url.searchParams.get('cwd') ?? '');
          sendJson(res, 200, await searchSkills(q, cwd));
          return;
        }
        // GET /view?cwd=&sessionId= — full layered view (global/workspace/preset/session)
        // Any resolved cwd is auto-registered so the panel's picker keeps
        // growing with the workspaces actually used — no manual "register".
        // The response also carries the full workspaces list so the picker
        // reflects the just-registered cwd without a second round-trip.
        if (is('/view', 'GET')) {
          const cwd = await resolveSessionCwd(url.searchParams.get('sessionId') ?? '', url.searchParams.get('cwd') ?? '');
          const sessionId = url.searchParams.get('sessionId') ?? '';
          let workspaces = [];
          // top up the registry with every cwd from the session store so the
          // picker never misses workspaces whose panel was not opened yet
          try { await registerAllSessionCwds(); } catch { /* non-fatal */ }
          if (cwd) {
            try { await registerWorkspace(cwd); } catch { /* non-fatal */ }
          }
          try { workspaces = await listWorkspaces(); } catch { /* non-fatal */ }
          // v4.2 engine-visibility: the native skills registry as the "what the
          // engine actually loads" reference, annotated per skill. Resolved
          // through the session's own preset scope (see resolveSessionSkillsView)
          // because a scope-less read cannot see project skills at all in 0.2.
          const [viewData, engineLoaded] = await Promise.all([
            sessionSkillView(sessionId, cwd),
            collectEngineLoaded(resolveSessionSkillsView(sessionId), cwd),
          ]);
          viewData.skills = viewData.skills.map((s) => ({
            ...s,
            engineState: engineLoadState(s, engineLoaded),
            ...(engineLoaded ? (() => { const hit = engineLoaded.find((e) => e.name === s.name); return hit ? { engineSource: hit.source } : {}; })() : {}),
          }));
          viewData.engineLoaded = engineLoaded;
          sendJson(res, 200, { ok: true, version: PKG_VERSION, workspaces, ...viewData });
          return;
        }
        // GET /unmanaged — engine-loadable skills outside the library
        if (is('/unmanaged', 'GET')) {
          sendJson(res, 200, { ok: true, items: await listUnmanagedSkills() });
          return;
        }
        // POST /unmanaged/import — adopt them all into the library
        if (is('/unmanaged/import', 'POST')) {
          sendJson(res, 200, await importUnmanagedSkills());
          return;
        }
        // POST /workspace/toggle — { cwd, name, enable }
        if (is('/workspace/toggle', 'POST')) {
          const body = await readJsonBody(req);
          const cwd = String(body.cwd ?? '');
          const name = String(body.name ?? '');
          const gate = await assertRegisteredWorkspace(cwd);
          if (!gate.ok) { sendJson(res, 403, { ok: false, error: gate.error }); return; }
          const result = body.enable
            ? await linkGlobalSkillToWorkspace(gate.cwd, name)
            : await unlinkGlobalSkillFromWorkspace(gate.cwd, name);
          sendJson(res, 200, { ok: result.ok, ...(result.error ? { error: result.error } : { name: result.name }) });
          return;
        }
        // GET /workspaces — known workspaces with existence + enabled skills
        if (is('/workspaces', 'GET')) {
          try { await registerAllSessionCwds(); } catch { /* non-fatal */ }
          sendJson(res, 200, { ok: true, workspaces: await listWorkspaces() });
          return;
        }
        // POST /workspace/register — { cwd } remember a workspace for the panel
        if (is('/workspace/register', 'POST')) {
          const body = await readJsonBody(req);
          const result = await registerWorkspace(String(body.cwd ?? ''));
          sendJson(res, 200, result);
          return;
        }
        // POST /workspace/rebind — { oldCwd, newCwd } after a folder rename:
        // migrate the registry key and any session configs pointing at oldCwd.
        if (is('/workspace/rebind', 'POST')) {
          const body = await readJsonBody(req);
          const result = await renameWorkspace(String(body.oldCwd ?? ''), String(body.newCwd ?? ''));
          sendJson(res, 200, result);
          return;
        }
        // POST /workspace/forget — { cwd } forget registry entry + orphan
        // session configs. Never touches the workspace directory itself.
        if (is('/workspace/forget', 'POST')) {
          const body = await readJsonBody(req);
          const result = await forgetWorkspace(String(body.cwd ?? ''));
          sendJson(res, 200, result);
          return;
        }
        // POST /session/set — { sessionId, cwd?, enabled?: [], explicit?: bool }
        if (is('/session/set', 'POST')) {
          const body = await readJsonBody(req);
          const sessionId = String(body.sessionId ?? '');
          if (!isValidIdentifier(sessionId)) { sendJson(res, 400, { ok: false, error: 'sessionId 非法' }); return; }
          // Resolve the workspace for this session: the client's cwd wins when it
          // has one, then the live session, then the session's DURABLE header
          // (sessionPersistence.stat), then this session's saved plugin state.
          //
          // The durable step is what keeps a just-opened session writable: the
          // panel learns cwd from /view, and for a session the process has not
          // loaded into memory that read used to resolve to '' — so every toggle
          // posted cwd:"" and died here, a 400 whose one-line notice reads to the
          // user as "clicking does nothing".
          const cwd = await resolveSessionCwd(sessionId, String(body.cwd ?? ''));
          if (!isAbsolutePath(cwd)) { sendJson(res, 400, { ok: false, error: 'cwd 必须为工作区绝对路径' }); return; }
          const result = await setSessionSkills(sessionId, cwd, body.enabled, body.explicit === true);
          sendJson(res, 200, result);
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: errMsg(err) });
      }
    },
  };
  let panelApiRegistered = false;
  function registerPanelApi(webServer) {
    if (panelApiRegistered || !webServer || typeof webServer.register !== 'function') return;
    panelApiRegistered = true;
    const unregisterRoute = webServer.register({ kind: 'prefix', path: routePath, handler: panelRoutes.handler });
    // Teardown MUST go through ctx.effect. dsh 0.2 has no 'dispose' event at all
    // (grep the runtime: zero occurrences of on('dispose' / emit("dispose") —
    // cordis reports teardown as the internal 'internal/plugin' event), so the
    // old ctx.on('dispose', …) never ran. That was not merely a leak: the
    // webServer contract says a duplicate (kind, path) registration THROWS, so
    // the first plugin reload / re-enable would have re-registered this route
    // and thrown inside apply, killing the whole plugin on that load.
    ctx.effect(() => unregisterRoute, 'skill-manager: panel API route');
    try {
      // "silent skip is the most expensive failure mode": say so when the route
      // is live, so "the panel shows nothing" is never a no-log symptom.
      ctx.logger?.info?.('skill-manager: panel API registered on %s', routePath);
    } catch { /* logging is best-effort */ }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (child) => registerPanelApi(child.webServer));
    } catch { /* no scoped injection on this runtime */ }
  }
  // Runtimes where webServer is already mounted when apply() runs.
  registerPanelApi(typeof ctx.get === 'function' ? ctx.get('webServer') : undefined);
  // Drop the module-level closure over this fiber's ctx on teardown: a stale
  // provider would keep reading disposed services on the next apply().
  ctx.effect(() => () => {
    presetCatalogProvider = null;
    presetRootsOverride = null;
  }, 'skill-manager: preset catalog source');

  // ---------- model-facing tools ----------
  registerTool({
    name: 'skill_manager_list',
    description: '列出技能库中全部技能（含 preset 捆绑技能），返回名称、描述与文件长度。技能是否在工作区生效请查看 skill_manager_workspace_list。管理技能生命周期时先用它探测。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: formatList(value) }],
    },
    isConcurrencySafe: () => true,
    execute: async () => {
      const [active, preset] = await Promise.all([scanDir(skillsRoot()), scanPresetSkills()]);
      const skills = active.map(summarize).concat(preset.map(summarize))
        .sort((a, b) => (a.origin === b.origin ? a.name.localeCompare(b.name) : a.origin === 'user' ? -1 : 1));
      const byOrigin = (o) => skills.filter((s) => s.origin === o).length;
      return {
        skills,
        stats: {
          library: active.length,
          user: active.length,
          preset: preset.length,
        },
        note: `技能库：${active.length} 个用户技能 + ${preset.length} 个 preset 捆绑。启用按工作区决定（见 skill_manager_workspace_list / workspace_toggle）。库目录 ${skillsRoot()}`,
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
    description: '修改磁盘上的技能：合并写入 frontmatter（name/description/whenToUse 等）与正文 body，直接写回技能目录的 SKILL.md。',
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
    name: 'skill_manager_delete',
    description: '从技能库永久删除一个技能（技能目录，含参考文件）。删除前请先 skill_manager_get 确认内容。',
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
    description: '从本地 zip 文件导入技能包到技能库：zip 根目录须包含 SKILL.md（frontmatter 声明 kebab-case name），附属文件（reference/、assets/ 等）一并还原。库为纯技能池，是否在工作区生效另行勾选。',
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
        return { ok: false, error: errMsg(err) };
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
      if (!isAbsolutePath(cwd)) return { ok: false, error: 'cwd 必须为工作区绝对路径' };
      const skills = await listWorkspaceSkills(cwd);
      return { ok: true, cwd, skills, count: skills.length };
    },
  });

  registerTool({
    name: 'skill_manager_workspace_toggle',
    description: '在工作区（cwd）启用或停用一个全局技能：启用=在 <cwd>/.dsh/skills 建指向全局源的 link（单副本，全局演进自动同步）；停用=删除该 link。项目无 link 默认不启用任何全局技能（preset 技能除外）。cwd 需已在注册表登记（见 skill_manager_workspace_register）；未登记请先登记。',
    parameters: {
      cwd: { type: 'string', required: true, description: '工作区绝对路径（需已登记）' },
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
    execute: async (args) => {
      const cwd = String(args.cwd ?? '');
      if (cwd && !isAbsolutePath(cwd)) return { ok: false, error: 'cwd 必须为工作区绝对路径' };
      return sessionSkillView(String(args.sessionId ?? ''), cwd);
    },
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
    description: '列出已登记的工作区（workspaces.json 注册表）及各自启用的技能。只保留存在的工作区：目录被删除/改名后，下一次读取会自动从注册表清理该失效路径（管理器只跟踪活跃工作区）。',
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

  registerTool({
    name: 'skill_manager_adopt_unmanaged',
    description: '扫描引擎与项目技能源（~/.dsh/skills、~/.agents/skills、各工作区 .agents/skills 及 .dsh/skills 中的本地产技能）中尚未纳入技能库的技能：复制进库；引擎加载根副本随后移除（否则绕过工作区白名单、在所有会话全局生效），工作区白名单本地产副本保留（该工作区保持启用）。库中已存在的同名技能保留库版本。返回导入/移除/失败清单。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: value.error ?? 'error' }];
        const lines = [];
        if (value.imported?.length) lines.push(`导入库：${value.imported.join(', ')}`);
        if (value.removed?.length) lines.push(`移除引擎根副本：${value.removed.join(', ')}`);
        if (value.failed?.length) lines.push(`失败：${value.failed.join(', ')}`);
        if (!value.imported?.length && !value.removed?.length && !value.failed?.length) lines.push('引擎源里没有游离技能。');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => false,
    execute: async () => importUnmanagedSkills(),
  });

  // ---------- host service façade ----------
  // Other Cordis plugins can `inject: ['skillManager']` to read/operate the
  // skill library, workspace whitelists and session selections without going
  // through HTTP or model tools. Every method is a direct passthrough of the
  // module-level function with the same semantics (never throws; returns
  // { ok, ... } / arrays as documented on the function).
  ctx.provide('skillManager', {
    list: async () => {
      const [active, preset] = await Promise.all([scanDir(skillsRoot()), scanPresetSkills()]);
      return { skills: active.map(summarize).concat(preset.map(summarize)), stats: { library: active.length, preset: preset.length } };
    },
    get: async (name, cwd) => {
      const e = await findSkillIn(name, cwd);
      return e
        ? { ok: true, skill: { name: e.name, description: e.description, whenToUse: e.whenToUse, body: e.body, frontmatter: e.frontmatter, dir: e.dir } }
        : { ok: false, error: `skill ${name} not found` };
    },
    edit: editSkill,
    deleteSkill,
    importZip: async (buf) => importSkillZipFromBuffer(buf),
    importDocs: async (items) => importSkillDocs(items),
    search: async (q, cwd) => searchSkills(q, cwd),
    workspaces: () => listWorkspaces(),
    registerWorkspace,
    renameWorkspace,
    forgetWorkspace,
    workspaceList: (cwd) => listWorkspaceSkills(cwd),
    workspaceToggle: (cwd, name, enable) => (enable
      ? linkGlobalSkillToWorkspace(cwd, name)
      : unlinkGlobalSkillFromWorkspace(cwd, name)),
    sessionView: sessionSkillView,
    sessionSet: setSessionSkills,
    unmanaged: () => listUnmanagedSkills(),
    adoptUnmanaged: () => importUnmanagedSkills(),
  });

  return {};
}

function formatList(value) {
  if (!value?.skills?.length) return '技能目录为空。';
  const lines = value.skills.map((s) => {
    const flag = s.origin === 'preset' ? '📦' : '📚';
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
  return workspaces.map((w) => `  ${w.cwd} — ✅ 存在（启用 ${w.enabledCount} 个：${w.enabled.join(', ') || '无'}）`).join('\n');
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
  // workspace-enabled names are derivable from the merged skill rows, so the
  // view response no longer carries a redundant workspaceEnabled copy
  const wsNames = value.skills.filter((s) => s.layer === 'workspace').map((s) => s.name);
  return `会话 ${value.session.id ?? '(无)'} 技能视图（cwd=${value.session.cwd || '(未指定)'}，模式：${mode}）：\n`
    + (lines.join('\n') || '  （无技能）')
    + `\n工作区已启用：${wsNames.join(', ') || '（无）'}`;
}

export { inject, skillsRoot, disabledRoot, migrateLegacySkills, normalizeSkillDirs, parseSkillDoc, serializeSkillDoc, validSkillFileName, scanDir, summarize, findSkill, listSkillFiles, readSkillFile, writeSkillFile, searchSkills, editSkill, setSkillEnabled, deleteSkill, importSkillZipFromBuffer, importSkillDocs, formatList, formatWorkspaceList, formatWorkspaceRegistry, formatSessionView, listWorkspaceSkills, linkGlobalSkillToWorkspace, unlinkGlobalSkillFromWorkspace, sessionSkillView, setSessionSkills, readSessionConfig, listWorkspaces, registerWorkspace, renameWorkspace, forgetWorkspace, agentsHomeDir, scanSkillSources, listUnmanagedSkills, importUnmanagedSkills, isAbsolutePath, samePath, errMsg, bareSkillName, engineLoadState, collectEngineLoaded, isTrustedPanelRequest };
