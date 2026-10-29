import assert from 'node:assert/strict';
import { getOneBotStatus } from '../src/onebot-status.js';

const secret = 'fixture-secret';
let online = true;
let statusAvailable = true;
let authorized = true;
const requests = [];
const fakeFetch = async (url, init) => {
  requests.push({ url, method: init.method, authorization: init.headers.authorization });
  if (!authorized) return { ok: false, status: 401 };
  if (url.endsWith('/get_status') && !statusAvailable) throw new Error('offline fixture');
  return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0,
    data: url.endsWith('/get_status') ? { online } : { user_id: 10001, nickname: 'fixture' } }) };
};
let result = await getOneBotStatus('http://127.0.0.1:6200', secret, fakeFetch);
assert.equal(result.reachable, true);
assert.equal(result.online, true);
assert.ok(requests.every((item) => item.method === 'POST' && item.authorization === `Bearer ${secret}`));
online = false;
result = await getOneBotStatus('http://127.0.0.1:6200', secret, fakeFetch);
assert.equal(result.online, false, 'login info alone cannot prove that QQ is online');
statusAvailable = false;
result = await getOneBotStatus('http://127.0.0.1:6200', secret, fakeFetch);
assert.equal(result.online, null, 'missing status must remain unknown');
authorized = false;
result = await getOneBotStatus('http://127.0.0.1:6200', secret, fakeFetch);
assert.equal(result.reachable, false);
assert.equal(result.httpStatus, 401);
assert.ok(!JSON.stringify(result).includes(secret));
console.log('OneBot MCP status fixtures OK');
