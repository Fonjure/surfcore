// 离线测试：所有发布入口遵守设置；分享评论提交账号映射，不请求真实 B站。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerMentionMapping } from '../plugins/surfcore/tools/lib/owner-mention.mjs';

assert.deepEqual(ownerMentionMapping({ name: '测试用户', mid: '123456' }), { 测试用户: 123456 });
for (const value of ['', '0', 'bad', '9007199254740992']) assert.throws(() => ownerMentionMapping({ name: '测试', mid: value }));
assert.throws(() => ownerMentionMapping({ name: '', mid: '123' }));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-share-routing-'));
try {
  const cfg = path.join(temp, 'bili.config.json');
  const home = path.join(temp, 'dsh');
  const env = { ...process.env, DSH_HOME: home, SURFCORE_BILI_CONFIG: cfg };
  const cmd = (...args) => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  fs.writeFileSync(cfg, JSON.stringify({ owner: { name: '测试用户', mid: '123456' }, share: { enabled: true, via: 'comment', minScore: 13 }, dynamics: { enabled: false } }));
  for (const args of [
    ['plugins/surfcore/tools/commands/dynamic.mjs', 'post', '--text', 'test', '--go'],
    ['plugins/surfcore/tools/commands/dynamic-image.mjs', '--image', 'missing.png', '--go'],
    ['plugins/surfcore/tools/commands/share-dynamic.mjs', '--bvid', 'BV1epXpBnE7o', '--text', 'test', '--score', '17', '--reason', '值得推荐给大家观看', '--go'],
  ]) {
    const r = cmd(...args);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /动态.*关闭/);
  }
  fs.writeFileSync(cfg, JSON.stringify({ share: { enabled: true, via: 'comment' }, dynamics: { enabled: true } }));
  const wrongVia = cmd('plugins/surfcore/tools/commands/share-dynamic.mjs', '--bvid', 'BV1epXpBnE7o', '--text', 'test', '--score', '17', '--reason', '值得推荐给大家观看', '--go');
  assert.equal(wrongVia.status, 3, wrongVia.stderr);
  assert.match(wrongVia.stderr, /动态分享已关闭/);
  fs.writeFileSync(cfg, JSON.stringify({ owner: { name: '测试用户', mid: '123456' }, share: { enabled: true, via: 'comment', minScore: 13 }, dynamics: { enabled: false } }));
  const forward = pathToFileURL(path.join(root, 'plugins/surfcore/tools/lib/forward.mjs')).href;
  const f = cmd('--input-type=module', '-e', `import {createForward} from ${JSON.stringify(forward)}; try { await createForward('1','x'); process.exit(4) } catch(e) { if (!e.message.includes('动态发布已关闭')) process.exit(5) }`);
  assert.equal(f.status, 0, f.stderr);
  fs.mkdirSync(path.join(home, 'surfcore', 'bili'), { recursive: true });
  fs.writeFileSync(path.join(home, 'surfcore', 'bili', 'credentials.json'), JSON.stringify({ sessdata: 'test', bili_jct: 'testcsrf', buvid3: 'test' }));
  const mock = path.join(temp, 'mock.mjs');
  fs.writeFileSync(mock, `globalThis.fetch = async (url, opts = {}) => { if (opts.method && opts.method !== 'GET') throw Error('unexpected network write'); return {json: async () => ({code: 0, data: {uname:'test', mid:1}})} }`);
  const c = cmd('--import', pathToFileURL(mock).href, 'plugins/surfcore/tools/commands/comment.mjs', '--oid', '123', '--bvid', 'BV1epXpBnE7o', '--message', '这条视频很有意思', '--share', '--auto', '--reason', '值得推荐给大家观看', '--score', '17', '--rank', '1', '--dry');
  assert.equal(c.status, 0, c.stderr + c.stdout);
  const body = c.stdout.match(/  body   : (.+)/)?.[1];
  assert.ok(body, c.stdout);
  const params = new URLSearchParams(body);
  assert.equal(params.get('message'), '@测试用户 这条视频很有意思');
  assert.deepEqual(JSON.parse(params.get('at_name_to_mid')), { 测试用户: 123456 });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('OK test-bili-share-routing');
