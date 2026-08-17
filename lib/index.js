// dsh-skill-manager — Skill lifecycle manager (host half)
// Manages the user skill directory on disk: list / view / edit / import(zip) /
// delete / enable / disable. Disabled skills are moved out of the active
// skills root so the built-in filesystem skill provider (and its watcher)
// naturally stops advertising them.
import { readdir, readFile, writeFile, mkdir, rename, unlink, copyFile, stat } from 'node:fs/promises';
import { join, dirname, basename, extname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import AdmZip from 'adm-zip';

export const name = 'dsh-skill-manager';
const inject = ['tools', 'webServer'];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

// Active skills root and the disabled holding area.
function skillsRoot() {
  return join(dshHome(), 'skills');
}
function disabledRoot() {
  return join(dshHome(), 'skills-disabled');
}

// Parse a SKILL.md file into { frontmatter, body }.
function parseSkillDoc(raw) {
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
  return {
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    enabled: entry.enabled,
    fileName: entry.fileName,
    bodyLength: entry.body.length,
  };
}

// Validate a skill file name: kebab-case, .md.
function validSkillFileName(name) {
  return /^[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(name);
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

export function apply(ctx) {
  const routePath = '/skill-manager/api';

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
  ctx.webServer.register({
    kind: 'prefix',
    path: routePath,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        // GET /list — all skills with enabled state
        if (url.pathname === `${routePath}/list` && req.method === 'GET') {
          const [active, disabled] = await Promise.all([scanDir(skillsRoot()), scanDir(disabledRoot())]);
          sendJson(res, 200, { ok: true, skills: [...active, ...disabled].map(summarize) });
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
        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ---------- model-facing tools ----------
  ctx.tools.register({
    name: 'skill_manager_list',
    description: '列出用户技能目录中全部技能（含已禁用的），返回名称、描述、启用状态与文件长度。管理技能生命周期时先用它探测。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: formatList(value) }],
    },
    isConcurrencySafe: () => true,
    execute: async () => {
      const [active, disabled] = await Promise.all([scanDir(skillsRoot()), scanDir(disabledRoot())]);
      const skills = [...active, ...disabled].map(summarize);
      return { skills, note: `启用 ${active.length} 个，禁用 ${disabled.length} 个。目录：${skillsRoot()}` };
    },
  });

  ctx.tools.register({
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

  ctx.tools.register({
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

  ctx.tools.register({
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

  ctx.tools.register({
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

  ctx.tools.register({
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

  ctx.tools.register({
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

export { inject, skillsRoot, disabledRoot, parseSkillDoc, serializeSkillDoc, validSkillFileName, scanDir, readSkillEntry, summarize, findSkill, editSkill, setSkillEnabled, deleteSkill, importSkillZipFromBuffer, formatList };
