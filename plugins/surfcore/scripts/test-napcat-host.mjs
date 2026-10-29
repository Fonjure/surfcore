// End-to-end plugin routes using only fake local bridge/OneBot servers and a temporary DSH home.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-napcat-host-'));
const root = path.join(tmp, 'root');
const dsh = path.join(tmp, 'dsh');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(dsh, 'surfcore'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'bridge.js'), '// isolated fixture\n');
fs.writeFileSync(path.join(root, 'Start-NapCat.ps1'), '# fixture; never executed\n');
fs.writeFileSync(path.join(dsh, 'surfcore', 'config.json'), JSON.stringify({
  platforms: { start: { qq: true, bili: false } }, bridge: { startupNotify: false },
}));
const token = 'fixture-napcat-secret';
const apiServer = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
  const data = req.url === '/get_login_info' ? { user_id: 10001, nickname: 'fixture' }
    : req.url === '/get_status' ? { online: true, good: true }
      : req.url === '/get_group_list' ? [{ group_id: 100004, group_name: 'fixture group' }] : null;
  res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: data ? 'ok' : 'failed', retcode: data ? 0 : 1, data }));
});
const wsServer = net.createServer((socket) => socket.end());
const bridgeServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ root, dshBaseUrl: 'http://127.0.0.1:1', dshReady: true, snowluma: { connected: false, accountOnline: true } }));
});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await Promise.all([listen(apiServer), listen(wsServer), listen(bridgeServer)]);
const qqConfigPath = path.join(root, 'config.json');
fs.writeFileSync(qqConfigPath, JSON.stringify({
  consolePort: bridgeServer.address().port,
  snowluma: { httpUrl: `http://127.0.0.1:${apiServer.address().port}`, wsUrl: `ws://127.0.0.1:${wsServer.address().port}`, accessToken: token },
  napcat: { allowLaunch: true, launchScript: 'Start-NapCat.ps1' },
  ownerQQ: '10002', allow: { private: ['10002'], groups: [] },
}));
process.env.SURFCORE_ROOT = root;
process.env.DSH_HOME = dsh;
process.env.USERPROFILE = tmp;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';

const { apply } = await import('../lib/index.js');
const routes = [];
const effects = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { return name === 'connection' ? { requestRejection: () => false } : null; },
  effect(fn) { effects.push(fn); },
  sessionController: { inspect: async () => ({ events: [] }), create: async () => ({}), prompt: async () => ({ accepted: true }) },
};
function req(method, url, body) {
  const input = new EventEmitter();
  input.method = method; input.url = url;
  input.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}) };
  if (body) process.nextTick(() => { input.emit('data', Buffer.from(JSON.stringify(body))); input.emit('end'); });
  return input;
}
async function invoke(route, method, suffix, body) {
  const output = { statusCode: 200, body: '', writeHead(code) { this.statusCode = code; }, end(data = '') { this.body += data; } };
  await route.handler(req(method, `/dsh-surfcore/api/${suffix}`, body), output);
  return { status: output.statusCode, data: JSON.parse(output.body || '{}') };
}

try {
  apply(ctx);
  const route = routes.find((item) => item.path === '/dsh-surfcore/api');
  assert.ok(route);
  const before = fs.readFileSync(qqConfigPath, 'utf8');
  const overview = await invoke(route, 'GET', 'overview');
  assert.equal(overview.data.napcat.diagnosis.state, 'bridge-disconnected');
  assert.equal(overview.data.napcat.diagnosis.accountOnline, true);
  assert.ok(!JSON.stringify(overview.data.napcat).includes(token));
  const detect = await invoke(route, 'POST', 'bridge', { action: 'detect-napcat' });
  assert.equal(detect.data.found, true);
  const started = await invoke(route, 'POST', 'bridge', { action: 'start-qq' });
  assert.equal(started.data.bridge.already, true, 'already-running bridge must not prevent the gateway action');
  assert.equal(started.data.napcat.skipped, true, 'fixture must not start real NapCat');
  const all = await invoke(route, 'POST', 'bridge', { action: 'start-all' });
  assert.equal(all.data.napcat.skipped, true);
  assert.equal(all.data.scheduler.disabled, true);
  const scan = await invoke(route, 'POST', 'diagnostics', { action: 'install-scan' });
  assert.equal(scan.data.ok, true);
  assert.equal(scan.data.groups.length, 1);
  assert.ok(!JSON.stringify(scan.data).includes(token));
  assert.equal(fs.readFileSync(qqConfigPath, 'utf8'), before, 'scan/detect/start must not rewrite configuration');
  console.log('NapCat host route fixtures OK');
} finally {
  for (const effect of effects) { try { effect()?.(); } catch {} }
  await Promise.all([apiServer, wsServer, bridgeServer].map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(tmp, { recursive: true, force: true });
}
