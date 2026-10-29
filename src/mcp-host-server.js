// SnowLuma 网关状态查询 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行）。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（只读：HTTP get_login_info）与账号信息
//
// ── 为什么这里**没有**启停 SnowLuma 的工具（2026-09-20 移除，不要加回来）────────────
//
// 曾经有 `start_snowluma` / `stop_snowluma`（`spawn launcher.bat` / `taskkill`），默认关闭、
// 需要 `snowluma.allowProcessControl: true` 才注册。它们被移除，理由不是"危险"，而是**许可**：
//
//   SnowLuma EULA §5.4（中文为准）：「除事先取得著作权人的书面授权外，您仅可为 LICENSE 允许的
//   非商业用途，以专有组件随本软件提供的形式运行该组件；不得复制、修改、单独再分发或再许可该组件。
//   **将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署**，或者将其用于任何商业用途，
//   均须事先取得书面授权。」
//
// 原生组件是**专有组件**；由本程序**程序化启动/结束**它，落在"通过自动化脚本部署"的射程内。
// 即便是"用户已装好、我们帮忙拉起"，也不值得为这点便利去踩一条需要书面授权的条款。
//
// 设计不变量 L6（见规划集 QSH_PLAN.md §6.0）：**QSH 只探测、不部署**——
// 永不安装、复制、打包或自动部署 SnowLuma 及其原生组件，也不程序化启停其进程。
// 用户在 QQ 侧不可用时得到的应该是**可操作的提示**（"请自行启动 SnowLuma"），而不是被代劳。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getOneBotStatus } from './onebot-status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  return { httpUrl, token: c.snowluma?.accessToken ?? '' };
}

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  return getOneBotStatus(httpUrl, token);
}

const server = new McpServer({ name: 'snowluma-host', version: '0.2.0-r4' });

server.tool(
  'snowluma_status',
  '检查 NapCat OneBot 网关（只读）。分别查询账号信息和在线状态；无法确认时 online 为 null。',
  {},
  async () => {
    const info = await gatewayInfo();
    // 只读工具：不再暴露本机路径/PID（那需要进程控制能力，而该能力已被移除）。
    const payload = { ...info };
    if (info.reachable === false) {
      payload.hint = info.httpStatus === 401 || info.httpStatus === 403
        ? 'NapCat HTTP 令牌被拒绝，请核对 OneBot 配置。'
        : 'NapCat 网关不可达：请在 SurfCore 设置中启动网关，并检查 OneBot HTTP 地址。';
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

await server.connect(new StdioServerTransport());
