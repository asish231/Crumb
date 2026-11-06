'use strict';

/* server.js — mock streaming-chat upstream + live viewer for manual testing.
 *
 * Routes:
 *   GET /                     live viewer page (browser)
 *   GET /wire.js              serves wire.js to the browser
 *   GET /stream               SSE stream in the observed wire format
 *       ?mode=clean|mojibake  mojibake reproduces the UTF-8-as-cp1252 capture bug
 *       &chunk=N              max bytes per socket write (default 13) — forces
 *                             frames AND multibyte chars to split mid-sequence
 *       &delay=ms             delay between writes (default 8)
 *
 * Run: node server.js   (PORT env or 8787; PORT=0 picks an ephemeral port)
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WIRE_PATH = path.join(__dirname, 'wire.js');

const THINKING_TEXT = 'User wants a greeting. Keep it short, no preamble, answer directly.';
const VISIBLE_TEXT = 'Hello — “smart quotes” — café, naïve 😀 中文 — all good.';

function runId() {
  return crypto.randomUUID().replace(/-/g, '');
}

// utf8 bytes read back as latin1 — exactly the capture bug being reproduced
function mojibake(s) {
  return Buffer.from(s, 'utf8').toString('latin1');
}

function buildContent(mode) {
  var text =
    '\u003cthink\u003e' + '\u0000' + THINKING_TEXT +
    '\u003c/think\u003e' + '\u0000\u0000\u0000' +
    VISIBLE_TEXT;
  if (mode === 'mojibake') text = mojibake(text);
  return text;
}

// Split into delta-sized pieces without breaking surrogate pairs.
function safeSplit(text, n) {
  var out = [];
  var i = 0;
  while (i < text.length) {
    var j = Math.min(i + n, text.length);
    if (j < text.length) {
      var prev = text.charCodeAt(j - 1);
      var next = text.charCodeAt(j);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) j += 1;
    }
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

// Full stream as text — exported for tests.
function buildStreamText(mode) {
  return buildFastchatStreamText(mode);
}

function buildFastchatStreamText(mode) {
  var id = runId();
  var parts = [];
  parts.push('id:' + id + '\nevent:dialogId\ndata:' +
    JSON.stringify({ type: null, content: '1706691', usage: null }) + '\n\n');

  var deltas = safeSplit(buildContent(mode), 9);
  var completion = 0;
  for (var k = 0; k < deltas.length; k++) {
    completion += 7;
    var usage = {
      promptTokens: 4279,
      completionTokens: completion,
      totalTokens: 4279 + completion,
      nativeUsage: {
        completion_tokens: completion,
        prompt_tokens: 4279,
        total_tokens: 4279 + completion,
        prompt_tokens_details: { cached_tokens: 2176 },
        completion_tokens_details: { reasoning_tokens: Math.max(0, completion - 1) }
      }
    };
    parts.push('id:' + id + '\nevent:message\ndata:' +
      JSON.stringify({ type: 'text', content: deltas[k], usage: null }) + '\n\n');
    parts.push('id:' + id + '\nevent:usage\ndata:' + JSON.stringify(usage) + '\n\n');
  }

  parts.push('id:' + id + '\nevent:finish\ndata:' +
    JSON.stringify({ type: null, content: '[DONE]', usage: null }) + '\n\n');
  return parts.join('');
}

/* React-endpoint stream format (what the web app actually uses):
 *   - reasoning arrives in a SEPARATE `reasoningContent` field (no think tags)
 *   - visible text in `content`; finish is {"content":"[DONE]"}  */
function buildReactStreamText() {
  const id = runId();
  const parts = [];
  parts.push('id:' + id + '\nevent:dialogId\ndata:' + JSON.stringify({ content: '21754468' }) + '\n\n');
  for (const piece of safeSplit(THINKING_TEXT, 5)) {
    parts.push('id:' + id + '\nevent:message\ndata:' +
      JSON.stringify({ messageType: 'assistant', reasoningContent: piece }) + '\n\n');
  }
  let completion = 0;
  for (const piece of safeSplit(VISIBLE_TEXT, 5)) {
    completion += 3;
    parts.push('id:' + id + '\nevent:message\ndata:' +
      JSON.stringify({ messageType: 'assistant', content: piece }) + '\n\n');
    parts.push('id:' + id + '\nevent:usage\ndata:' + JSON.stringify({
      promptTokens: 3810, completionTokens: completion, totalTokens: 3810 + completion,
      nativeUsage: { completion_tokens: completion, prompt_tokens: 3810, total_tokens: 3810 + completion }
    }) + '\n\n');
  }
  parts.push('id:' + id + '\nevent:finish\ndata:' + JSON.stringify({ content: '[DONE]' }) + '\n\n');
  return parts.join('');
}

const VIEWER_HTML = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<title>Crumb viewer (mock)</title>\n<style>\n' +
  '  body { font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; background: #111; color: #ddd; }\n' +
  '  button { font: inherit; background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 4px 10px; cursor: pointer; }\n' +
  '  button:hover { border-color: #888; }\n' +
  '  .think { color: #777; border-left: 2px solid #333; padding-left: 10px; margin: 8px 0; white-space: pre-wrap; }\n' +
  '  .out { white-space: pre-wrap; margin: 8px 0; }\n' +
  '  .stats { color: #888; margin-top: 16px; white-space: pre-wrap; }\n' +
  '</style>\n</head>\n<body>\n' +
  '<h3>Crumb viewer (mock)</h3>\n' +
  '<p><button id="go">stream clean</button> <button id="goBad">stream mojibake</button> (both auto-repair on finish)</p>\n' +
  '<div id="think" class="think"></div>\n<div id="out" class="out"></div>\n<div id="stats" class="stats"></div>\n' +
  '<script src="/wire.js"></script>\n' +
  '<script>\n' +
  'var out = document.getElementById("out"), think = document.getElementById("think"), stats = document.getElementById("stats");\n' +
  'function run(mode) {\n' +
  '  out.textContent = ""; think.textContent = ""; stats.textContent = "";\n' +
  '  var dec = new TextDecoder("utf-8");\n' +
  '  var parser = new Wire.SseParser();\n' +
  '  var asm = new Wire.StreamAssembler();\n' +
  '  var frames = 0, finish = false, dialogId = null, usage = null;\n' +
  '  fetch("/stream?mode=" + mode + "&chunk=7").then(function (r) { return r.body.getReader(); }).then(function (reader) {\n' +
  '    function step() {\n' +
  '      return reader.read().then(function (r) {\n' +
  '        if (r.done) return;\n' +
  '        var evs = parser.push(dec.decode(r.value, { stream: true }));\n' +
  '        for (var i = 0; i < evs.length; i++) {\n' +
  '          frames++;\n' +
  '          var d = Wire.decodeSse(evs[i].event, evs[i].data);\n' +
  '          if (evs[i].event === "dialogId" && d.dialogId) dialogId = d.dialogId;\n' +
  '          else if (evs[i].event === "message" && d.content) { asm.push(d.content); paint(asm.project()); }\n' +
  '          else if (evs[i].event === "usage" && d.usage) usage = d.usage;\n' +
  '          else if (d.done || evs[i].event === "finish") finish = true;\n' +
  '        }\n' +
  '        return step();\n' +
  '      });\n' +
  '    }\n' +
  '    return step();\n' +
  '  }).then(function () {\n' +
  '    var f = asm.finish();\n' +
  '    f.visible = Wire.fixMojibake(f.visible);\n' +
  '    paint(f);\n' +
  '    stats.textContent =\n' +
  '      "dialog     " + dialogId + "\\n" +\n' +
  '      "frames     " + frames + " (finish: " + finish + ")\\n" +\n' +
  '      "deltas     " + f.deltas + "\\n" +\n' +
  '      "thinking   " + f.thinking.length + " chars\\n" +\n' +
  '      "usage      completion " + (usage && usage.completionTokens) + " / total " + (usage && usage.totalTokens);\n' +
  '  }).catch(function (e) { stats.textContent = "error: " + e; });\n' +
  '}\n' +
  'function paint(p) {\n' +
  '  out.textContent = Wire.fixMojibake(p.visible);\n' +
  '  think.textContent = p.thinking ? "reasoning: " + Wire.fixMojibake(p.thinking) : "";\n' +
  '}\n' +
  'document.getElementById("go").onclick = function () { run("clean"); };\n' +
  'document.getElementById("goBad").onclick = function () { run("mojibake"); };\n' +
  '</script>\n</body>\n</html>\n';

function createServer(options) {
  options = options || {};
  // Failover-test support: requests whose Cookie header contains any of these
  // substrings are answered with a quota failure instead of a clean stream.
  var quotaCookies = Array.isArray(options.quotaCookies) ? options.quotaCookies : [];
  var quotaMode = options.quotaMode === 'stream' ? 'stream' : 'http';

  function cookieHasQuota(req) {
    if (!quotaCookies.length) return false;
    var cookie = req.headers.cookie || '';
    return quotaCookies.some(function (needle) { return cookie.indexOf(needle) !== -1; });
  }

  function sendQuota(res) {
    var msg = '今日 Token 额度已达上限，次日 0 点（UTC+8）恢复';
    if (quotaMode === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end('id:x\nevent:error\ndata:' + JSON.stringify({ type: 'text', content: msg }) + '\n\n');
      return;
    }
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 4004, msg: msg, data: null, traceId: null, spendTime: null }));
  }

  return http.createServer(function (req, res) {
    var url = new URL(req.url, 'http://localhost');
    var p = url.pathname;

    if (p === '/wire.js') {
      var js = fs.readFileSync(WIRE_PATH);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(js);
      return;
    }

    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(VIEWER_HTML);
      return;
    }

    // Native tool calling: the model emits a toolCalls frame (observed shape),
    // the backend would fail executing client tools, so the bridge must catch
    // it and abort. Frames after the toolCalls frame simulate the backend's
    // doomed retry loop — the bridge must NOT consume them.
    if (p === '/toolcall-stream') {
      var tid = runId();
      var tcFrames = [
        { messageType: 'assistant', content: 'Let me look that up for you.\n' },
        { messageType: 'assistant', toolCalls: [{ id: 'call_test123', type: 'function', name: 'list_files', arguments: '{"path": "."}' }] },
        { messageType: 'tool', responses: [{ id: 'call_test123', name: 'list_files', responseData: '工具调用失败，请重新判断' }] },
        { messageType: 'assistant', content: 'SHOULD-NOT-APPEAR backend retry text' }
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.flushHeaders();
      var ti = 0;
      var tclosed2 = false;
      req.on('close', function () { tclosed2 = true; });
      (function writeTcFrame() {
        if (tclosed2 || res.writableEnded) return;
        if (ti >= tcFrames.length) {
          res.write('id:' + tid + '\nevent:finish\ndata:' + JSON.stringify({ content: '[DONE]' }) + '\n\n');
          res.end();
          return;
        }
        res.write('id:' + tid + '\nevent:message\ndata:' + JSON.stringify(tcFrames[ti]) + '\n\n');
        ti += 1;
        setTimeout(writeTcFrame, 0);
      })();
      return;
    }

    if (p === '/open-apis/chat/conversation/save') {
      // Mirror the observed contract: client sends a generated id + title,
      // server accepts and echoes the conversation record.
      var chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () {
        var body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {}
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          code: 0, msg: '成功',
          data: {
            id: 15893177, creator: '1234567890',
            createTime: new Date().toISOString(), updater: '1234567890',
            updateTime: new Date().toISOString(),
            title: (body && body.title) || 'New conversation',
            conversationId: (body && body.conversationId) || runId().slice(0, 32),
            deleteFlag: 0, type: 'chat'
          }
        }));
      });
      return;
    }

    if (p === '/open-apis/react/chat') {
      if (cookieHasQuota(req)) { sendQuota(res); return; }
      var bytes = Buffer.from(buildReactStreamText(), 'utf8');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });
      res.flushHeaders();
      var off2 = 0;
      var closed2 = false;
      req.on('close', function () { closed2 = true; });
      (function writeNext2() {
        if (closed2 || res.writableEnded) return;
        if (off2 >= bytes.length) { res.end(); return; }
        res.write(bytes.subarray(off2, Math.min(off2 + 7, bytes.length)));
        off2 += 7;
        setTimeout(writeNext2, 0);
      })();
      return;
    }

    if (p === '/stream') {
      var mode = url.searchParams.get('mode') || 'clean';
      if (cookieHasQuota(req)) { sendQuota(res); return; }

      // Reproductions of the two observed upstream failure shapes so the
      // bridge's error translation can be tested without burning real quota.
      if (mode === 'quota') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          code: 4004,
          msg: '今日 Token 额度已达上限，次日 0 点（UTC+8）恢复',
          data: null, traceId: null, spendTime: null
        }));
        return;
      }
      if (mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 401, msg: 'unauthorized', data: null }));
        return;
      }
      // In-stream error frames (HTTP 200 + event:error) — the react endpoint's
      // observed failure style, e.g. wrong model name or per-model quota.
      if (mode === 'modelerror' || mode === 'quota-stream') {
        var msg = mode === 'modelerror' ? '模型名称错误' : '今日 Token 额度已达上限，次日 0 点（UTC+8）恢复';
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end('id:x\nevent:error\ndata:' + JSON.stringify({ type: 'text', content: msg }) + '\n\n');
        return;
      }

      mode = mode === 'mojibake' ? 'mojibake' : 'clean';
      var chunk = Math.max(1, Math.min(4096, Number(url.searchParams.get('chunk')) || 13));
      var delay = Math.max(0, Math.min(500, Number(url.searchParams.get('delay')) || 8));
      var bytes = Buffer.from(buildStreamText(mode), 'utf8');

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });
      res.flushHeaders();

      var off = 0;
      var closed = false;
      req.on('close', function () { closed = true; });

      (function writeNext() {
        if (closed || res.writableEnded) return;
        if (off >= bytes.length) { res.end(); return; }
        res.write(bytes.subarray(off, Math.min(off + chunk, bytes.length)));
        off += chunk;
        setTimeout(writeNext, delay);
      })();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });
}

module.exports = {
  createServer: createServer,
  buildStreamText: buildStreamText,
  buildReactStreamText: buildReactStreamText,
  VISIBLE_TEXT: VISIBLE_TEXT,
  THINKING_TEXT: THINKING_TEXT
};

if (require.main === module) {
  var port = Number(process.env.PORT) || 8787;
  var server = createServer();
  server.listen(port, function () {
    var actual = server.address().port;
    console.log('Crumb mock upstream');
    console.log('  stream : http://127.0.0.1:' + actual + '/stream?mode=clean');
    console.log('           http://127.0.0.1:' + actual + '/stream?mode=mojibake');
    console.log('  viewer : http://127.0.0.1:' + actual + '/');
  });
}
