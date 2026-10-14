import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('单测全程不移动用户 agents 目录里的技能', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'skm-isolation-'));
  const sentinel = join(fakeHome, '.agents', 'skills', 'user-owned', 'SKILL.md');
  const content = '---\nname: user-owned\ndescription: 用户原始技能\n---\n保留正文';
  try {
    await mkdir(join(fakeHome, '.agents', 'skills', 'user-owned'), { recursive: true });
    await writeFile(sentinel, content);
    let failure;
    try {
      await promisify(execFile)(process.execPath, [
        '--require', fileURLToPath(new URL('./helpers/isolated-home.cjs', import.meta.url)),
        fileURLToPath(new URL('./unit.mjs', import.meta.url)),
      ], { env: { ...process.env, SKM_TEST_HOME: fakeHome }, windowsHide: true });
    } catch (error) { failure = error; }
    assert.equal(await readFile(sentinel, 'utf8').catch(() => null), content, '测试不应收纳或删除用户原始技能');
    assert.equal(failure, undefined, '隔离后的单测应全部通过');
  } finally {
    // fakeHome 由 mkdtemp 独立创建，仅清理这个测试目录。
    await rm(fakeHome, { recursive: true, force: true });
  }
});
