'use strict';

/* bridge.js — Anthropic-compatible endpoint in front of the Xiaomi AI Studio chat API.
 *
 *   Claude Code  ──/v1/messages──▶  bridge  ──bot/chat──▶  aistudio.xiaomimimo.com
 *                                         ◀──SSE (wire.js)──
 *
 * Design notes (from the captures):
 *  - Upstream keeps history server-side; the observed client always sends exactly
 *    ONE message per request. Claude Code sends the full conversation every time
 *    (stateless). Mapping via upstream dialogs would drift on compaction/edits,
 *    so the bridge is stateless too: it flattens the whole Anthropic message
 *    array into one transcript and opens a FRESH upstream dialog per request.
 *  - No model field exists upstream; botId is the selector. The requested model
 *    name is echoed back unchanged.
 *  - No request signing. Required auth is the session cookie (+ ph query param).
 *  - Reasoning arrives INLINE between ҿink> markers with NUL bytes; it must never
 *    reach the client, so visible text is emitted only after the close marker
 *    (or immediately when no open marker ever appears).
 *  - Upstream errors are JSON (e.g. 429 code 4004 = daily quota, resets 00:00
 *    UTC+8); they are translated to Anthropic error envelopes.
 *
 * Endpoints: POST /v1/messages, POST /v1/messages/count_tokens, GET /v1/models, GET /health
 * Run: node bridge.js   (default 127.0.0.1:8789)
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const Wire = require('./wire.js');
const DS = require('./deepseek.js');

/* ----------------------------- config ----------------------------- */

function loadEnvFile(file) {
  const out = Object.create(null);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function stripQuotes(v) {
  v = String(v === undefined || v === null ? '' : v).trim();
  if (v.length >= 2) {
    const a = v.charAt(0), b = v.charAt(v.length - 1);
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) v = v.slice(1, -1).trim();
  }
  return v;
}

function normalizePh(input) {
  let v = stripQuotes(input);
  const encoded = /%[0-9A-Fa-f]{2}/.test(v);
  let raw = v;
  if (encoded) { try { raw = decodeURIComponent(v); } catch { raw = v; } }
  raw = stripQuotes(raw);
  return { raw, cookieValue: '"' + raw + '"', queryValue: encodeURIComponent(raw) };
}

function mask(v) {
  if (!v) return '';
  return v.length <= 6 ? v[0] + '***' : v.slice(0, 3) + '…' + v.slice(-3) + ` (len ${v.length})`;
}

function createBridge(overrides) {
  overrides = overrides || {};
  const FILE_ENV = overrides.env || loadEnvFile(path.join(__dirname, '.env'));
  const camel = (k) => k.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const pick = (k, d) => {
    const c = camel(k);
    const v = overrides[k] !== undefined ? overrides[k]
      : overrides[c] !== undefined ? overrides[c]
      : process.env[k] !== undefined ? process.env[k]
      : FILE_ENV[k];
    return v === undefined || v === '' ? d : String(v);
  };

  const PH = normalizePh(pick('XIAOMI_PH', ''));
  const cfg = {
    host: pick('HOST', '127.0.0.1'),
    port: Number(pick('PORT', '8789')) || 8789,
    upstreamBase: pick('UPSTREAM_BASE', 'https://aistudio.xiaomimimo.com').replace(/\/+$/, ''),
    chatPath: pick('CHAT_PATH', '/fastchat/open-apis/bot/chat'),
    // 'react' = /open-apis/react/chat (what the web app uses; model selectable
    // via modelConfig; ~3.8k prompt overhead). 'fastchat' = /fastchat/open-apis/bot/chat
    // (botId selector; ~51k prompt overhead; server-side dialog history).
    chatMode: pick('CHAT_MODE', 'react') === 'fastchat' ? 'fastchat' : 'react',
    reactPath: pick('REACT_PATH', '/open-apis/react/chat'),
    convPath: pick('CONV_PATH', '/open-apis/chat/conversation/save'),
    reactModel: pick('REACT_MODEL', 'mimo-v2.6-pro'),
    enableThinking: pick('ENABLE_THINKING', 'true') === 'true',
    showThinking: pick('SHOW_THINKING', 'true') !== 'false',
    botId: pick('BOT_ID', '1'),
    extraBody: pick('EXTRA_BODY', ''),
    userId: stripQuotes(pick('XIAOMI_USER_ID', '')).replace(/\s+/g, ''),
    ph: PH,
    // Full verbatim cookie header from the browser (includes httpOnly SSO
    // cookies like serviceToken that document.cookie cannot see). When set,
    // it REPLACES the constructed userId+ph header entirely.
    rawCookie: stripQuotes(pick('XIAOMI_COOKIE', '')),
    extraCookies: pick('XIAOMI_EXTRA_COOKIES', ''),
    timezone: pick('X_TIMEZONE', 'Asia/Shanghai'),
    userAgent: pick('USER_AGENT', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'),
    bridgeToken: pick('BRIDGE_TOKEN', ''),
    accountsFile: pick('ACCOUNTS_FILE', path.join(__dirname, 'accounts.json')),
    dsAccountsFile: pick('DS_ACCOUNTS_FILE', path.join(__dirname, 'ds-accounts.json')),
    requestTimeoutMs: Number(pick('REQUEST_TIMEOUT_MS', '300000')) || 300000
  };

  // DeepSeek account pool
  const dsFileAccounts = DS.loadAccountPool(cfg.dsAccountsFile);
  cfg.dsAccounts = dsFileAccounts || [];
  cfg.dsAccountsSource = dsFileAccounts ? 'file' : 'none';

  const cookieHeader = () => {
    if (cfg.rawCookie) return cfg.rawCookie;
    const parts = [];
    if (cfg.userId) parts.push('userId=' + cfg.userId);
    if (cfg.ph.raw) parts.push('xiaomichatbot_ph=' + cfg.ph.cookieValue);
    const extra = cfg.extraCookies.trim().replace(/;+\s*$/, '');
    if (extra) parts.push(extra);
    return parts.join('; ');
  };

  /* ------------------------- account pool -------------------------
   *
   * accounts.json (written by `chrome-auth.js --all --write-pool`) holds one
   * session per Xiaomi account. Without it the bridge is single-account using
   * the XIAOMI_* values in .env. Account state is persisted on quota/auth
   * failures so a restart does not retry a dead account.
   */

  function normalizeAccount(a, i) {
    if (!a || typeof a !== 'object' || !a.cookie) return null;
    return {
      id: String(a.id || a.userId || ('account-' + (i + 1))),
      label: String(a.label || a.email || ('account ' + (i + 1))),
      profile: String(a.profile || ''),
      name: String(a.name || ''),
      email: String(a.email || ''),
      cookie: String(a.cookie),
      ph: String(a.ph || ''),
      userId: String(a.userId || ''),
      expiresAt: Number(a.expiresAt) || 0,
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

  const overrideAccounts = Array.isArray(overrides.accounts)
    ? overrides.accounts.map(normalizeAccount).filter(Boolean)
    : null;
  const fileAccounts = overrideAccounts ? null : loadAccountPool(cfg.accountsFile);
  const envAccount = {
    id: 'env', label: 'env (.env)', profile: '', name: '', email: '',
    cookie: null, ph: '', userId: cfg.userId, expiresAt: 0,
    exhaustedUntil: 0, invalidUntil: 0, lastUsedAt: 0, lastError: ''
  };
  cfg.accounts = overrideAccounts || fileAccounts || [envAccount];
  cfg.accountsSource = overrideAccounts ? 'override' : (fileAccounts ? 'file' : 'env');

  function persistPool() {
    if (cfg.accountsSource !== 'file') return;
    const out = {
      version: 1,
      updatedAt: new Date().toISOString(),
      accounts: cfg.accounts.map((a) => ({
        id: a.id, label: a.label, profile: a.profile, name: a.name, email: a.email,
        cookie: a.cookie, ph: a.ph, userId: a.userId, expiresAt: a.expiresAt,
        exhaustedUntil: a.exhaustedUntil, invalidUntil: a.invalidUntil,
        lastUsedAt: a.lastUsedAt, lastError: a.lastError
      }))
    };
    const tmp = cfg.accountsFile + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, cfg.accountsFile);
    } catch (err) {
      console.error('[bridge] could not persist account pool: ' + err.message);
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    }
  }

  function accountPh(account) {
    return account && account.ph ? normalizePh(account.ph) : cfg.ph;
  }

  function accountCookie(account) {
    return account && account.cookie ? account.cookie : cookieHeader();
  }

  function withPh(base, account) {
    const ph = accountPh(account);
    return base + (ph.raw ? '?xiaomichatbot_ph=' + ph.queryValue : '');
  }

  function nextMidnightUtc8() {
    const now = Date.now();
    const utc8 = new Date(now + 8 * 3600000);
    return Date.UTC(utc8.getUTCFullYear(), utc8.getUTCMonth(), utc8.getUTCDate() + 1) - 8 * 3600000;
  }

  function formatUtc8(ts) {
    return new Date(ts + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC+8';
  }

  function markQuota(account, message) {
    const daily = /今日|额度|4004|daily/i.test(String(message || ''));
    account.exhaustedUntil = daily ? nextMidnightUtc8() : Date.now() + 60000;
    account.lastError = String(message || '').slice(0, 300);
    console.error(`[bridge] account "${account.label}" quota exhausted until ${formatUtc8(account.exhaustedUntil)}`);
    persistPool();
  }

  function markAuth(account, message) {
    account.invalidUntil = Date.now() + 10 * 60000;
    account.lastError = String(message || '').slice(0, 300);
    console.error(`[bridge] account "${account.label}" session rejected — cooling down for 10m`);
    persistPool();
  }

  function pickAccount(attempted) {
    const now = Date.now();
    for (const a of cfg.accounts) {
      if (attempted.has(a.id)) continue;
      if (a.exhaustedUntil > now || a.invalidUntil > now) continue;
      return a;
    }
    return null;
  }

  function poolSummary() {
    const now = Date.now();
    return cfg.accounts.map((a) => ({
      label: a.label,
      email: a.email || undefined,
      healthy: a.exhaustedUntil <= now && a.invalidUntil <= now,
      exhaustedUntil: a.exhaustedUntil > now ? a.exhaustedUntil : null,
      invalidUntil: a.invalidUntil > now ? a.invalidUntil : null,
      lastError: a.lastError || null
    }));
  }

  /* ------------------- Anthropic -> transcript ------------------- */

  const TOOL_OPEN = '\u003cx-tool-call\u003e';
  const TOOL_CLOSE = '\u003c/x-tool-call\u003e';

  function summarizeSchema(schema) {
    if (!schema || typeof schema !== 'object') return '{}';
    const props = schema.properties || {};
    const req = Array.isArray(schema.required) ? schema.required : [];
    const parts = Object.entries(props).map(([k, v]) =>
      k + (req.includes(k) ? '!' : '') + ':' + ((v && v.type) || 'any'));
    return '{' + parts.join(', ') + '}';
  }

  function toolPreamble(tools) {
    const lines = (Array.isArray(tools) ? tools : []).filter((t) => t && t.name).map((t) => {
      const desc = String(t.description || '').replace(/\s+/g, ' ').slice(0, 160);
      return '- ' + t.name + ': ' + desc + ' args: ' + summarizeSchema(t.input_schema);
    });
    if (!lines.length) return '';
    return [
      '# TOOL PROTOCOL (follow exactly)',
      'You can use tools via function calls. To use one, emit a function call',
      '(toolCalls) with the tool\'s EXACT name and a JSON arguments object matching its args.',
      'The result comes back as a responses message containing responseData; then continue.',
      'Only call tools listed below. If no tool is needed, reply normally.',
      'Available tools:',
      ...lines
    ].join('\n');
  }

  function contentToText(c, toolNamesById) {
    if (c === undefined || c === null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((b) => {
        if (!b || typeof b !== 'object') return String(b);
        if (b.type === 'thinking') return ''; // ephemeral reasoning — never re-sent upstream
        if (b.type === 'text') return String(b.text || '');
        if (b.type === 'tool_use') {
          // Native shape the model itself emits: arguments as a JSON string.
          if (toolNamesById) toolNamesById.set(String(b.id || ''), String(b.name || ''));
          return JSON.stringify({
            toolCalls: [{
              id: String(b.id || ''), type: 'function',
              name: String(b.name || ''), arguments: JSON.stringify(b.input ?? {})
            }]
          });
        }
        if (b.type === 'tool_result') {
          const id = String(b.tool_use_id || '');
          const inner = contentToText(b.content);
          // Native shape the model expects to receive back.
          return JSON.stringify({
            responses: [{ id, name: (toolNamesById && toolNamesById.get(id)) || '', responseData: inner }]
          });
        }
        if (b.type === 'image') return '[image omitted]';
        return JSON.stringify(b);
      }).join('\n');
    }
    return JSON.stringify(c);
  }

  function flatten(body) {
    const parts = [];
    const toolNamesById = new Map();
    const sys = contentToText(body.system, toolNamesById);
    const pre = (cfg.tools !== 'off' && Array.isArray(body.tools) && body.tools.length)
      ? toolPreamble(body.tools) : '';
    parts.push('### system\n' + (sys ? sys + '\n\n' : '') + pre);
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
      if (!m || typeof m !== 'object') continue;
      parts.push(`### ${m.role || 'user'}\n` + contentToText(m.content, toolNamesById));
    }
    return parts.join('\n\n');
  }

  /* ------------------- upstream -> Anthropic SSE ------------------ */

  /* Dual-channel stream emitter.
   *
   * Reasoning (thinking) is streamed as Anthropic `thinking_delta` blocks so
   * clients like OpenCode can display it as reasoning; answer text streams as
   * `text_delta`. Reasoning NEVER mixes into the text channel.
   *
   * Two upstream shapes:
   *  - react mode: reasoning arrives as a separate `reasoningContent` field
   *    (feedReasoning) and content is pure visible text (feedContent). No
   *    buffering needed — deltas forward immediately.
   *  - fastchat mode: reasoning is inlined inside `content` between the literal
   *    think markers (with NUL bytes). feedContent scans markers incrementally
   *    and routes bytes to the right channel as they arrive.
   *
   * send() is a no-op for non-streaming requests; end() then returns the
   * accumulated {thinking, visible} for the JSON response.
   */
  function makeEmitter(send, opts) {
    opts = opts || {};
    const show = opts.showThinking !== false;
    const inlineMarkers = opts.inlineMarkers === true;
    const stream = opts.stream === true;

    let nextIndex = 0;
    let thinkOpen = false, thinkClosed = false;
    let textOpen = false;
    let thinkBuf = '', visibleBuf = '';
    let lateDropped = 0;
    const toolUses = [];
    let anyToolUse = false;

    // Tool-call scanning state (see toolPreamble): text is held back while a
    // partial <x-tool-call> marker might be forming, and buffered while the
    // JSON payload accumulates.
    const toolMode = opts.toolMode === true;
    let tAcc = '';        // text not yet emitted
    let tInTool = false;  // currently inside a tool-call block
    let tToolBuf = '';    // accumulated block payload
    const TOOL_OPEN = '\u003cx-tool-call\u003e';
    const TOOL_CLOSE = '\u003c/x-tool-call\u003e';
    const MAX_TOOL_BUF = 16384;

    // fastchat inline-marker scanning state
    let buf = '';
    let scan = 0;
    let phase = 'pre'; // pre | thinking | text
    let fallbackText = false;

    const blockIndex = () => nextIndex - 1;

    function openThinking() {
      if (!stream || thinkOpen || thinkClosed) return;
      send('content_block_start', { type: 'content_block_start', index: nextIndex++, content_block: { type: 'thinking', thinking: '' } });
      thinkOpen = true;
    }
    function closeThinking() {
      if (!thinkOpen) return;
      if (stream) send('content_block_delta', { type: 'content_block_delta', index: blockIndex(), delta: { type: 'signature_delta', signature: 'bridge-local' } });
      if (stream) send('content_block_stop', { type: 'content_block_stop', index: blockIndex() });
      thinkOpen = false;
      thinkClosed = true;
      nextIndex = thinkClosed ? nextIndex : nextIndex; // index already advanced at open
    }
    function openText() {
      if (textOpen) return;
      send('content_block_start', { type: 'content_block_start', index: nextIndex++, content_block: { type: 'text', text: '' } });
      textOpen = true;
    }
    function pushThinking(piece) {
      if (!piece) return;
      thinkBuf += piece;
      if (!show) return;
      openThinking();
      send('content_block_delta', { type: 'content_block_delta', index: blockIndex(), delta: { type: 'thinking_delta', thinking: piece } });
    }
    function pushTextRaw(piece) {
      if (!piece) return;
      visibleBuf += piece;
      openText();
      send('content_block_delta', { type: 'content_block_delta', index: blockIndex(), delta: { type: 'text_delta', text: piece } });
    }

    function emitToolUse(name, input, forcedId) {
      anyToolUse = true;
      const id = forcedId || ('toolu_' + crypto.randomBytes(12).toString('hex'));
      toolUses.push({ type: 'tool_use', id, name: String(name || 'unknown'), input });
      send('content_block_start', { type: 'content_block_start', index: nextIndex++, content_block: { type: 'tool_use', id, name: String(name || 'unknown') } });
      send('content_block_delta', { type: 'content_block_delta', index: blockIndex(), delta: { type: 'input_json_delta', partial_json: JSON.stringify(input ?? {}) } });
      send('content_block_stop', { type: 'content_block_stop', index: blockIndex() });
    }

    function tryParseToolCall(payload) {
      const trimmed = payload.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      const obj = Wire.parseJsonLoose(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.name) {
        return { name: obj.name, input: obj.input === undefined ? {} : obj.input };
      }
      return null;
    }

    function flushToolBuffers() {
      if (tInTool) {
        const parsed = tryParseToolCall(tToolBuf); // model may have dropped the close tag
        if (parsed) emitToolUse(parsed.name, parsed.input);
        else pushTextRaw(TOOL_OPEN + tToolBuf); // not a valid call — show as text
        tInTool = false; tToolBuf = '';
      }
      if (tAcc) { pushTextRaw(tAcc); tAcc = ''; }
    }

    function pushText(piece) {
      if (!piece) return;
      if (!toolMode) return pushTextRaw(piece);

      tAcc += piece;
      for (;;) {
        if (tInTool) {
          const j = tAcc.indexOf(TOOL_CLOSE);
          if (j !== -1) {
            tToolBuf += tAcc.slice(0, j);
            const parsed = tryParseToolCall(tToolBuf);
            if (parsed) emitToolUse(parsed.name, parsed.input);
            else pushTextRaw(TOOL_OPEN + tToolBuf + TOOL_CLOSE);
            tToolBuf = '';
            tInTool = false;
            tAcc = tAcc.slice(j + TOOL_CLOSE.length);
            continue;
          }
          if (tAcc.length > MAX_TOOL_BUF) { // runaway block — give up, show as text
            pushTextRaw(TOOL_OPEN + tToolBuf + tAcc);
            tToolBuf = ''; tInTool = false; tAcc = '';
            break;
          }
          tToolBuf += tAcc; tAcc = '';
          break;
        }
        const i = tAcc.indexOf(TOOL_OPEN);
        if (i !== -1) {
          pushTextRaw(tAcc.slice(0, i));
          tInTool = true;
          tToolBuf = '';
          tAcc = tAcc.slice(i + TOOL_OPEN.length);
          continue;
        }
        // hold back a possible partial open marker at the tail
        const keep = Math.min(TOOL_OPEN.length - 1, tAcc.length);
        if (tAcc.length > keep) {
          pushTextRaw(tAcc.slice(0, tAcc.length - keep));
          tAcc = tAcc.slice(tAcc.length - keep);
        }
        break;
      }
    }
    const clean = (s) => String(s || '').replace(/\u0000/g, '');

    return {
      /* react mode: separate reasoningContent field */
      feedReasoning(delta) {
        const s = clean(delta);
        if (!s) return;
        if (textOpen) { lateDropped += s.length; return; } // answer already started
        pushThinking(s);
      },

      feedContent(delta) {
        const raw = String(delta || '');
        if (!raw) return;

        if (!inlineMarkers) { // react mode: content is the visible answer
          if (thinkOpen) closeThinking();
          pushText(clean(raw));
          return;
        }

        // fastchat: scan for inline think markers, routing bytes as they go
        buf += raw;
        const OPEN = Wire.THINK_OPEN;
        const CLOSE = Wire.THINK_CLOSE;
        for (;;) {
          if (phase === 'pre' && !fallbackText) {
            const i = buf.indexOf(OPEN, scan);
            if (i !== -1) {
              pushText(clean(buf.slice(scan, i)));
              phase = 'thinking';
              scan = i + OPEN.length;
              continue;
            }
            if (buf.length - scan > 4000) { // no reasoning this time
              fallbackText = true;
              phase = 'text';
              continue;
            }
            // hold back a possible partial marker at the tail
            pushText(clean(buf.slice(scan, Math.max(scan, buf.length - (OPEN.length - 1)))));
            scan = Math.max(scan, buf.length - (OPEN.length - 1));
            break;
          }
          if (phase === 'thinking') {
            const j = buf.indexOf(CLOSE, scan);
            if (j !== -1) {
              pushThinking(clean(buf.slice(scan, j)));
              closeThinking();
              phase = 'text';
              scan = j + CLOSE.length;
              continue;
            }
            // hold back a possible partial close marker
            pushThinking(clean(buf.slice(scan, Math.max(scan, buf.length - (CLOSE.length - 1)))));
            scan = Math.max(scan, buf.length - (CLOSE.length - 1));
            break;
          }
          // phase === 'text'
          pushText(clean(buf.slice(scan)));
          scan = buf.length;
          break;
        }
      },

      end() {
        if (inlineMarkers && phase === 'thinking') {
          pushThinking(clean(buf.slice(scan))); // truncated reasoning: still labeled thinking
          scan = buf.length;
        }
        flushToolBuffers();
        if (stream) {
          closeThinking();
          if (textOpen) send('content_block_stop', { type: 'content_block_stop', index: blockIndex() });
        }
        if (lateDropped) console.error('[bridge] dropped ' + lateDropped + ' chars of reasoning that arrived after the answer started');
        return { thinking: thinkBuf, visible: visibleBuf, toolUses, anyToolUse };
      },

      get stats() { return { thinkChars: thinkBuf.length, visibleChars: visibleBuf.length, lateDropped, toolCalls: toolUses.length }; },
      emitToolUse: emitToolUse
    };
  }

  /* ------------------------- error mapping ------------------------ */

  function anthropicError(res, status, type, message, extra) {
    const body = { type: 'error', error: { type, message }, ...(extra || {}) };
    const buf = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length
    });
    res.end(buf);
  }

  function classifyUpstreamFailure(status, firstBytes, contentType) {
    let code = null, msg = '';
    const m = /\{"code"\s*:\s*(\d+)/.exec(firstBytes || '');
    if (m) code = Number(m[1]);
    const mm = /"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(firstBytes || '');
    if (mm) { try { msg = JSON.parse('"' + mm[1] + '"'); } catch { msg = mm[1]; } }

    if (status === 429 || code === 4004) {
      return {
        status: 429, type: 'rate_limit_error',
        message: 'Upstream daily token quota exhausted (code 4004).' + (msg ? ' Upstream says: ' + msg : '') +
          ' Quota resets at 00:00 UTC+8.',
        retryAfter: 'midnight UTC+8'
      };
    }
    if (status === 401 || status === 403) {
      return {
        status, type: 'authentication_error',
        message: 'Upstream rejected the session. Re-copy XIAOMI_USER_ID / XIAOMI_PH from a freshly logged-in browser. Both cookies must come from the same session.',
        upstream_msg: msg || undefined
      };
    }
    if (status === 402 || code === 4002 || code === 4003) {
      return { status: 402, type: 'billing_error', message: 'Upstream reports an account/quota problem. ' + (msg || firstBytes.slice(0, 200)) };
    }
    return {
      status: status >= 500 ? 502 : 500, type: 'api_error',
      message: `Upstream returned ${status} ${contentType || ''}. First bytes: ${(firstBytes || '').slice(0, 300)}`
    };
  }

  /* --------------------------- handlers --------------------------- */

  function authorized(req) {
    if (!cfg.bridgeToken) return true;
    const h = req.headers;
    const key = (h['x-api-key'] || '').trim();
    const bear = /^Bearer\s+(.*)$/i.exec(h.authorization || '');
    return key === cfg.bridgeToken || (bear && bear[1].trim() === cfg.bridgeToken);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('body too large'), { statusCode: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function callUpstream(transcript, externalSignal, account) {
    if (cfg.chatMode === 'react') return callUpstreamReact(transcript, externalSignal, account);
    return callUpstreamFastchat(transcript, externalSignal, account);
  }

  const hex32 = () => crypto.randomBytes(16).toString('hex');

  // Live-verified flow: the client generates the conversation id itself,
  // registers it via conversation/save, then chats against it. A fresh
  // conversation per request keeps the bridge stateless (no server-side
  // history duplicating the flattened transcript).
  async function newConversation(title, account) {
    const conversationId = hex32();
    const res = await fetch(withPh(cfg.upstreamBase + cfg.convPath, account), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        cookie: accountCookie(account),
        'user-agent': cfg.userAgent,
        'x-timezone': cfg.timezone,
        origin: cfg.upstreamBase,
        referer: cfg.upstreamBase + '/'
      },
      body: JSON.stringify({ conversationId, title }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!res.ok || !json || json.code !== 0 || !json.data || !json.data.conversationId) {
      throw Object.assign(new Error('conversation/save failed: HTTP ' + res.status + ' ' + text.slice(0, 200)), {
        status: res.status,
        body: text,
        contentType: res.headers.get('content-type') || ''
      });
    }
    return json.data.conversationId;
  }

  async function callUpstreamReact(transcript, externalSignal, account) {
    const model = cfg.currentModel || cfg.reactModel;
    const title = transcript.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Bridge request';
    let conversationId;
    try {
      conversationId = await newConversation(title, account);
    } catch (err) {
      throw Object.assign(new Error('could not create upstream conversation: ' + err.message), {
        status: err.status,
        body: err.body,
        contentType: err.contentType,
        cause: err
      });
    }
    const payload = {
      msgId: hex32(),
      conversationId,
      query: transcript,
      isEditedQuery: false,
      modelConfig: {
        enableThinking: cfg.enableThinking,
        webSearchStatus: 'disabled',
        model
      },
      multiMedias: []
    };
    return fetch(withPh(cfg.upstreamBase + cfg.reactPath, account), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        'accept-encoding': 'identity',
        cookie: accountCookie(account),
        'user-agent': cfg.userAgent,
        'x-timezone': cfg.timezone,
        origin: cfg.upstreamBase,
        referer: cfg.upstreamBase + '/'
      },
      body: JSON.stringify(payload),
      signal: externalSignal || AbortSignal.timeout(cfg.requestTimeoutMs),
      redirect: 'manual'
    });
  }

  async function callUpstreamFastchat(transcript, externalSignal, account) {
    const payload = {
      botId: cfg.botId,
      dialogId: '',
      messages: [{ role: 'user', content: transcript }],
      stream: true
    };
    // Escape hatch for unobserved fields (e.g. trying {"model":"mimo-v2.6-pro"}).
    // The captures never showed a model key in the chat body, but the UI keeps
    // per-conversation model config, so the field may be accepted. Experiment
    // via EXTRA_BODY without code changes. stream stays enforced.
    if (cfg.extraBody) {
      try { Object.assign(payload, JSON.parse(cfg.extraBody)); }
      catch { console.error('[bridge] EXTRA_BODY is not valid JSON — ignoring.'); }
      payload.stream = true;
    }
    const headers = {
      'content-type': 'application/json',
      accept: '*/*',
      'accept-encoding': 'identity',
      cookie: accountCookie(account),
      'user-agent': cfg.userAgent,
      'x-timezone': cfg.timezone,
      origin: cfg.upstreamBase,
      referer: cfg.upstreamBase + '/'
    };
    return fetch(withPh(cfg.upstreamBase + cfg.chatPath, account), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: externalSignal || AbortSignal.timeout(cfg.requestTimeoutMs),
      redirect: 'manual'
    });
  }

  /* Classify an in-stream `event:error` message: map the upstream error to a
   * best-fit Anthropic error envelope so the client actually sees it. */
  function classifyStreamError(text) {
    const t = String(text || '');
    if (/额度|limit|allocation|resume/i.test(t) || /今日/.test(t)) return { status: 429, type: 'rate_limit_error', message: t };
    if (/模型名称|model name/i.test(t)) return { status: 400, type: 'invalid_request_error', message: t + ' (model name rejected by upstream)' };
    return { status: 502, type: 'api_error', message: t };
  }

  async function handleMessages(req, res) {
    if (!authorized(req)) return anthropicError(res, 401, 'authentication_error', 'Bridge token mismatch (BRIDGE_TOKEN).');

    let body;
    try {
      body = JSON.parse((await readBody(req, 32 * 1024 * 1024)) || '{}');
    } catch (err) {
      return anthropicError(res, err.statusCode || 400, 'invalid_request_error', 'Request body is not valid JSON: ' + err.message);
    }

    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (!msgs.length) return anthropicError(res, 400, 'invalid_request_error', '"messages" must be a non-empty array.');
    if (!msgs.some((m) => m && m.role === 'user')) {
      return anthropicError(res, 400, 'invalid_request_error', '"messages" must contain at least one user message.');
    }

    // Model routing: deepseek-* models go to the DeepSeek handler;
    // mimo-* models pass through to MiMo; anything else maps to MiMo default.
    const requested = typeof body.model === 'string' && body.model ? body.model : '';
    if (/^deepseek-/.test(requested)) {
      if (!cfg.dsAccounts.length) {
        return anthropicError(res, 503, 'api_error', 'No DeepSeek accounts configured. Run: node chrome-auth.js --ds-write-pool');
      }
      return DS.handleDeepSeekMessages(req, res, body, { cfg });
    }
    const model = /^mimo-/.test(requested) ? requested : (cfg.chatMode === 'react' ? cfg.reactModel : 'mimo-v2.6-pro');
    cfg.currentModel = model;
    const wantStream = body.stream === true;
    const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const transcript = flatten(body);

    const attempted = new Set();
    let headersSent = false;
    let messageStarted = false;
    let lastMapped = null;

    const writeEvent = (event, data) => {
      if (!wantStream) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const ensureHeaders = () => {
      if (!wantStream || headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.flushHeaders();
    };
    const ensureMessageStart = () => {
      if (!wantStream || messageStarted) return;
      ensureHeaders();
      messageStarted = true;
      writeEvent('message_start', {
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
      });
      writeEvent('ping', { type: 'ping' });
    };
    const send = (event, data) => {
      if (!wantStream) return; // non-streaming: emitter must only accumulate
      if (event === 'message_start' || event === 'ping') return; // lifecycle is managed here
      ensureMessageStart();
      writeEvent(event, data);
    };
    const failAll = (status, type, message) => {
      if (!wantStream) return anthropicError(res, status, type, message);
      ensureMessageStart();
      writeEvent('error', { type: 'error', error: { type, message } });
      res.end();
    };

    for (;;) {
      const account = pickAccount(attempted);
      if (!account) {
        const now = Date.now();
        const exhausted = cfg.accounts.filter((a) => a.exhaustedUntil > now);
        const invalid = cfg.accounts.filter((a) => a.invalidUntil > now);
        if (exhausted.length) {
          const reset = Math.min(...exhausted.map((a) => a.exhaustedUntil));
          return failAll(429, 'rate_limit_error',
            'All ' + cfg.accounts.length + ' MiMo account(s) are out of quota. Earliest reset: ' + formatUtc8(reset) +
            (lastMapped && lastMapped.message ? '. Last upstream error: ' + lastMapped.message : '') +
            '. Add more sessions with: node chrome-auth.js --all --write-pool');
        }
        if (invalid.length) {
          return failAll(401, 'authentication_error',
            'All MiMo sessions were rejected. Refresh them with: node chrome-auth.js --all --write-pool');
        }
        return failAll(429, 'rate_limit_error', (lastMapped && lastMapped.message) || 'No usable MiMo account.');
      }

      attempted.add(account.id);
      account.lastUsedAt = Date.now();

      let upstream;
      const upstreamAbort = new AbortController();
      try {
        upstream = await callUpstream(transcript, AbortSignal.any([
          AbortSignal.timeout(cfg.requestTimeoutMs),
          upstreamAbort.signal
        ]), account);
      } catch (err) {
        const status = err && (err.status || (err.cause && err.cause.status));
        const body = (err && (err.body || (err.cause && err.cause.body))) || '';
        if (status) {
          const mapped = classifyUpstreamFailure(status, body, '');
          console.error(`[bridge] account "${account.label}" failed HTTP ${status} → ${mapped.type}`);
          if (mapped.type === 'rate_limit_error') { markQuota(account, mapped.message); lastMapped = mapped; continue; }
          if (mapped.type === 'authentication_error') { markAuth(account, mapped.message); lastMapped = mapped; continue; }
          return anthropicError(res, mapped.status, mapped.type, mapped.message);
        }
        const cause = err && err.cause ? err.cause : err;
        return anthropicError(res, 502, 'api_error', 'Could not reach upstream: ' + String((cause && (cause.code || cause.message)) || err.message || err));
      }

      const status = upstream.status;
      const contentType = upstream.headers.get('content-type') || '';

      if (status < 200 || status >= 300 || !contentType.includes('text/event-stream')) {
        let firstBytes = '';
        try {
          const reader = upstream.body.getReader();
          const parts = []; let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done || total >= 4096) { try { await reader.cancel(); } catch {} break; }
            parts.push(Buffer.from(value)); total += value.length;
          }
          firstBytes = Buffer.concat(parts).toString('utf8');
        } catch { /* diagnostic only */ }
        const mapped = classifyUpstreamFailure(status, firstBytes, contentType);
        console.error(`[bridge] upstream ${status} code=${(/\{"code"\s*:\s*(\d+)/.exec(firstBytes) || [])[1] || '?'} account="${account.label}" → ${mapped.type}`);
        if (firstBytes) console.error(`[bridge] upstream body: ${firstBytes.slice(0, 400)}`);
        if (mapped.type === 'rate_limit_error') { markQuota(account, mapped.message + ' ' + firstBytes); lastMapped = mapped; continue; }
        if (mapped.type === 'authentication_error') { markAuth(account, mapped.message + ' ' + firstBytes); lastMapped = mapped; continue; }
        return anthropicError(res, mapped.status, mapped.type, mapped.message, mapped.upstream_msg ? { upstream_msg: mapped.upstream_msg } : undefined);
      }

      ensureHeaders();

      /* ---- stream translation ---- */
      const parser = new Wire.SseParser();
      const decoder = new TextDecoder('utf-8');
      const emitter = makeEmitter(send, {
        showThinking: cfg.showThinking,
        inlineMarkers: cfg.chatMode !== 'react',
        stream: wantStream,
        toolMode: cfg.tools !== 'off' && Array.isArray(body.tools) && body.tools.length > 0
      });
      let usage = null;
      let finishSeen = false;
      let streamError = null;
      let upstreamError = null; // in-stream event:error from the upstream itself
      let toolCallsSeen = false; // native upstream function call — stop consuming

      const rawFrames = [];
      const onEvent = (ev) => {
        rawFrames.push(ev.event + ' ' + ev.data.slice(0, 200));
        const d = Wire.decodeSse(ev.event, ev.data);
        if (d.done || ev.event === 'finish') finishSeen = true;
        else if (ev.event === 'message') {
          // Native upstream function call: the model wants a CLIENT tool.
          // The backend cannot execute it (it fails with 工具调用失败), so emit
          // tool_use immediately and abort the stream before the backend's
          // doomed retry loop burns more quota.
          if (Array.isArray(d.toolCalls) && d.toolCalls.length) {
            for (const tc of d.toolCalls) {
              if (!tc || !tc.name) continue;
              let input = tc.arguments;
              if (typeof input === 'string') {
                const parsed = Wire.parseJsonLoose(input);
                input = parsed === undefined ? {} : parsed;
              }
              if (input === null || typeof input !== 'object' || Array.isArray(input)) input = {};
              emitter.emitToolUse(tc.name, input, typeof tc.id === 'string' ? tc.id : undefined);
            }
            toolCallsSeen = true;
            return;
          }
          if (d.reasoning) emitter.feedReasoning(d.reasoning);
          if (d.content) emitter.feedContent(d.content);
        }
        else if (ev.event === 'usage' && d.usage) usage = d.usage; // cumulative — last wins
        else if (ev.event === 'error' && !upstreamError) {
          upstreamError = String(d.content || ev.data || 'unknown upstream error');
        }
      };

      try {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev);
          if (toolCallsSeen) {
            try { await reader.cancel(); } catch { /* already closing */ }
            upstreamAbort.abort();
            break;
          }
        }
        if (!toolCallsSeen) {
          for (const ev of parser.flush()) onEvent(ev);
        }
      } catch (err) {
        if (!toolCallsSeen) streamError = err; // abort-on-tool-call is not an error
      }

      const { thinking, visible, toolUses, anyToolUse } = emitter.end();
      if (process.env.BRIDGE_LOG_RAW) {
        try { require('node:fs').writeFileSync(process.env.BRIDGE_LOG_RAW, rawFrames.join('\n')); } catch {}
      }

      if (upstreamError) {
        const mapped = classifyStreamError(upstreamError);
        console.error(`[bridge] account "${account.label}" in-stream error → ${mapped.type}: ${upstreamError.slice(0, 200)}`);
        // Nothing has reached the client yet: this account is simply unusable
        // for this request, so mark it and retry on the next one.
        if (!messageStarted && (mapped.type === 'rate_limit_error' || mapped.type === 'authentication_error')) {
          if (mapped.type === 'rate_limit_error') markQuota(account, upstreamError);
          else markAuth(account, upstreamError);
          lastMapped = mapped;
          continue;
        }
        if (wantStream) {
          ensureMessageStart();
          writeEvent('error', { type: 'error', error: { type: mapped.type, message: mapped.message } });
          res.end();
          return;
        }
        if (!visible.length && !thinking.length && !anyToolUse) {
          return anthropicError(res, mapped.status, mapped.type, mapped.message);
        }
        // Partial content arrived before the error: deliver what we have.
        return finishNonStream(res, visible, thinking, toolUses, usage, finishSeen, model, messageId);
      }

      console.log(`[bridge] /v1/messages model=${model} stream=${wantStream} account="${account.label}" stop=${anyToolUse ? 'tool_use' : (finishSeen ? 'end_turn' : 'max_tokens')} toolCalls=${toolUses.length} think=${thinking.length}c text=${visible.length}c`);

      if (wantStream) {
        if (streamError) {
          ensureMessageStart();
          writeEvent('error', { type: 'error', error: { type: 'api_error', message: 'Upstream stream failed: ' + streamError.message } });
        }
        ensureMessageStart();
        writeEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: anyToolUse ? 'tool_use' : (finishSeen ? 'end_turn' : 'max_tokens'), stop_sequence: null },
          usage: {
            input_tokens: usage ? usage.promptTokens : 0,
            output_tokens: usage ? usage.completionTokens : Math.ceil(visible.length / 4)
          }
        });
        writeEvent('message_stop', { type: 'message_stop' });
        res.end();
      } else {
        if (streamError) {
          return anthropicError(res, 502, 'api_error', 'Upstream stream failed: ' + streamError.message);
        }
        return finishNonStream(res, visible, thinking, toolUses, usage, finishSeen, model, messageId);
      }
      return;
    }
  }

  function finishNonStream(res, visible, thinking, toolUses, usage, finishSeen, model, messageId) {
    const content = [];
    if (cfg.showThinking && thinking) {
      content.push({ type: 'thinking', thinking, signature: 'bridge-local' });
    }
    if (visible) content.push({ type: 'text', text: visible });
    for (const tu of toolUses || []) content.push(tu);
    if (!content.length) content.push({ type: 'text', text: '' });
    const out = {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: (toolUses && toolUses.length) ? 'tool_use' : (finishSeen ? 'end_turn' : 'max_tokens'),
      stop_sequence: null,
      usage: {
        input_tokens: usage ? usage.promptTokens : 0,
        output_tokens: usage ? usage.completionTokens : Math.ceil(visible.length / 4)
      }
    };
    const buf = Buffer.from(JSON.stringify(out, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
  }

  function msgOf(firstBytes) {
    const m = /"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(firstBytes || '');
    if (!m) return undefined;
    try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
  }

  function handleCountTokens(req, res) {
    if (!authorized(req)) return anthropicError(res, 401, 'authentication_error', 'Bridge token mismatch.');
    readBody(req, 32 * 1024 * 1024).then((raw) => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* estimate anyway */ }
      const chars = flatten(body).length;
      const buf = Buffer.from(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
      res.end(buf);
    }).catch(() => anthropicError(res, 400, 'invalid_request_error', 'Could not read request body.'));
  }

  function handleModels(res) {
    const now = Math.floor(Date.now() / 1000);
    const models = [
      { id: 'mimo-v2.6-pro', object: 'model', type: 'model', created: now, owned_by: 'xiaomi', display_name: 'MiMo 2.6 Pro' },
      { id: 'mimo-v2.6-flash', object: 'model', type: 'model', created: now, owned_by: 'xiaomi', display_name: 'MiMo 2.6 Flash' },
      { id: 'mimo-v2.6-pro-ultraspeed-studio', object: 'model', type: 'model', created: now, owned_by: 'xiaomi', display_name: 'MiMo 2.6 Pro UltraSpeed' },
      { id: 'deepseek-chat', object: 'model', type: 'model', created: now, owned_by: 'deepseek', display_name: 'DeepSeek V3 (Chat)' },
      { id: 'deepseek-reasoner', object: 'model', type: 'model', created: now, owned_by: 'deepseek', display_name: 'DeepSeek R1 (Reasoner + Thinking)' }
    ];
    const buf = Buffer.from(JSON.stringify({ object: 'list', data: models }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
  }

  function handleHealth(res) {
    const buf = Buffer.from(JSON.stringify({
      service: 'xiaomi-anthropic-bridge',
      mode: cfg.chatMode,
      upstream: cfg.upstreamBase + (cfg.chatMode === 'react' ? cfg.reactPath : cfg.chatPath),
      model: cfg.chatMode === 'react' ? cfg.reactModel : cfg.botId,
      note: cfg.chatMode === 'react'
        ? 'model selectable per request: claude --model mimo-v2.6-flash'
        : 'botId selector; ~51k prompt overhead per request',
      session: {
        configured: Boolean(cfg.accounts.some((a) => a.cookie || cfg.rawCookie) || (cfg.userId && cfg.ph.raw)),
        mode: cfg.accountsSource === 'file' ? 'account-pool' : (cfg.rawCookie ? 'full-browser-cookie' : 'userId+ph'),
        poolSize: cfg.accounts.length,
        accountsSource: cfg.accountsSource,
        accounts: poolSummary()
      },
      quota: 'MiMo: daily token quota (HTTP 429 / code 4004), resets 00:00 UTC+8. DeepSeek: PoW per request, account quota applies.',
      deepseek: {
        configured: cfg.dsAccounts.length > 0,
        accountsSource: cfg.dsAccountsSource,
        poolSize: cfg.dsAccounts.length,
        accounts: cfg.dsAccounts.length ? DS.poolSummary(cfg.dsAccounts) : []
      },
      time: new Date().toISOString()
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
  }

  /* ---------------------------- server ---------------------------- */

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch {
      return anthropicError(res, 400, 'invalid_request_error', 'Malformed URL.');
    }
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'POST' && (p === '/v1/messages' || p === '/v1/messages/')) return handleMessages(req, res).catch((e) => {
      console.error('[bridge] ' + (e && e.stack ? e.stack : e));
      if (!res.headersSent) anthropicError(res, 500, 'api_error', 'Bridge internal error: ' + e.message);
      else res.end();
    });
    if (req.method === 'POST' && p === '/v1/messages/count_tokens') return handleCountTokens(req, res);
    if (req.method === 'GET' && p === '/v1/models') return handleModels(res);
    if (req.method === 'GET' && p === '/health') return handleHealth(res);

    return anthropicError(res, 404, 'not_found_error', `No route: ${req.method} ${p}. Bridge exposes /v1/messages, /v1/messages/count_tokens, /v1/models, /health.`);
  });

  return { server, cfg, flatten, contentToText, makeEmitter, classifyUpstreamFailure, poolSummary };
}

module.exports = { createBridge, normalizePh };

if (require.main === module) {
  const { server, cfg } = createBridge();
  server.listen(cfg.port, cfg.host, () => {
    const port = server.address().port;
    console.log('');
    console.log('  xiaomi-anthropic-bridge');
    console.log('  --------------------------------------------------');
    console.log(`  endpoint : http://${cfg.host}:${port}/v1/messages`);
    console.log(`  mode     : ${cfg.chatMode}`);
    console.log(`  upstream : ${cfg.upstreamBase}${cfg.chatMode === 'react' ? cfg.reactPath : cfg.chatPath}`);
    console.log(`  model    : ${cfg.chatMode === 'react' ? cfg.reactModel + ' (override: claude --model mimo-v2.6-flash)' : 'botId ' + cfg.botId}`);
    console.log(`  session  : ${cfg.accountsSource === 'file' ? 'pool of ' + cfg.accounts.length + ' account(s) — ' + cfg.accountsFile : ((cfg.userId && cfg.ph.raw) || cfg.rawCookie ? 'configured' : 'NOT configured — fill .env')}`);
    if (cfg.accountsSource === 'file') {
      const now = Date.now();
      const utc8 = (ts) => new Date(ts + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC+8';
      for (const a of cfg.accounts) {
        const state = a.exhaustedUntil > now ? 'quota until ' + utc8(a.exhaustedUntil)
          : a.invalidUntil > now ? 'invalid until ' + utc8(a.invalidUntil)
          : 'ready';
        console.log(`             ${a.label}${a.email ? ' <' + a.email + '>' : ''} — ${state}`);
      }
    }
    console.log('  quota    : MiMo daily token limit resets 00:00 UTC+8; DeepSeek PoW per request; accounts fail over automatically');
    if (cfg.dsAccounts.length) {
      console.log('  deepseek : pool of ' + cfg.dsAccounts.length + ' account(s) — ' + cfg.dsAccountsFile);
      for (const a of cfg.dsAccounts) {
        const now = Date.now();
        const state = a.exhaustedUntil > now ? 'quota' : a.invalidUntil > now ? 'invalid' : 'ready';
        console.log(`             ${a.label}${a.email ? ' <' + a.email + '>' : ''} — ${state}`);
      }
    } else {
      console.log('  deepseek : NOT configured — run: node chrome-auth.js --ds-write-pool');
    }
    console.log('  --------------------------------------------------');
    console.log('  Claude Code hookup:');
    console.log(`    export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
    console.log('    export ANTHROPIC_AUTH_TOKEN=local');
    console.log('    claude                      # default model');
    console.log('    claude --model mimo-v2.6-flash   # MiMo Flash');
    console.log('    claude --model deepseek-chat      # DeepSeek V3');
    console.log('    claude --model deepseek-reasoner  # DeepSeek R1 (thinking)');
    console.log('');
    if (!(cfg.userId && cfg.ph.raw)) {
      console.error('  !! No session credentials. POSTs will 401 upstream until .env has');
      console.error('  !! XIAOMI_USER_ID and XIAOMI_PH (DevTools > Application > Cookies).');
      console.error('');
    }
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') { console.error(`Port ${cfg.port} in use. Set PORT in .env.`); process.exit(1); }
    console.error('[bridge] ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log('\n[bridge] shutting down.'); server.close(() => process.exit(0)); });
  }
}
