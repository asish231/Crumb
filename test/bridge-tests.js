'use strict';

/* bridge-tests.js — verifies the Anthropic translation layer end-to-end.
 *
 *   node test/bridge-tests.js
 *
 * The bridge is pointed at the local mock upstream, so every wire-format rule
 * (delta concatenation, inline reasoning, NUL bytes, [DONE]-in-JSON) is
 * exercised through the full HTTP path — without touching the real backend.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server.js');
const { createBridge } = require('../bridge.js');
const { VISIBLE_TEXT, THINKING_TEXT } = require('../server.js');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

async function startTestStack(mockMode, opts) {
  opts = opts || {};
  const mock = createServer(opts.mockOptions);
  await new Promise((r) => mock.listen(0, r));
  const mockPort = mock.address().port;

  // chatMode 'react' uses the real observed paths (mock implements them);
  // 'fastchat' test mode points CHAT_PATH at the mock's generic /stream.
  // Never let tests touch the developer's real accounts.json: a nonexistent
  // path yields the single .env account, exactly as if no pool existed.
  const noPool = path.join(os.tmpdir(), 'mimo-test-no-accounts-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.json');

  const bridge = createBridge({
    upstreamBase: 'http://127.0.0.1:' + mockPort,
    chatMode: mockMode === 'react' ? 'react' : 'fastchat',
    chatPath: mockMode && mockMode !== 'react'
      ? '/stream?mode=' + mockMode + '&chunk=5&delay=0'
      : '/stream?chunk=5&delay=0',
    port: 0,
    host: '127.0.0.1',
    accountsFile: noPool,
    ...(opts.accounts ? { accounts: opts.accounts } : {})
  });
  await new Promise((r) => bridge.server.listen(0, '127.0.0.1', r));
  const bridgePort = bridge.server.address().port;

  return {
    bridgeUrl: 'http://127.0.0.1:' + bridgePort,
    bridge,
    async close() {
      await new Promise((r) => bridge.server.close(r));
      await new Promise((r) => mock.close(r));
    }
  };
}

function post(url, body, extraHeaders) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(body)
  });
}

function collectText(raw) {
  let text = '', thinking = '';
  for (const m of raw.matchAll(/event: content_block_delta\ndata: (.*)/g)) {
    const d = JSON.parse(m[1]).delta;
    if (d.type === 'text_delta') text += d.text;
    else if (d.type === 'thinking_delta') thinking += d.thinking;
  }
  return { text, thinking };
}

const ANTHROPIC_REQUEST = {
  model: 'xiaomi-bot-1',
  max_tokens: 1024,
  system: [{ type: 'text', text: 'You are a coding agent.' }],
  messages: [
    { role: 'user', content: 'say hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file contents here' }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
    { role: 'user', content: [{ type: 'text', text: 'now say hi again' }] }
  ],
  tools: [{ name: 'read_file', description: 'reads', input_schema: { type: 'object' } }],
  stream: true
};

/* --------------------------- flattening --------------------------- */

test('flatten: system + roles + tool blocks become one transcript', () => {
  const { flatten } = createBridge({ port: 0 });
  const t = flatten(ANTHROPIC_REQUEST);
  assert.ok(t.startsWith('### system\nYou are a coding agent.'), 'system first');
  assert.ok(t.includes('### user\nsay hi'));
  assert.ok(t.includes('### assistant\nHello.'));
  assert.ok(t.includes('"toolCalls"'), 'tool_use rendered as native toolCalls');
  assert.ok(t.includes('"name":"read_file"'), 'tool name in call block');
  assert.ok(t.includes('### user\nnow say hi again'));
  assert.strictEqual(t.lastIndexOf('### user'), t.length - '### user\nnow say hi again'.length, 'last user message last');
});

test('contentToText: string, blocks, tool_result recursion', () => {
  const { contentToText } = createBridge({ port: 0 });
  assert.strictEqual(contentToText('plain'), 'plain');
  assert.strictEqual(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.strictEqual(
    contentToText([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file contents here' }] }]),
    JSON.stringify({ responses: [{ id: 't1', name: '', responseData: 'file contents here' }] })
  );
  assert.strictEqual(contentToText([{ type: 'image', source: {} }]), '[image omitted]');
});

/* ------------------------- visible emitter ------------------------ */

test('emitter: react reasoning streams as thinking_delta, then text in text_delta', () => {
  const { makeEmitter } = createBridge({ port: 0 });
  const events = [];
  const send = (ev, data) => events.push([ev, data]);
  const em = makeEmitter(send, { showThinking: true, inlineMarkers: false, stream: true });

  em.feedReasoning('The user');
  em.feedReasoning(' wants');
  em.feedContent('Visible');
  const final = em.end();

  const thinking = events.filter((e) => e[1].delta && e[1].delta.type === 'thinking_delta')
    .map((e) => e[1].delta.thinking).join('');
  const text = events.filter((e) => e[1].delta && e[1].delta.type === 'text_delta')
    .map((e) => e[1].delta.text).join('');
  assert.strictEqual(thinking, 'The user wants');
  assert.strictEqual(text, 'Visible');
  assert.strictEqual(final.visible, 'Visible');
  assert.ok(!text.includes('The user'), 'reasoning never in text channel');
  const starts = events.filter((e) => e[0] === 'content_block_start').map((e) => e[1].content_block.type);
  assert.deepStrictEqual(starts, ['thinking', 'text']);
});

test('emitter: SHOW_THINKING=false suppresses thinking events entirely', () => {
  const { makeEmitter } = createBridge({ port: 0 });
  const events = [];
  const send = (ev, data) => events.push([ev, data]);
  const em = makeEmitter(send, { showThinking: false, inlineMarkers: false, stream: true });

  em.feedReasoning('secret reasoning');
  em.feedContent('answer');
  const final = em.end();
  assert.ok(!events.some(([, d]) => d && d.delta && d.delta.type === 'thinking_delta'));
  assert.ok(!JSON.stringify(events).includes('secret reasoning'));
  assert.strictEqual(final.visible, 'answer');
  assert.strictEqual(final.thinking, 'secret reasoning'); // accumulated, just not emitted
});

test('emitter: fastchat inline markers split across deltas route correctly', () => {
  const { makeEmitter } = createBridge({ port: 0 });
  const events = [];
  const send = (ev, data) => events.push([ev, data]);
  const em = makeEmitter(send, { showThinking: true, inlineMarkers: true, stream: true });

  em.feedContent('\u003cth');                                  // open marker split
  em.feedContent('ink\u003e\u0000plan don');                   // ...completed here
  em.feedContent("'t tell\u003c/think\u003e");                 // close marker complete
  em.feedContent('\u0000\u0000\u0000Answer here');
  const final = em.end();

  const thinking = events.filter((e) => e[1].delta && e[1].delta.type === 'thinking_delta')
    .map((e) => e[1].delta.thinking).join('');
  const text = events.filter((e) => e[1].delta && e[1].delta.type === 'text_delta')
    .map((e) => e[1].delta.text).join('');
  assert.strictEqual(thinking, "plan don't tell");
  assert.strictEqual(text, 'Answer here');
  assert.strictEqual(final.visible, 'Answer here');
  assert.ok(!text.includes('plan'), 'reasoning must not leak into text');
  assert.ok(!thinking.includes('\u0000'), 'NUL bytes stripped');
});

test('emitter: truncated inline reasoning stays in thinking channel, never in text', () => {
  const { makeEmitter } = createBridge({ port: 0 });
  const events = [];
  const send = (ev, data) => events.push([ev, data]);
  const em = makeEmitter(send, { showThinking: true, inlineMarkers: true, stream: true });

  em.feedContent('\u003cthink\u003e\u0000cut off mid-thought');
  const final = em.end();
  const text = events.filter((e) => e[1].delta && e[1].delta.type === 'text_delta')
    .map((e) => e[1].delta.text).join('');
  assert.strictEqual(text, '');
  assert.strictEqual(final.visible, '');
  assert.ok(final.thinking.includes('cut off mid-thought'));
});

/* --------------------- classification / errors -------------------- */

test('classifyUpstreamFailure: quota 429 (code 4004) with real msg', () => {
  const { classifyUpstreamFailure } = createBridge({ port: 0 });
  const raw = '{"code":4004,"msg":"今日 Token 额度已达上限，次日 0 点（UTC+8）恢复","data":null}';
  const m = classifyUpstreamFailure(429, raw, 'application/json');
  assert.strictEqual(m.status, 429);
  assert.strictEqual(m.type, 'rate_limit_error');
  assert.ok(m.message.includes('4004'));
  assert.ok(m.message.includes('00:00 UTC+8'));
});

test('classifyUpstreamFailure: auth + unknown statuses', () => {
  const { classifyUpstreamFailure } = createBridge({ port: 0 });
  assert.strictEqual(classifyUpstreamFailure(401, '', '').type, 'authentication_error');
  assert.strictEqual(classifyUpstreamFailure(403, '', '').type, 'authentication_error');
  assert.strictEqual(classifyUpstreamFailure(502, 'gateway junk', '').type, 'api_error');
});

/* ------------------------ end-to-end over HTTP -------------------- */

test('e2e: streaming request returns a valid Anthropic SSE sequence', async () => {
  const stack = await startTestStack(null);
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', ANTHROPIC_REQUEST);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/event-stream'));

    const raw = await res.text();
    const events = [];
    for (const block of raw.split('\n\n')) {
      let ev = null, data = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (ev && data) events.push([ev, JSON.parse(data)]);
    }

    const names = events.map((e) => e[0]);
    assert.ok(names.length >= 7, 'full event sequence present');
    assert.deepStrictEqual(names.slice(0, 2), ['message_start', 'ping']);
    for (let i = 2; i < names.length - 3; i++) {
      assert.ok(['content_block_start', 'content_block_delta', 'content_block_stop'].includes(names[i]),
        'middle events are content blocks, got ' + names[i]);
    }
    assert.deepStrictEqual(names.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);

    const start = events[0][1];
    assert.strictEqual(start.type, 'message_start');
    assert.strictEqual(start.message.role, 'assistant');
    assert.strictEqual(start.message.model, 'mimo-v2.6-pro', 'foreign model name maps to default');
    assert.match(start.message.id, /^msg_/);

    const text = events.filter((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'text_delta')
      .map((e) => e[1].delta.text).join('');
    const thinking = events.filter((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'thinking_delta')
      .map((e) => e[1].delta.thinking).join('');
    assert.strictEqual(text, VISIBLE_TEXT);
    assert.strictEqual(thinking, THINKING_TEXT, 'fastchat inline reasoning routed to thinking block');
    assert.ok(!text.includes(THINKING_TEXT), 'reasoning excluded from text');
    assert.ok(!text.includes('\u0000'));

    const blockTypes = events.filter((e) => e[0] === 'content_block_start').map((e) => e[1].content_block.type);
    assert.deepStrictEqual(blockTypes, ['thinking', 'text']);

    const delta = events.find((e) => e[0] === 'message_delta')[1];
    assert.strictEqual(delta.delta.stop_reason, 'end_turn');
    assert.ok(delta.usage.output_tokens > 0);
    assert.ok(delta.usage.input_tokens > 0, 'upstream prompt tokens propagated');
  } finally {
    await stack.close();
  }
});

test('e2e: non-streaming request returns a complete Anthropic message object', async () => {
  const stack = await startTestStack(null);
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: false });
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    assert.strictEqual(body.type, 'message');
    assert.strictEqual(body.role, 'assistant');
    assert.strictEqual(body.model, 'mimo-v2.6-pro');
    assert.strictEqual(body.content[0].type, 'thinking', 'thinking block first');
    assert.strictEqual(body.content[0].thinking, THINKING_TEXT);
    assert.strictEqual(body.content[1].type, 'text');
    assert.strictEqual(body.content[1].text, VISIBLE_TEXT);
    assert.strictEqual(body.stop_reason, 'end_turn');
    assert.ok(body.usage.input_tokens > 0 && body.usage.output_tokens > 0);
    assert.match(body.id, /^msg_/);
  } finally {
    await stack.close();
  }
});

test('e2e: upstream quota 429 becomes Anthropic rate_limit_error', async () => {
  const stack = await startTestStack('quota');
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: false });
    assert.strictEqual(res.status, 429);
    const body = await res.json();
    assert.strictEqual(body.type, 'error');
    assert.strictEqual(body.error.type, 'rate_limit_error');
    assert.ok(body.error.message.includes('4004'));
    assert.ok(body.error.message.includes('00:00 UTC+8'));
  } finally {
    await stack.close();
  }
});

test('e2e: upstream 401 becomes Anthropic authentication_error', async () => {
  const stack = await startTestStack('auth');
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: false });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error.type, 'authentication_error');
    assert.ok(body.error.message.toLowerCase().includes('session'));
  } finally {
    await stack.close();
  }
});

test('e2e: count_tokens + models + validation', async () => {
  const stack = await startTestStack(null);
  try {
    const ct = await post(stack.bridgeUrl + '/v1/messages/count_tokens', ANTHROPIC_REQUEST);
    assert.strictEqual(ct.status, 200);
    const ctBody = await ct.json();
    assert.ok(Number.isInteger(ctBody.input_tokens) && ctBody.input_tokens > 0);

    const models = await fetch(stack.bridgeUrl + '/v1/models');
    assert.strictEqual(models.status, 200);
    const mBody = await models.json();
    assert.strictEqual(mBody.data[0].id, 'mimo-v2.6-pro');

    const empty = await post(stack.bridgeUrl + '/v1/messages', { model: 'm', messages: [] });
    assert.strictEqual(empty.status, 400);
    assert.strictEqual((await empty.json()).error.type, 'invalid_request_error');

    const missing = await post(stack.bridgeUrl + '/v1/messages', { model: 'm', messages: [{ role: 'assistant', content: 'x' }] });
    assert.strictEqual(missing.status, 400);
  } finally {
    await stack.close();
  }
});

test('e2e react: native toolCalls frame becomes Anthropic tool_use; backend retry loop is cut off', async () => {
  const mock = createServer();
  await new Promise((r) => mock.listen(0, r));
  const mockPort = mock.address().port;
  const bridge = createBridge({
    upstreamBase: 'http://127.0.0.1:' + mockPort,
    chatMode: 'react', reactPath: '/toolcall-stream', port: 0, host: '127.0.0.1'
  });
  await new Promise((r) => bridge.server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + bridge.server.address().port;
  try {
    const res = await post(url + '/v1/messages', {
      model: 'mimo-v2.6-flash', max_tokens: 256, stream: false,
      tools: [{ name: 'list_files', description: 'List directory entries', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      messages: [{ role: 'user', content: 'list the files here' }]
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.stop_reason, 'tool_use', 'tool call detected');
    const tu = body.content.find((b) => b.type === 'tool_use');
    assert.ok(tu, 'tool_use block present');
    assert.strictEqual(tu.name, 'list_files');
    assert.deepStrictEqual(tu.input, { path: '.' });
    assert.strictEqual(tu.id, 'call_test123', 'upstream call id preserved for result correlation');
    const text = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    assert.ok(text.includes('Let me look'), 'text before the call is preserved');
    assert.ok(!text.includes('SHOULD-NOT-APPEAR'), 'backend retry loop must not leak');
    assert.ok(!text.includes('x-tool-call'), 'no marker leakage');

    // streaming variant
    const sres = await post(url + '/v1/messages', {
      model: 'mimo-v2.6-flash', max_tokens: 256, stream: true,
      tools: [{ name: 'list_files', description: 'ls', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'list files' }]
    });
    const raw = await sres.text();
    assert.ok(raw.includes('"type":"tool_use"') || raw.includes('\\"type\\":\\"tool_use\\"'), 'tool_use block in stream');
    assert.ok(raw.includes('input_json_delta'));
    assert.ok(raw.includes('"stop_reason":"tool_use"'));
    assert.ok(!raw.includes('SHOULD-NOT-APPEAR'));
  } finally {
    await new Promise((r) => bridge.server.close(r));
    await new Promise((r) => mock.close(r));
  }
});

test('flatten: tool blocks round-trip in the model-facing protocol format', () => {
  const { flatten } = createBridge({ port: 0 });
  const t = flatten({
    tools: [{ name: 'execute', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_abc', name: 'execute', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'file1\nfile2' }] }
    ]
  });
  assert.ok(t.includes('"toolCalls"'), 'assistant tool_use rendered as native toolCalls');
  assert.ok(t.includes('"arguments":"{\\"command\\":\\"ls\\"}"') || t.includes('\\"command\\":\\"ls\\"'), 'arguments is a JSON string');
  assert.ok(t.includes('"responses"'), 'tool_result rendered as native responses');
  assert.ok(t.includes('file1\\nfile2') || t.includes('responseData'), 'responseData carries the result');
  assert.ok(t.includes('"name":"execute"'), 'tool name resolved from prior call via id map');
  assert.ok(t.includes('TOOL PROTOCOL'), 'tool preamble injected');
  assert.ok(t.includes('execute: Run a shell command'), 'tool listed with description');
  assert.ok(t.includes('command!:string'), 'required args marked');
});

/* ----------------------- react mode end-to-end ----------------------- */

test('e2e react: streaming through conversation/save + react/chat wire format', async () => {
  const stack = await startTestStack('react');
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', ANTHROPIC_REQUEST);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/event-stream'));

    const raw = await res.text();
    const events = [];
    for (const block of raw.split('\n\n')) {
      let ev = null, data = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (ev && data) events.push([ev, JSON.parse(data)]);
    }
    const names = events.map((e) => e[0]);
    assert.strictEqual(names[0], 'message_start');
    assert.strictEqual(names[names.length - 1], 'message_stop');

    const text = events.filter((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'text_delta')
      .map((e) => e[1].delta.text).join('');
    const thinking = events.filter((e) => e[0] === 'content_block_delta' && e[1].delta.type === 'thinking_delta')
      .map((e) => e[1].delta.thinking).join('');
    assert.strictEqual(text, VISIBLE_TEXT);
    assert.strictEqual(thinking, THINKING_TEXT, 'react reasoningContent streamed as thinking');
    assert.ok(!text.includes(THINKING_TEXT), 'reasoningContent frames must not leak into text');

    const blockTypes = events.filter((e) => e[0] === 'content_block_start').map((e) => e[1].content_block.type);
    assert.deepStrictEqual(blockTypes, ['thinking', 'text']);

    const delta = events.find((e) => e[0] === 'message_delta')[1];
    assert.strictEqual(delta.delta.stop_reason, 'end_turn');
    assert.strictEqual(delta.usage.input_tokens, 3810, 'react prompt tokens propagated');
    assert.ok(delta.usage.output_tokens > 0);
  } finally {
    await stack.close();
  }
});

test('e2e react: mimo-* model names pass through, others map to default', async () => {
  const stack = await startTestStack('react');
  try {
    const r1 = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, model: 'mimo-v2.6-flash', stream: false });
    assert.strictEqual(r1.status, 200);
    const j1 = await r1.json();
    assert.strictEqual(j1.model, 'mimo-v2.6-flash', 'mimo-* echoed verbatim');
    assert.ok(j1.content.some((b) => b.type === 'text' && b.text === VISIBLE_TEXT));

    const r2 = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, model: 'claude-sonnet-4-20250514', stream: false });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual((await r2.json()).model, 'mimo-v2.6-pro', 'foreign name maps to default');

    const models = await fetch(stack.bridgeUrl + '/v1/models');
    const ids = (await models.json()).data.map((m) => m.id);
    assert.ok(ids.includes('mimo-v2.6-flash'));
    assert.ok(ids.includes('mimo-v2.6-pro-ultraspeed-studio'));
  } finally {
    await stack.close();
  }
});

test('e2e: in-stream model-name error → Anthropic invalid_request_error (was: silent empty reply)', async () => {
  const stack = await startTestStack('modelerror');
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: false });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error.type, 'invalid_request_error');
    assert.ok(body.error.message.includes('模型名称错误'));
  } finally {
    await stack.close();
  }
});

test('e2e: in-stream quota error → Anthropic rate_limit_error', async () => {
  const stack = await startTestStack('quota-stream');
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: false });
    assert.strictEqual(res.status, 429);
    const body = await res.json();
    assert.strictEqual(body.error.type, 'rate_limit_error');
    assert.ok(body.error.message.includes('额度'));
  } finally {
    await stack.close();
  }
});

test('e2e: streaming request hit by in-stream error emits Anthropic error event', async () => {
  const stack = await startTestStack('modelerror');
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: true });
    assert.strictEqual(res.status, 200);
    const raw = await res.text();
    assert.ok(raw.includes('event: error'), 'must contain an error event');
    assert.ok(raw.includes('invalid_request_error'));
    assert.ok(!raw.includes('message_stop'), 'stream terminates on error');
  } finally {
    await stack.close();
  }
});

test('pool: HTTP 429 marks the account and fails over to the next', async () => {
  const accounts = [
    { id: 'a1', label: 'acct-one', email: 'one@example.com', cookie: 'userId=quota-alpha; xiaomichatbot_ph="aaa"', ph: 'aaa', userId: 'quota-alpha' },
    { id: 'a2', label: 'acct-two', email: 'two@example.com', cookie: 'userId=beta; xiaomichatbot_ph="bbb"', ph: 'bbb', userId: 'beta' }
  ];
  const stack = await startTestStack('react', {
    accounts,
    mockOptions: { quotaCookies: ['quota-alpha'], quotaMode: 'http' }
  });
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: true });
    assert.strictEqual(res.status, 200);
    const raw = await res.text();
    assert.ok(raw.includes('message_delta'), 'second account produced a full response');
    assert.strictEqual(collectText(raw).text, VISIBLE_TEXT, 'visible text from the healthy account');
    assert.ok(!raw.includes('event: error'), 'failover is silent to the client');
    assert.strictEqual((raw.match(/event: message_start/g) || []).length, 1, 'exactly one message_start');
    assert.ok(stack.bridge.cfg.accounts[0].exhaustedUntil > Date.now(), 'quota account parked');
    assert.ok(stack.bridge.cfg.accounts[1].lastUsedAt > 0, 'second account used');
  } finally {
    await stack.close();
  }
});

test('pool: in-stream quota before any delta fails over without a duplicate message_start', async () => {
  const accounts = [
    { id: 'a1', label: 'acct-one', cookie: 'userId=quota-alpha; xiaomichatbot_ph="aaa"', ph: 'aaa', userId: 'quota-alpha' },
    { id: 'a2', label: 'acct-two', cookie: 'userId=beta; xiaomichatbot_ph="bbb"', ph: 'bbb', userId: 'beta' }
  ];
  const stack = await startTestStack('react', {
    accounts,
    mockOptions: { quotaCookies: ['quota-alpha'], quotaMode: 'stream' }
  });
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: true });
    assert.strictEqual(res.status, 200);
    const raw = await res.text();
    assert.strictEqual(collectText(raw).text, VISIBLE_TEXT, 'healthy account delivered the answer');
    assert.ok(!raw.includes('event: error'), 'no error leaked after silent failover');
    assert.strictEqual((raw.match(/event: message_start/g) || []).length, 1, 'one message_start after failover');
    assert.ok(stack.bridge.cfg.accounts[0].exhaustedUntil > Date.now(), 'quota account parked until reset');
  } finally {
    await stack.close();
  }
});

test('pool: every account exhausted → rate_limit_error', async () => {
  const accounts = [
    { id: 'a1', label: 'acct-one', cookie: 'userId=quota-alpha; xiaomichatbot_ph="aaa"', ph: 'aaa', userId: 'quota-alpha' },
    { id: 'a2', label: 'acct-two', cookie: 'userId=quota-beta; xiaomichatbot_ph="bbb"', ph: 'bbb', userId: 'quota-beta' }
  ];
  const stack = await startTestStack('react', {
    accounts,
    mockOptions: { quotaCookies: ['quota-alpha', 'quota-beta'], quotaMode: 'http' }
  });
  try {
    const res = await post(stack.bridgeUrl + '/v1/messages', { ...ANTHROPIC_REQUEST, stream: true });
    assert.strictEqual(res.status, 200);
    const raw = await res.text();
    assert.ok(raw.includes('event: error'));
    assert.ok(raw.includes('rate_limit_error'));
    assert.ok(raw.includes('out of quota'));
    assert.ok(raw.includes('00:00 UTC+8'), 'tells the client when quota returns');
    assert.strictEqual((raw.match(/event: message_start/g) || []).length, 1, 'single start before the terminal error');
    assert.ok(!raw.includes('message_stop'), 'stream terminates on error');
    assert.ok(stack.bridge.cfg.accounts.every((a) => a.exhaustedUntil > Date.now()));
  } finally {
    await stack.close();
  }
});

/* ------------------------------- runner ------------------------------- */

(async () => {
  let pass = 0;
  const failures = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      process.stdout.write('  ok  ' + name + '\n');
    } catch (err) {
      failures.push(name);
      process.stdout.write('FAIL  ' + name + '\n      ' + String(err && err.message ? err.message : err).split('\n').join('\n      ') + '\n');
    }
  }
  process.stdout.write('\n' + pass + ' passed, ' + failures.length + ' failed (of ' + tests.length + ')\n');
  process.exit(failures.length ? 1 : 0);
})();
