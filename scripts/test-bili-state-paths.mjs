/**
 * B站 工具链路径隔离：有角色时行为账本进角色包，凭证/表情包仍走账号目录。
 * 全部在临时 DSH_HOME 里跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bili-paths-'));
process.env.DSH_HOME = temp;
process.env.USERPROFILE = temp;
fs.mkdirSync(path.join(temp, 'surfcore', 'bili'), { recursive: true });

const store = await import('../src/character-persona.js');
const paths = await import(`../plugins/surfcore/tools/lib/state-paths.mjs?x=${Date.now()}`);

assert.equal(paths.biliStateDir(), path.join(temp, 'surfcore', 'bili'), '没有角色时回退账号目录');
assert.equal(paths.biliState('quota.json'), path.join(temp, 'surfcore', 'bili', 'quota.json'));
assert.equal(paths.accountBili('credentials.json'), path.join(temp, 'surfcore', 'bili', 'credentials.json'));

const character = store.createCharacter({ name: '角色甲', personaText: '# 卡' });
store.switchCharacter(character.character.id);
// state-paths 有 mtime 缓存；写指针后重新 import 一个新实例模拟新进程。
const paths2 = await import(`../plugins/surfcore/tools/lib/state-paths.mjs?x=${Date.now() + 1}`);
assert.equal(paths2.biliStateDir(), path.join(temp, 'surfcore', 'characters', character.character.id, 'bili'));
assert.equal(paths2.biliState('quota.json'), path.join(temp, 'surfcore', 'characters', character.character.id, 'bili', 'quota.json'));
assert.equal(paths2.accountBili('credentials.json'), path.join(temp, 'surfcore', 'bili', 'credentials.json'), '凭证不能进角色包');

// 真跑一条工具链命令：quota status 必须读角色自己的账本，而不是旧目录。
const today = new Date().toLocaleDateString('sv-SE');
fs.writeFileSync(paths2.biliState('quota.json'), JSON.stringify({
  date: today,
  log: [{ at: new Date().toISOString(), type: 'comment', target: 'BVtest', auto: true }],
}));
const out = execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'plugins', 'surfcore', 'tools', 'bili.mjs'), 'quota', 'status'], {
  env: { ...process.env, DSH_HOME: temp, USERPROFILE: temp },
  encoding: 'utf8',
  timeout: 30_000,
});
assert.match(out, /共 1 条/, `工具没有读到角色账本：${out.slice(0, 300)}`);

// 分享索引读取当前角色自己的账本；没有角色来源时仍兼容旧账号目录。
const { createBiliMemory, needsBiliMemoryRefresh } = await import('../src/bili-memory.js');
assert.equal(needsBiliMemoryRefresh({ memoryEnabled: false, shareEnabled: true, shareGroupCount: 1 }), true);
assert.equal(needsBiliMemoryRefresh({ memoryEnabled: false, shareEnabled: true, shareGroupCount: 0 }), false);
assert.equal(needsBiliMemoryRefresh({ memoryEnabled: false, shareEnabled: false, shareGroupCount: 1 }), false);
assert.equal(needsBiliMemoryRefresh({ memoryEnabled: false, shareEnabled: true, shareGroupCount: 1, platformEnabled: false }), false);
assert.equal(needsBiliMemoryRefresh({ memoryEnabled: true, shareEnabled: false, shareGroupCount: 0 }), true);

const roleDir = paths2.biliStateDir();
const legacyDir = path.join(temp, '.dsh', 'surfcore', 'bili');
const legacyOutput = path.join(temp, 'legacy-share-index');
fs.mkdirSync(legacyDir, { recursive: true });
fs.mkdirSync(legacyOutput, { recursive: true });
const roleBv = 'BV11aa22bb33';
const legacyBv = 'BV44cc55dd66';
const reason = '这个视频节奏轻松有趣，画面里的小鱼在海里游来游去，故事结尾也很惊喜。';
const makeScores = (bv) => ({ [today]: [{ bv, score: 15, reason, at: new Date().toISOString() }] });
fs.writeFileSync(path.join(roleDir, 'scores.json'), JSON.stringify(makeScores(roleBv)));
fs.writeFileSync(path.join(legacyDir, 'scores.json'), JSON.stringify(makeScores(legacyBv)));
const titleCache = { items: { [roleBv]: { title: '角色自己的测试视频' }, [legacyBv]: { title: '旧目录测试视频' } } };
fs.writeFileSync(path.join(roleDir, 'bili-video-titles.json'), JSON.stringify(titleCache));
fs.writeFileSync(path.join(legacyOutput, 'bili-video-titles.json'), JSON.stringify(titleCache));
const roleMemory = createBiliMemory({ home: temp, stateDir: roleDir, sourceDir: roleDir, log: () => {} });
assert.equal((await roleMemory.refresh({ force: true })).ok, true);
assert.equal(roleMemory.pickShareCard()?.bvid, roleBv, '角色分享池应使用当前角色的行为账本');
assert.equal(JSON.parse(fs.readFileSync(roleMemory.paths.index, 'utf8')).entries.some((entry) => entry.bvid === legacyBv), false, '旧账号账本不得串进当前角色');
const legacyMemory = createBiliMemory({ home: temp, stateDir: legacyOutput, log: () => {} });
assert.equal((await legacyMemory.refresh({ force: true })).ok, true);
assert.equal(legacyMemory.pickShareCard()?.bvid, legacyBv, '未指定角色来源时应继续读取旧账号账本');

try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
console.log('bili state paths tests OK');
