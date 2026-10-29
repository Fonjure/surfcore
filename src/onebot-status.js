/** Read-only OneBot status for the MCP host tool. Never return a token or raw error. */
export async function getOneBotStatus(httpUrl, token, fetchFn = fetch) {
  const base = String(httpUrl ?? '').replace(/\/+$/, '');
  async function call(action) {
    try {
      const response = await fetchFn(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: '{}', signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) return { ok: false, status: response.status };
      const body = await response.json();
      return body?.status === 'ok' && body?.retcode === 0
        ? { ok: true, data: body.data } : { ok: false, status: response.status };
    } catch { return { ok: false, status: null }; }
  }
  const [login, status] = await Promise.all([call('get_login_info'), call('get_status')]);
  if (!login.ok) return { reachable: false, online: null, httpStatus: login.status };
  return {
    reachable: true,
    online: typeof status.data?.online === 'boolean' ? status.data.online : null,
    user_id: login.data?.user_id,
    nickname: login.data?.nickname,
  };
}
