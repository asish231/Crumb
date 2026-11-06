'use strict';

/* deepseek.js — DeepSeek web-chat bridge module for the Anthropic-compatible bridge.
 *
 * Provides:
 *   - PoW solver using DeepSeek's own sha3_wasm_bg.wasm (runs in ~30ms in Node)
 *   - Multi-account pool (ds-accounts.json) with quota failover
 *   - Anthropic → DeepSeek request translation
 *   - DeepSeek SSE → Anthropic SSE stream translation (thinking + answer)
 *
 * Security research on the user's own account traffic. The WASM is public
 * (served to every browser); we call it from Node instead of Chrome.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WASM_PATH = path.join(__dirname, 'sha3_wasm_bg.wasm');
const DS_BASE = 'https://chat.deepseek.com';
const DS_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';

let _wasmExports = null;

async function loadWasm() {
  if (_wasmExports) return _wasmExports;
  const bytes = fs.readFileSync(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  _wasmExports = instance.exports;
  return _wasmExports;
}

/* ------------------------- PoW solver ------------------------- */

async function solvePow(challenge) {
  const exports = await loadWasm();
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;

  function fresh() {
    const b = exports.memory.buffer;
    return { m8: new Uint8Array(b), v: new DataView(b), l: b.byteLength };
  }

  let { m8, v, l } = fresh();
  const chB = Buffer.from(challenge.challenge, 'utf8');
  const chP = exports.__wbindgen_export_0(chB.length, 1);
  ({ m8, v, l } = fresh());
  for (let i = 0; i < chB.length; i++) m8[chP + i] = chB[i];

  const pxB = Buffer.from(prefix, 'utf8');
  const pxP = exports.__wbindgen_export_0(pxB.length, 1);
  ({ m8, v, l } = fresh());
  for (let i = 0; i < pxB.length; i++) m8[pxP + i] = pxB[i];

  const rp = exports.__wbindgen_add_to_stack_pointer(-16);
  ({ m8, v, l } = fresh());
  for (let i = 0; i < 16; i++) m8[rp + i] = 0;

  exports.wasm_solve(rp, chP, chB.length, pxP, pxB.length, challenge.difficulty);
  ({ m8, v, l } = fresh());
  const status = v.getInt32(rp, true);
  const nonce = v.getFloat64(rp + 8, true);
  exports.__wbindgen_add_to_stack_pointer(16);

  if (status === 0) throw new Error('PoW solver returned no solution');
  return nonce;
}

function buildPowHeader(challenge, nonce) {
  const answerObj = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer: nonce,
    signature: challenge.signature,
    target_path: '/api/v0/chat/completion'
  };
  return Buffer.from(JSON.stringify(answerObj)).toString('base64');
}

/* ------------------------- account pool ------------------------- */

function normalizeAccount(a, i) {
  if (!a || typeof a !== 'object' || !a.token) return null;
  return {
    id: String(a.id || a.userId || ('ds-account-' + (i + 1))),
    label: String(a.label || a.email || ('account ' + (i + 1))),
    email: String(a.email || ''),
    token: String(a.token),
    deviceId: String(a.deviceId || ''),
    wafToken: String(a.wafToken || ''),
    sessionId: String(a.sessionId || ''),
    thumbcache: String(a.thumbcache || ''),
    exhaustedUntil: Number(a.exhaustedUntil) || 0,
    invalidUntil: Number(a.invalidUntil) || 0,
    lastUsedAt: Number(a.lastUsedAt) || 0,
    lastError: a.lastError ? String(a.lastError).slice(0, 300) : ''
  };
}

function loadAccountPool(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.accounts) ? raw.accounts : null);
    if (!list) return null;
    const accounts = list.map(normalizeAccount).filter(Boolean);
    return accounts.length ? accounts : null;
  } catch {
    return null;
  }
}

function persistPool(file, accounts) {
  const out = {
    version: 1,
    updatedAt: new Date().toISOString(),
    accounts: accounts.map((a) => ({
      id: a.id, label: a.label, email: a.email,
      token: a.token, deviceId: a.deviceId, wafToken: a.wafToken,
      sessionId: a.sessionId, thumbcache: a.thumbcache,
      exhaustedUntil: a.exhaustedUntil, invalidUntil: a.invalidUntil,
      lastUsedAt: a.lastUsedAt, lastError: a.lastError
    }))
  };
  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[deepseek] could not persist account pool: ' + err.message);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function mask(v) {
  const s = String(v || '');
  if (!s) return '(empty)';
  if (s.length <= 8) return s[0] + '...' + s.slice(-1) + ' (len ' + s.length + ')';
  return s.slice(0, 4) + '...' + s.slice(-4) + ' (len ' + s.length + ')';
}

function accountHeaders(account) {
  const cookie = [
    account.thumbcache ? '.thumbcache_' + account.thumbcache : '',
    account.wafToken ? 'aws-waf-token=' + account.wafToken : '',
    account.sessionId ? 'ds_session_id=' + account.sessionId : ''
  ].filter(Boolean).join('; ');

  return {
    accept: '*/*',
    'content-type': 'application/json',
    authorization: 'Bearer ' + account.token,
    cookie,
    origin: DS_BASE,
    referer: DS_BASE + '/a/chat',
    'user-agent': DS_UA,
    'x-client-platform': 'web',
    'x-device-id': account.deviceId
  };
}

function pickAccount(accounts, attempted) {
  const now = Date.now();
  for (const a of accounts) {
    if (attempted.has(a.id)) continue;
    if (a.exhaustedUntil > now || a.invalidUntil > now) continue;
    return a;
  }
  return null;
}

function markQuota(account, message, cfg) {
  const daily = /quota|limit|额度|429/i.test(String(message || ''));
  account.exhaustedUntil = daily ? nextMidnightUtc8() : Date.now() + 60000;
  account.lastError = String(message || '').slice(0, 300);
  console.error(`[deepseek] account "${account.label}" quota exhausted until ${new Date(account.exhaustedUntil).toISOString()}`);
  if (cfg && cfg.dsAccountsSource === 'file') persistPool(cfg.dsAccountsFile, cfg.dsAccounts);
}

function markAuth(account, message, cfg) {
  account.invalidUntil = Date.now() + 10 * 60000;
  account.lastError = String(message || '').slice(0, 300);
  console.error(`[deepseek] account "${account.label}" session rejected — cooling down for 10m`);
  if (cfg && cfg.dsAccountsSource === 'file') persistPool(cfg.dsAccountsFile, cfg.dsAccounts);
}

function nextMidnightUtc8() {
  const now = Date.now();
  const utc8 = new Date(now + 8 * 3600000);
  return Date.UTC(utc8.getUTCFullYear(), utc8.getUTCMonth(), utc8.getUTCDate() + 1) - 8 * 3600000;
}

function poolSummary(accounts) {
  const now = Date.now();
  return accounts.map((a) => ({
    label: a.label,
    email: a.email || undefined,
    healthy: a.exhaustedUntil <= now && a.invalidUntil <= now,
    exhaustedUntil: a.exhaustedUntil > now ? a.exhaustedUntil : null,
    invalidUntil: a.invalidUntil > now ? a.invalidUntil : null,
    lastError: a.lastError || null
  }));
}

/* ------------------------- DeepSeek API calls ------------------------- */

async function fetchChallenge(headers) {
  const res = await fetch(DS_BASE + '/api/v0/chat/create_pow_challenge', {
    method: 'POST', headers,
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json();
  if (!res.ok || json.code !== 0) {
    const err = new Error('challenge fetch failed: ' + res.status + ' ' + JSON.stringify(json).slice(0, 200));
    err.status = res.status;
    err.body = JSON.stringify(json);
    err.dsCode = json.code;
    throw err;
  }
  return json.data.biz_data.challenge;
}

async function createSession(headers) {
  const res = await fetch(DS_BASE + '/api/v0/chat_session/create', {
    method: 'POST', headers,
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json();
  if (!res.ok || json.code !== 0) {
    const err = new Error('session create failed: ' + res.status + ' ' + JSON.stringify(json).slice(0, 200));
    err.status = res.status;
    err.body = JSON.stringify(json);
    err.dsCode = json.code;
    throw err;
  }
  return json.data.biz_data.chat_session.id;
}

async function sendCompletion(headers, powHeader, body) {
  return fetch(DS_BASE + '/api/v0/chat/completion', {
    method: 'POST',
    headers: { ...headers, 'X-DS-PoW-Response': powHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });
}

/* ------------------------- Anthropic → DeepSeek translation ------------------------- */

function flattenTranscript(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const parts = [];

  if (body.system) {
    const sysText = Array.isArray(body.system)
      ? body.system.map((b) => b.text || '').join('\n')
      : String(body.system);
    if (sysText) parts.push('### system\n' + sysText);
  }

  for (const msg of msgs) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const bits = [];
      for (const block of msg.content) {
        if (block.type === 'text') bits.push(block.text || '');
        else if (block.type === 'tool_use') {
          bits.push('```json\n{"toolCalls":[{"id":"' + (block.id || '') + '","name":"' + (block.name || '') + '","arguments":' + JSON.stringify(block.input || {}) + '}]}\n```');
        } else if (block.type === 'tool_result') {
          const inner = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : String(block.content || '');
          bits.push('```json\n{"responses":[{"toolCallId":"' + (block.tool_use_id || '') + '","responseData":' + JSON.stringify(inner) + '}]}\n```');
        }
      }
      text = bits.join('\n');
    }
    if (text) parts.push('### ' + role + '\n' + text);
  }

  return parts.join('\n\n');
}

/* ------------------------- DeepSeek SSE → Anthropic SSE ------------------------- */

function createDeepSeekEmitter(send, opts) {
  opts = opts || {};
  const showThinking = opts.showThinking !== false;
  const stream = opts.stream === true;

  let thinkBuf = '', visibleBuf = '';
  let thinkOpen = false, textOpen = false;
  let nextIndex = 0;
  let inThink = true;
  let anyToolUse = false;
  const toolUses = [];

  function ensureThinkBlock() {
    if (!stream || thinkOpen) return;
    thinkOpen = true;
    send('content_block_start', { type: 'content_block_start', index: nextIndex, content_block: { type: 'thinking', thinking: '' } });
  }
  function closeThinkBlock() {
    if (!stream || !thinkOpen) return;
    send('content_block_delta', { type: 'content_block_delta', index: nextIndex, delta: { type: 'signature_delta', signature: 'bridge-local' } });
    send('content_block_stop', { type: 'content_block_stop', index: nextIndex });
    thinkOpen = false;
    nextIndex++;
  }
  function ensureTextBlock() {
    if (!stream || textOpen) return;
    if (thinkOpen) closeThinkBlock();
    textOpen = true;
    send('content_block_start', { type: 'content_block_start', index: nextIndex, content_block: { type: 'text', text: '' } });
  }

  function feedThinking(delta) {
    thinkBuf += delta;
    if (showThinking && stream) {
      ensureThinkBlock();
      send('content_block_delta', { type: 'content_block_delta', index: nextIndex, delta: { type: 'thinking_delta', thinking: delta } });
    }
  }
  function feedContent(delta) {
    if (inThink) { inThink = false; }
    visibleBuf += delta;
    if (stream) {
      ensureTextBlock();
      send('content_block_delta', { type: 'content_block_delta', index: nextIndex, delta: { type: 'text_delta', text: delta } });
    }
  }

  function emitToolUse(name, input, id) {
    if (thinkOpen) closeThinkBlock();
    if (textOpen) {
      send('content_block_stop', { type: 'content_block_stop', index: nextIndex });
      textOpen = false;
      nextIndex++;
    }
    const toolIndex = nextIndex++;
    send('content_block_start', { type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id: id || ('call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12)), name, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input || {}) } });
    send('content_block_stop', { type: 'content_block_stop', index: toolIndex });
    toolUses.push({ name, input, id });
    anyToolUse = true;
  }

  function end() {
    if (stream) {
      if (thinkOpen) closeThinkBlock();
      if (textOpen) {
        send('content_block_stop', { type: 'content_block_stop', index: nextIndex });
        textOpen = false;
        nextIndex++;
      }
    }
    return { thinking: thinkBuf, visible: visibleBuf, toolUses, anyToolUse };
  }

  return { feedThinking, feedContent, emitToolUse, end, get stats() { return { thinkChars: thinkBuf.length, visibleChars: visibleBuf.length, toolCalls: toolUses.length }; } };
}

/* Parse DeepSeek SSE data lines into structured events */
function parseDeepSeekStream(rawText) {
  const events = [];
  const blocks = rawText.split('\n\n');
  let currentEvent = null;
  let currentData = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        if (currentEvent !== null) events.push({ event: currentEvent, data: currentData.join('\n') });
        currentEvent = line.slice(7).trim();
        currentData = [];
      } else if (line.startsWith('data: ')) {
        currentData.push(line.slice(6));
      }
    }
    if (currentEvent !== null) {
      events.push({ event: currentEvent, data: currentData.join('\n') });
      currentEvent = null;
      currentData = [];
    }
  }
  if (currentEvent !== null) events.push({ event: currentEvent, data: currentData.join('\n') });
  return events;
}

/* ------------------------- main handler ------------------------- */

async function handleDeepSeekMessages(req, res, body, opts) {
  const cfg = opts.cfg;
  const wantStream = body.stream === true;
  const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const requested = typeof body.model === 'string' && body.model ? body.model : '';
  const thinkingEnabled = /deepseek-reasoner|deepseek-r1/.test(requested) || body.thinking !== false;
  const searchEnabled = false;
  const prompt = flattenTranscript(body);

  const attempted = new Set();
  let headersSent = false;
  let messageStarted = false;
  let lastError = null;

  const writeEvent = (event, data) => {
    if (!wantStream) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ensureHeaders = () => {
    if (!wantStream || headersSent) return;
    headersSent = true;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
  };
  const ensureMessageStart = () => {
    if (!wantStream || messageStarted) return;
    ensureHeaders();
    messageStarted = true;
    writeEvent('message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: requested, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    writeEvent('ping', { type: 'ping' });
  };
  const send = (event, data) => {
    if (!wantStream) return;
    if (event === 'message_start' || event === 'ping') return;
    ensureMessageStart();
    writeEvent(event, data);
  };
  const failAll = (status, type, message) => {
    if (!wantStream) {
      const errBody = { type: 'error', error: { type, message } };
      const buf = Buffer.from(JSON.stringify(errBody, null, 2), 'utf8');
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
      res.end(buf);
      return;
    }
    ensureMessageStart();
    writeEvent('error', { type: 'error', error: { type, message } });
    res.end();
  };

  for (;;) {
    const account = pickAccount(cfg.dsAccounts, attempted);
    if (!account) {
      const now = Date.now();
      const exhausted = cfg.dsAccounts.filter((a) => a.exhaustedUntil > now);
      const invalid = cfg.dsAccounts.filter((a) => a.invalidUntil > now);
      if (exhausted.length) {
        const reset = Math.min(...exhausted.map((a) => a.exhaustedUntil));
        return failAll(429, 'rate_limit_error', 'All DeepSeek accounts are out of quota. Earliest reset: ' + new Date(reset).toISOString() + '. Refresh with: node chrome-auth.js --ds-write-pool');
      }
      if (invalid.length) return failAll(401, 'authentication_error', 'All DeepSeek sessions were rejected. Refresh with: node chrome-auth.js --ds-write-pool');
      return failAll(429, 'rate_limit_error', lastError || 'No usable DeepSeek account.');
    }

    attempted.add(account.id);
    account.lastUsedAt = Date.now();
    if (cfg.dsAccountsSource === 'file') persistPool(cfg.dsAccountsFile, cfg.dsAccounts);

    const dsHeaders = accountHeaders(account);

    // 1+3. Fetch PoW challenge and create chat session IN PARALLEL.
    // They are independent (neither depends on the other's output), so this
    // overlaps two ~200ms China round trips into one. Measured RTT ~186-261ms.
    let challenge, sessionId;
    try {
      [challenge, sessionId] = await Promise.all([
        fetchChallenge(dsHeaders),
        createSession(dsHeaders)
      ]);
    } catch (err) {
      const status = err.status || 0;
      if (status === 401 || status === 403 || err.dsCode === 40003) { markAuth(account, err.message, cfg); lastError = err.message; continue; }
      if (status === 429) { markQuota(account, err.message, cfg); lastError = err.message; continue; }
      return failAll(502, 'api_error', 'DeepSeek preflight failed: ' + err.message);
    }

    // 2. Solve PoW (local, ~30ms)
    let nonce, powHeader;
    try {
      nonce = await solvePow(challenge);
      powHeader = buildPowHeader(challenge, nonce);
    } catch (err) {
      console.error('[deepseek] PoW solve failed: ' + err.message);
      return failAll(500, 'api_error', 'PoW solver failed: ' + err.message);
    }

  // 4. Send completion
  let compRes;
  try {
    compRes = await sendCompletion(dsHeaders, powHeader, {
      chat_session_id: sessionId,
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled
    });
  } catch (err) {
    return failAll(502, 'api_error', 'DeepSeek completion request failed: ' + err.message);
  }

  // Check for non-SSE response (error)
  const ct = compRes.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    const errText = await compRes.text();
    console.error(`[deepseek] account "${account.label}" completion ${compRes.status}: ${errText.slice(0, 200)}`);
    let dsErrCode = 0;
    try { dsErrCode = JSON.parse(errText).code || 0; } catch {}
    if (compRes.status === 401 || compRes.status === 403 || dsErrCode === 40003) { markAuth(account, errText, cfg); lastError = errText; continue; }
    if (compRes.status === 429) { markQuota(account, errText, cfg); lastError = errText; continue; }
    // code 40300 = MISSING_HEADER (PoW rejected)
    if (errText.includes('40300') || errText.includes('MISSING_HEADER')) {
      return failAll(502, 'api_error', 'DeepSeek rejected PoW header: ' + errText.slice(0, 200));
    }
    return failAll(compRes.status >= 500 ? 502 : 500, 'api_error', 'DeepSeek error: ' + errText.slice(0, 200));
  }

    // 5. Stream translation
    ensureHeaders();
    const emitter = createPatchedEmitter(send, { showThinking: cfg.showThinking, stream: wantStream });
    let usage = null;
    let finishSeen = false;
    let streamError = null;
    let inThink = true;

    try {
      const reader = compRes.body.getReader();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString('utf8');

        // Process complete SSE blocks
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          processSseBlock(block, emitter, (d) => { usage = d; }, (s) => { finishSeen = s; }, (e) => { streamError = e; }, (t) => { inThink = t; });
        }
      }
      // Process remaining
      if (buf.trim()) processSseBlock(buf, emitter, (d) => { usage = d; }, (s) => { finishSeen = s; }, (e) => { streamError = e; }, (t) => { inThink = t; });
    } catch (err) {
      streamError = err;
    }

    const { thinking, visible, toolUses, anyToolUse } = emitter.end();

    console.log(`[deepseek] /v1/messages model=${requested} stream=${wantStream} account="${account.label}" stop=${anyToolUse ? 'tool_use' : (finishSeen ? 'end_turn' : 'max_tokens')} think=${thinking.length}c text=${visible.length}c`);

    if (wantStream) {
      if (streamError) {
        ensureMessageStart();
        writeEvent('error', { type: 'error', error: { type: 'api_error', message: 'DeepSeek stream failed: ' + streamError.message } });
      }
      ensureMessageStart();
      writeEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: anyToolUse ? 'tool_use' : (finishSeen ? 'end_turn' : 'max_tokens'), stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: usage || Math.ceil(visible.length / 4) }
      });
      writeEvent('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      // Non-streaming: build full Anthropic message
      const content = [];
      if (cfg.showThinking && thinking) content.push({ type: 'thinking', thinking, signature: 'bridge-local' });
      if (visible) content.push({ type: 'text', text: visible });
      const msg = {
        id: messageId, type: 'message', role: 'assistant', model: requested,
        content, stop_reason: anyToolUse ? 'tool_use' : (finishSeen ? 'end_turn' : 'max_tokens'),
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: usage || Math.ceil(visible.length / 4) }
      };
      const buf2 = Buffer.from(JSON.stringify(msg, null, 2), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf2.length });
      res.end(buf2);
    }
    return;
  }
}

function processSseBlock(block, emitter, setUsage, setFinish, setError, setThink) {
  const lines = block.split('\n');
  let eventName = null;
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) eventName = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }

  const data = dataLines.join('\n');
  if (!data) return;

  if (eventName === 'close') { setFinish(true); return; }
  if (eventName === 'ready' || eventName === 'update_session' || eventName === 'title') return;

  try {
    const d = JSON.parse(data);

    // Full response object (initial)
    if (d.v && typeof d.v === 'object' && d.v.response) {
      const r = d.v.response;
      if (r.fragments) {
        for (const f of r.fragments) {
          if (f.type === 'THINK') { setThink(true); emitter.feedThinking(f.content || ''); }
          else if (f.type === 'RESPONSE') { setThink(false); emitter.feedContent(f.content || ''); }
        }
      }
      if (r.status === 'FINISHED' || r.status === 'OK') setFinish(true);
      if (r.accumulated_token_usage) setUsage(r.accumulated_token_usage);
      return;
    }

    // JSON Patch operations
    if (d.p && typeof d.p === 'string') {
      if (d.p === 'response/fragments/-1/content') {
        // Append to current fragment content
        if (typeof d.v === 'string') {
          // Determine if we're in THINK or RESPONSE by checking the last fragment type
          // The initial fragment setup tells us via setThink
          // We use emitter's internal state
          emitter.feedThinkingOrContent(d.v);
        }
      } else if (d.p === 'response/fragments' && d.o === 'APPEND') {
        // New fragment(s) added
        if (Array.isArray(d.v)) {
          for (const f of d.v) {
            if (f.type === 'THINK') { setThink(true); emitter.feedThinking(f.content || ''); }
            else if (f.type === 'RESPONSE') { setThink(false); emitter.feedContent(f.content || ''); }
          }
        }
      } else if (d.p === 'response/status' && d.v === 'FINISHED') {
        setFinish(true);
      } else if (d.p === 'response' && d.o === 'BATCH') {
        if (Array.isArray(d.v)) {
          for (const item of d.v) {
            if (item.p === 'accumulated_token_usage') setUsage(item.v);
            if (item.p === 'quasi_status' && item.v === 'FINISHED') setFinish(true);
          }
        }
      } else if (d.p === 'response/accumulated_token_usage') {
        setUsage(d.v);
      }
      return;
    }

    // Bare string value (content append)
    if (typeof d.v === 'string') {
      emitter.feedThinkingOrContent(d.v);
    }
  } catch {
    // Non-JSON data, ignore
  }
}

// Helper: the emitter needs to know whether to route to thinking or content
// We patch it onto the emitter via a state tracker
const emitterState = new WeakMap();
function patchEmitter(emitter) {
  let inThink = true;
  emitter.feedThinkingOrContent = (delta) => {
    if (inThink) emitter.feedThinking(delta);
    else emitter.feedContent(delta);
  };
  // Override feedThinking/feedContent to track state
  const origFeedThinking = emitter.feedThinking;
  const origFeedContent = emitter.feedContent;
  emitter.feedThinking = (d) => { inThink = true; origFeedThinking(d); };
  emitter.feedContent = (d) => { inThink = false; origFeedContent(d); };
}

// Patch createDeepSeekEmitter to include feedThinkingOrContent
const origCreate = createDeepSeekEmitter;
function createPatchedEmitter(send, opts) {
  const emitter = origCreate(send, opts);
  patchEmitter(emitter);
  return emitter;
}

module.exports = {
  loadWasm, solvePow, buildPowHeader,
  normalizeAccount, loadAccountPool, persistPool,
  accountHeaders, pickAccount, markQuota, markAuth, poolSummary,
  fetchChallenge, createSession, sendCompletion,
  flattenTranscript, createDeepSeekEmitter: createPatchedEmitter,
  parseDeepSeekStream, processSseBlock,
  handleDeepSeekMessages,
  DS_MODELS: [
    { id: 'deepseek-chat', display_name: 'DeepSeek V3 (Chat)' },
    { id: 'deepseek-reasoner', display_name: 'DeepSeek R1 (Reasoner)' }
  ]
};
