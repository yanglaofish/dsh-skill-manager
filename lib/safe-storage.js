import { open, readFile, writeFile, mkdir, rename, unlink, rm, mkdtemp, realpath, lstat, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const heldLocks = new AsyncLocalStorage();
export async function withManagerLock(root, action) {
  await mkdir(root, { recursive: true });
  const canonical = await realpath(root);
  if (heldLocks.getStore()?.has(canonical)) return action();
  const lockPath = join(canonical, '.write.lock');
  const deadline = Date.now() + 20000;
  let handle;
  while (!handle) {
    try { handle = await open(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new Error(`等待技能库写锁超时：${lockPath}。若持锁进程已退出，请确认后移除该锁文件再重试。`);
      await delay(20);
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await heldLocks.run(new Set([...(heldLocks.getStore() ?? []), canonical]), action);
  } finally { await handle.close(); await unlink(lockPath); }
}

export async function atomicWrite(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function skillFilePath(root, rel) {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error('仅允许技能目录内的相对路径');
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':') || part.includes('\0'))) throw new Error('非法技能文件路径');
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, ...parts);
  if (!isInside(canonicalRoot, target)) throw new Error('文件路径超出技能目录');
  // 实际目标和父目录均验证，防止中间 junction 或文件软链接越界。
  const parent = await realpath(dirname(target));
  if (parent !== canonicalRoot && !isInside(canonicalRoot, parent)) throw new Error('目录链接超出技能目录');
  try {
    const actual = await realpath(target);
    if (!isInside(canonicalRoot, actual)) throw new Error('文件链接超出技能目录');
    return actual;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

// 备份放在目标同一文件系统内，rename 失败时不需要跨盘恢复。
export async function backupEntry(target) {
  let parent;
  try { parent = await realpath(dirname(target)); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const resolved = join(parent, basename(target));
  if (!isInside(parent, resolved)) throw new Error('备份目标不在预期目录内');
  try { await lstat(resolved); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const backupRoot = join(parent, '.skm-backups');
  await mkdir(backupRoot, { recursive: true });
  if (await realpath(backupRoot) !== backupRoot) throw new Error('备份目录不能是外部链接');
  const backup = join(backupRoot, `${basename(target)}-${Date.now()}-${randomUUID()}`);
  await rename(resolved, backup);
  return backup;
}

export async function replaceDirectory(target, populate) {
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const destination = join(parent, basename(target));
  if (!isInside(parent, destination)) throw new Error('替换目标不在预期目录内');
  // 扫描根的上一级仍在本地目录树内，原生 provider 不会提前发现准备中的技能。
  const stage = await mkdtemp(join(dirname(parent), '.skm-stage-'));
  let backup;
  try {
    await populate(stage);
    backup = await backupEntry(destination);
    try { await rename(stage, destination); }
    catch (error) {
      if (backup) await rename(backup, destination).catch((rollback) => {
        throw new Error(`替换失败且回滚失败，原版本保留于 ${backup}：${rollback.message}`);
      });
      throw error;
    }
    return backup;
  } finally {
    // stage 来自本次 mkdtemp，仅清理本操作创建的临时目录。
    await rm(stage, { recursive: true, force: true });
  }
}

export async function sameDirectoryContent(a, b) {
  const left = await readdir(a, { withFileTypes: true });
  const right = await readdir(b, { withFileTypes: true });
  if (left.length !== right.length) return false;
  for (const entry of left) {
    const other = right.find((candidate) => candidate.name === entry.name);
    if (!other || entry.isSymbolicLink() || other.isSymbolicLink()) return false;
    const x = join(a, entry.name), y = join(b, entry.name);
    if (entry.isDirectory() && other.isDirectory()) { if (!await sameDirectoryContent(x, y)) return false; }
    else if (entry.isFile() && other.isFile()) { if (!(await readFile(x)).equals(await readFile(y))) return false; }
    else return false;
  }
  return true;
}
