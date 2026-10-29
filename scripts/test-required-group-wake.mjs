import assert from 'node:assert/strict';
import { requiredGroupKeyword } from '../src/group-required-wake.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

assert.equal(requiredGroupKeyword('group', '今天吃鱼香肉丝', ['鱼']), '鱼');
assert.equal(requiredGroupKeyword('private', '鱼', ['鱼']), '');
assert.equal(requiredGroupKeyword('group', '今天吃饭', ['鱼']), '');
assert.equal(requiredGroupKeyword('group', 'ABC Boss', ['', 'boss']), 'boss');

const h = await bridgeHarness({ config: { socialV2: { wake: { requiredGroupKeywords: ['鱼'], batchWindowMs: 1000 }, history: { enabled: false } } } });
try {
  h.setMode('reserved2');
  h.setInitialPrompt('group:456', '群初始说明');
  const event = { self_id: 999, user_id: 234, message_id: 4242, message: [{ type: 'text', data: { text: '今天吃鱼香肉丝' } }], raw_message: '今天吃鱼香肉丝', sender: { nickname: '测试群友', card: '测试群友' } };
  await h.handleIncoming('group', '456', event, h.cfg);
  for (let i = 0; i < 100 && !h.calls.prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.calls.prompts.length, 1);
  const prompt = h.calls.prompts[0].content.map((part) => String(part?.text ?? '')).join('\n');
  assert.match(prompt, /群消息必回/);
  assert.match(prompt, /群初始说明/);
  assert.match(prompt, /使用 QQ 回复工具/);
  console.log('群必回词入站与首轮提示测试通过');
} finally { await h.close(); }

const h2 = await bridgeHarness({ config: { socialV2: { wake: { requiredGroupKeywords: ['鱼'], batchWindowMs: 1000 }, history: { enabled: false } } } });
try {
  h2.setMode('reserved2');
  const state = h2.getSocialV2State('group:456');
  state.bootstrapSent = true;
  state.wakeConfig.triggers = { atMention: false, nameMention: false, keywords: [], question: false, poke: false, anyMessage: false, probability: 0 };
  const event = { self_id: 999, user_id: 234, message_id: 4243, message: [{ type: 'text', data: { text: '鱼来了' } }], raw_message: '鱼来了', sender: { nickname: '测试群友' } };
  await h2.handleIncoming('group', '456', event, h2.cfg);
  for (let i = 0; i < 100 && !h2.calls.prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h2.calls.prompts.length, 1, '模型关闭潜水触发条件后也应唤醒');
  assert.match(h2.calls.prompts[0].content.map((part) => String(part?.text ?? '')).join('\n'), /群消息必回/);
  console.log('群必回词不受模型潜水条件覆盖');
} finally { await h2.close(); }
