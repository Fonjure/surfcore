// Isolated loopback fixtures only: no real QQ account, config, launcher or message sends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { diagnoseNapCat, findNapCatLauncher, launchNapCat, napcatGroups } from '../lib/napcat.js';
import { bridgeHarness } from '../../../scripts/audit-bridge-harness.mjs';

const token = 'fixture-token-not-a-real-secret';
let accountOnline = true;
let httpError = false;
const api = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
  if (httpError) { res.writeHead(500); res.end(); return; }
  const data = req.url === '/get_login_info' ? { user_id: 10001, nickname: 'fixture' }
    : req.url === '/get_status' ? { online: accountOnline, good: accountOnline }
      : req.url === '/get_group_list' ? [{ group_id: 100004, group_name: 'fixture group' }] : null;
  res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: data ? 'ok' : 'failed', retcode: data ? 0 : 1, data }));
});
const ws = net.createServer((socket) => socket.end());
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
await Promise.all([listen(api), listen(ws)]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-napcat-'));
const launcher = path.join(tmp, 'Start-NapCat.ps1');
fs.writeFileSync(launcher, '# isolated fixture\n');
const config = { httpUrl: `http://127.0.0.1:${api.address().port}`, wsUrl: `ws://127.0.0.1:${ws.address().port}`, accessToken: token };
const connected = { running: true, snowluma: { connected: true } };
const previousSkip = process.env.SURFCORE_SKIP_AUTOSTART;
delete process.env.SURFCORE_SKIP_AUTOSTART;
try {
  let result = await diagnoseNapCat({ config, bridge: connected });
  assert.equal(result.state, 'ok');
  assert.equal(result.accountOnline, true);
  assert.equal(result.ws.state, 'listening');
  assert.ok(!JSON.stringify(result).includes(token), 'diagnostics must not expose token');
  assert.deepEqual(await napcatGroups(config), [{ id: '100004', name: 'fixture group' }]);

  result = await diagnoseNapCat({ config, bridge: { running: true, snowluma: { connected: false } } });
  assert.equal(result.state, 'bridge-disconnected');
  accountOnline = false;
  result = await diagnoseNapCat({ config, bridge: connected });
  assert.equal(result.state, 'account-offline');
  let runs = 0;
  result = await launchNapCat({ root: tmp, config, bridge: connected, run: async () => { runs++; return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(runs, 0, 'an existing offline process must not be started twice');
  accountOnline = true;

  result = await diagnoseNapCat({ config: { ...config, accessToken: 'wrong' }, bridge: connected });
  assert.equal(result.state, 'unauthorized');
  result = await launchNapCat({ root: tmp, config: { ...config, accessToken: 'wrong' }, bridge: connected,
    run: async () => { runs++; return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(runs, 0, 'wrong token must not start another account');
  result = await launchNapCat({ root: tmp, config, bridge: connected, run: async () => { runs++; return { ok: true }; } });
  assert.equal(result.already, true);
  assert.equal(runs, 0, 'online gateway must not be started twice');
  assert.equal(findNapCatLauncher(tmp), launcher);
  assert.equal(findNapCatLauncher(tmp, { launchScript: 'wrong.cmd' }), null);

  await close(ws);
  result = await diagnoseNapCat({ config, bridge: connected });
  assert.equal(result.state, 'ws-unavailable');
  result = await launchNapCat({ root: tmp, config, bridge: connected, run: async () => { runs++; return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(runs, 0, 'HTTP up and WS down must not cause a duplicate process');
  httpError = true;
  result = await diagnoseNapCat({ config, bridge: connected });
  assert.equal(result.state, 'http-error', 'an HTTP error response must not be called an absent process');
  result = await launchNapCat({ root: tmp, config, bridge: connected, run: async () => { runs++; return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(runs, 0, 'an occupied HTTP port returning an error must not cause a duplicate process');
  await close(api);
  result = await diagnoseNapCat({ config, bridge: {} });
  assert.equal(result.state, 'not-running');
  result = await diagnoseNapCat({ config: { ...config, httpUrl: `${config.httpUrl}/?token=${token}` }, bridge: {} });
  assert.equal(result.state, 'invalid-config');
  assert.ok(!JSON.stringify(result).includes(token));

  if (process.platform === 'win32') {
    const offline = { state: 'not-running', http: { state: 'unavailable' }, ws: { state: 'closed' }, accountOnline: null, hint: 'offline' };
    const online = { state: 'bridge-disconnected', http: { state: 'ok' }, ws: { state: 'listening' }, accountOnline: true, hint: 'connecting' };
    let current = offline;
    result = await launchNapCat({ root: tmp, config, diagnose: async () => current, run: async (file) => {
      assert.equal(file, launcher); runs++; current = online; return { ok: true };
    } });
    assert.equal(result.started, true);
    assert.equal(runs, 1);
    current = offline;
    result = await launchNapCat({ root: tmp, config, napcat: { allowLaunch: false }, diagnose: async () => current,
      run: async () => { runs++; return { ok: true }; } });
    assert.equal(result.ok, false);
    assert.equal(runs, 1);
    result = await launchNapCat({ root: tmp, config, diagnose: async () => current,
      run: async () => { runs++; return { ok: false }; } });
    assert.equal(result.ok, false, 'a failed launcher must not report success');

    // Exercise the real Windows process invocation with a fixture script and a path containing spaces/Chinese.
    const unicodeDir = path.join(tmp, '测试 空格');
    fs.mkdirSync(unicodeDir);
    const unicodeScript = path.join(unicodeDir, 'gateway.ps1');
    const marker = path.join(unicodeDir, 'ran.txt');
    fs.writeFileSync(unicodeScript, `\uFEFF[IO.File]::WriteAllText('${marker.replace(/'/g, "''")}', 'fixture')\r\n`);
    let calls = 0;
    result = await launchNapCat({ root: tmp, config, napcat: { launchScript: unicodeScript },
      diagnose: async () => (++calls === 1 ? offline : online) });
    assert.equal(result.started, true);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'fixture');
  }
  const defaultBridge = await bridgeHarness();
  try { assert.equal(defaultBridge.cfg.qqGateway, 'napcat', 'existing configs must use NapCat isolation by default'); }
  finally { await defaultBridge.close(); }
  const legacyBridge = await bridgeHarness({ config: { qqGateway: 'snowluma' } });
  try { assert.equal(legacyBridge.cfg.qqGateway, 'snowluma', 'legacy mode must remain explicit'); }
  finally { await legacyBridge.close(); }
  console.log('NapCat diagnostic and start fixtures OK');
} finally {
  if (previousSkip === undefined) delete process.env.SURFCORE_SKIP_AUTOSTART;
  else process.env.SURFCORE_SKIP_AUTOSTART = previousSkip;
  if (api.listening) await close(api);
  if (ws.listening) await close(ws);
  fs.rmSync(tmp, { recursive: true, force: true });
}
