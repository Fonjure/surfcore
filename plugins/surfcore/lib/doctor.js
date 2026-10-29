/**
 * 新手体检的"判定"部分（纯函数，不碰 IO）。
 *
 * 为什么单独拆出来：判定规则要能被测试钉住（哪项该红、该给什么修复提示），
 * 而读配置/探端口这些副作用留在 index.js 里。见 scripts/test-doctor.mjs。
 */

import { safeEndpoint } from './napcat.js';

/** @typedef {'ok'|'warn'|'fail'} CheckLevel */

function nodeEnough(version) {
  const [maj, min] = String(version).replace(/^v/, '').split('.').map((n) => Number(n));
  return maj > 22 || (maj === 22 && min >= 13);
}

/**
 * @param {object} ctx
 * @param {string} ctx.nodeVersion      process.versions.node
 * @param {boolean} ctx.hasUnified      统一配置是否已存在
 * @param {string} ctx.unifiedMasked    统一配置路径（已脱敏）
 * @param {string} ctx.ownerQQ          管理员 QQ（空 = 没配）
 * @param {string[]} ctx.groups         白名单群
 * @param {string[]} ctx.privates       白名单私聊
 * @param {{wsUrl?:string,httpUrl?:string}} ctx.snow
 * @param {{state?:string,hint?:string}} ctx.snowState
 * @param {boolean} ctx.bridgeSrc       src/bridge.js 是否存在
 * @param {string} ctx.bridgeMasked     桥接源码路径（已脱敏）
 * @param {string} ctx.profile          注册了 surfcore 的 DSH profile（空 = 没注册）
 * @param {string} ctx.token            控制台令牌（空 = 没生成）
 * @returns {Array<{name:string,level:CheckLevel,ok:boolean,detail:string,fix:string}>}
 */
export function buildInstallChecks(ctx) {
  const checks = [];
  const add = (name, level, detail, fix = '') => checks.push({ name, level, ok: level !== 'fail', detail, fix });

  add('Node 版本', nodeEnough(ctx.nodeVersion) ? 'ok' : 'fail',
    `v${ctx.nodeVersion}（需要 ≥ 22.13）`,
    nodeEnough(ctx.nodeVersion) ? '' : 'https://nodejs.org/ 装 LTS 后重开终端');

  add('统一配置', 'ok',
    ctx.hasUnified ? ctx.unifiedMasked : '还没生成，用的默认值（可点"一键配置"生成）');

  add('管理员 QQ', ctx.ownerQQ ? 'ok' : 'warn',
    ctx.ownerQQ ? '已设置（不回显）' : '还没填 —— 她不知道谁是主人',
    ctx.ownerQQ ? '' : '设置 → 管理员，或点"一键配置"后填 QQ 号');

  const allowCount = (ctx.groups?.length ?? 0) + (ctx.privates?.length ?? 0);
  add('白名单', allowCount ? 'ok' : 'fail',
    allowCount ? `${ctx.groups?.length ?? 0} 个群 / ${ctx.privates?.length ?? 0} 个私聊` : '白名单为空 = 谁都不理（第一次装最容易卡这）',
    allowCount ? '' : '设置 → QQ → 白名单，加入你的群号/QQ 号');

  const httpAddress = safeEndpoint(ctx.snow?.httpUrl, ['http:', 'https:']);
  const wsAddress = safeEndpoint(ctx.snow?.wsUrl, ['ws:', 'wss:']);
  const snowFilled = !httpAddress.startsWith('未配置') && !wsAddress.startsWith('未配置');
  add('NapCat OneBot 配置', snowFilled ? 'ok' : 'fail',
    snowFilled ? `${httpAddress} / ${wsAddress}` : 'OneBot 地址缺失、不是本机地址或含有不支持的参数',
    snowFilled ? '' : '设置 → QQ → NapCat，填本机 OneBot HTTP 与正向 WebSocket 地址');

  const diag = ctx.snowState ?? {};
  const snowOk = diag.state === 'ok';
  add('NapCat HTTP', diag.http?.state === 'ok' ? 'ok' : 'warn',
    diag.http?.state === 'ok' ? '已验证 OneBot HTTP 访问' : `HTTP 状态：${diag.http?.state || 'unknown'}`,
    diag.http?.state === 'ok' ? '' : diag.hint || '检查 NapCat HTTP 地址和令牌');
  add('NapCat WebSocket 端口', diag.ws?.state === 'listening' ? 'ok' : 'warn',
    diag.ws?.state === 'listening' ? '端口在监听（不代表桥接已连接）' : `端口状态：${diag.ws?.state || 'unknown'}`,
    diag.ws?.state === 'listening' ? '' : diag.hint || '检查 NapCat 正向 WebSocket');
  add('NapCat QQ 账号', diag.accountOnline === true ? 'ok' : 'warn',
    diag.accountOnline === true ? '在线' : (diag.accountOnline === false ? '离线' : '尚未确认'),
    diag.accountOnline === true ? '' : diag.hint || '检查 QQ 登录');
  add('QQ 网关在线', snowOk ? 'ok' : 'warn',
    snowOk ? 'NapCat 账号在线且桥接已连接' : `探测结果：${diag.state || 'unknown'}${diag.hint ? ` · ${diag.hint}` : ''}`,
    snowOk ? '' : '启动 NapCat 并登录，再检查桥接连接');

  add('QQ 桥接源码', ctx.bridgeSrc ? 'ok' : 'fail',
    ctx.bridgeSrc ? ctx.bridgeMasked : '没找到 src/bridge.js：安装目录选错了？');

  add('装进 DSH', ctx.profile ? 'ok' : 'fail',
    ctx.profile ? `profile：${ctx.profile}` : 'DSH profile 里没有 surfcore（预设/MCP 还没注册）',
    ctx.profile ? '' : '在仓库目录跑：node scripts/setup-dsh.mjs，然后重启 DSH');

  add('控制台令牌', ctx.token ? 'ok' : 'warn',
    ctx.token ? '已生成（不回显）' : '还没生成，控制台打不开',
    ctx.token ? '' : '点"一键配置"自动生成');

  return checks;
}

/** 体检结论：有 fail 就算没通过（warn 不影响）。 */
export function installOk(checks) {
  return checks.every((c) => c.level !== 'fail');
}

/**
 * 一键配置要补哪些项（只算"缺什么"，不执行写操作）。
 * @returns {string[]} 人类可读的动作名
 */
export function planDoctorFix({ hasUnified, hasToken, ownerQQ, currentOwnerQQ }) {
  const actions = [];
  if (!hasUnified) actions.push('生成统一配置 config.json');
  if (!hasToken) actions.push('生成控制台令牌');
  if (/^\d{5,15}$/.test(String(ownerQQ ?? '')) && String(ownerQQ) !== String(currentOwnerQQ ?? '')) {
    actions.push('写入管理员 QQ');
  }
  return actions;
}
