/** NapCat control uses the configured OneBot endpoints and a user-provided Windows launcher. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';

function endpoint(value, protocols) {
  try {
    const url = new URL(String(value ?? ''));
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(host)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function safeEndpoint(value, protocols) {
  const url = endpoint(value, protocols);
  return url ? url.toString().replace(/\/$/, '') : '未配置或不是本机地址';
}

function tcpOpen(url, timeoutMs) {
  if (!url) return Promise.resolve(false);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function onebotRequest(config, action, timeoutMs) {
  const url = endpoint(config?.httpUrl, ['http:', 'https:']);
  if (!url) return { ok: false, state: 'invalid' };
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${action}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config?.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) return { ok: false, state: 'unauthorized' };
    if (!response.ok) return { ok: false, state: 'error' };
    let body;
    try { body = await response.json(); } catch { return { ok: false, state: 'error' }; }
    if (body?.status !== 'ok' || body?.retcode !== 0) return { ok: false, state: 'error' };
    return { ok: true, state: 'ok', data: body.data };
  } catch { return { ok: false, state: 'unavailable' }; }
}

/** Read-only: TCP reachability, authenticated HTTP login/status, and bridge WS state are separate facts. */
export async function diagnoseNapCat({ config = {}, bridge = {}, timeoutMs = 1800 } = {}) {
  const httpUrl = endpoint(config.httpUrl, ['http:', 'https:']);
  const wsUrl = endpoint(config.wsUrl, ['ws:', 'wss:']);
  const [login, status, wsListening] = await Promise.all([
    onebotRequest(config, 'get_login_info', timeoutMs),
    onebotRequest(config, 'get_status', timeoutMs),
    tcpOpen(wsUrl, timeoutMs),
  ]);
  const online = typeof status.data?.online === 'boolean' ? status.data.online : null;
  const connected = bridge?.snowluma?.connected === true;
  let state;
  let hint;
  if (!httpUrl || !wsUrl) {
    state = 'invalid-config'; hint = '请在 QQ 设置中填写本机 NapCat OneBot HTTP 和 WebSocket 地址。';
  } else if (login.state === 'unauthorized' || status.state === 'unauthorized') {
    state = 'unauthorized'; hint = 'NapCat HTTP 令牌被拒绝，请核对 OneBot 访问令牌。';
  } else if (login.state === 'error') {
    state = 'http-error'; hint = 'NapCat HTTP 端口有响应，但 OneBot 接口返回异常；请检查 HTTP 服务配置和日志。';
  } else if (!login.ok && !wsListening) {
    state = 'not-running'; hint = 'NapCat 的 HTTP 未响应且 WebSocket 端口未监听，请启动网关并检查登录。';
  } else if (!login.ok) {
    state = 'http-unavailable'; hint = 'WebSocket 端口在监听，但 NapCat HTTP 接口不可用；请检查 HTTP 端口和令牌。';
  } else if (!wsListening) {
    state = 'ws-unavailable'; hint = 'NapCat HTTP 已响应，但 WebSocket 端口未监听；请检查正向 WebSocket 配置。';
  } else if (online === false) {
    state = 'account-offline'; hint = 'NapCat 已响应，但 QQ 账号离线；请检查 QQ 登录。';
  } else if (online !== true) {
    state = 'account-unknown'; hint = 'NapCat HTTP 已响应，但未能确认 QQ 账号在线。';
  } else if (!connected) {
    state = 'bridge-disconnected'; hint = bridge?.running ? 'NapCat 账号在线，但桥接尚未连上 WebSocket；请检查 WS 地址及令牌。' : 'NapCat 账号在线，QQ 桥接尚未运行。';
  } else {
    state = 'ok'; hint = '';
  }
  return {
    state, hint,
    http: { state: login.state, address: safeEndpoint(config.httpUrl, ['http:', 'https:']) },
    ws: { state: wsUrl ? (wsListening ? 'listening' : 'closed') : 'invalid', address: safeEndpoint(config.wsUrl, ['ws:', 'wss:']) },
    accountOnline: online,
    bridgeConnected: connected,
    login: login.ok ? { user_id: String(login.data?.user_id ?? ''), nickname: String(login.data?.nickname ?? '') } : null,
  };
}

export async function napcatGroups(config, timeoutMs = 4000) {
  const result = await onebotRequest(config, 'get_group_list', timeoutMs);
  return (result.ok && Array.isArray(result.data) ? result.data : [])
    .map((group) => ({ id: String(group.group_id ?? ''), name: String(group.group_name ?? '') }))
    .filter((group) => /^\d{5,15}$/.test(group.id));
}

export function findNapCatLauncher(root, napcat = {}) {
  const value = String(napcat.launchScript || 'Start-NapCat.ps1').trim();
  const script = path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
  if (!/\.ps1$/i.test(script) || /[\r\n]/.test(script)) return null;
  try { return fs.statSync(script).isFile() ? script : null; } catch { return null; }
}

function runPowerShell(script, root) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { cwd: root, windowsHide: true, timeout: 45000, maxBuffer: 256 * 1024 },
      (error) => resolve({ ok: !error }));
  });
}

/** Only called from explicit start actions; never start a second process for an occupied endpoint. */
export async function launchNapCat({ root, config = {}, napcat = {}, bridge = {}, run = runPowerShell, diagnose = diagnoseNapCat } = {}) {
  if (process.env.SURFCORE_SKIP_AUTOSTART === '1') return { ok: true, skipped: true, message: '测试环境：跳过启动 NapCat' };
  const before = await diagnose({ config, bridge });
  if (before.http.state === 'ok' && before.accountOnline === true && before.ws.state === 'listening') {
    return { ok: true, already: true, diagnosis: before, message: 'NapCat 已运行，QQ 账号在线' };
  }
  if (napcat.allowLaunch === false) return { ok: false, error: '未允许启动 NapCat：请在 QQ 设置中开启该选项', diagnosis: before };
  if (before.state === 'invalid-config' || before.state === 'unauthorized' || before.ws.state === 'listening' || ['ok', 'error'].includes(before.http.state)) {
    return { ok: false, error: before.hint || 'NapCat 尚未就绪，请检查网关状态', diagnosis: before };
  }
  const launcher = findNapCatLauncher(root, napcat);
  if (!launcher) return { ok: false, error: '找不到 NapCat PowerShell 启动脚本，请在 QQ 设置中填写启动脚本路径', diagnosis: before };
  if (process.platform !== 'win32') return { ok: false, error: '当前 NapCat 启动器只支持 Windows', diagnosis: before };
  const result = await run(launcher, root);
  const after = await diagnose({ config, bridge });
  if (result.ok && after.http.state === 'ok' && after.accountOnline === true && after.ws.state === 'listening') {
    return { ok: true, started: true, diagnosis: after, message: 'NapCat 已启动，QQ 账号在线；桥接正在连接' };
  }
  return { ok: false, error: `NapCat 未就绪：${after.hint || '请检查启动日志和 QQ 登录状态'}`, diagnosis: after };
}
