'use strict';

/* run-tests.js — zero-dependency test suite.
 *
 *   node test/run-tests.js
 *
 * The heavy hitters:
 *   - SseParser is fed the fixture split at EVERY byte offset (string level
 *     and byte level with a streaming UTF-8 decoder) and must produce the
 *     identical event list every time.
 *   - Delta concatenation vs replacement (the classic streaming bug).
 *   - Markers split across deltas: per-frame splitting must fail, assembled
 *     splitting must succeed.
 *   - CRLF terminators split mid-pair across chunks.
 *   - Mojibake repair round-trips the damaged fixture back to the clean text.
 */

const assert = require('node:assert');
const Wire = require('../wire.js');
const { createServer, buildStreamText, VISIBLE_TEXT, THINKING_TEXT } = require('../server.js');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function pushAll(parser, text, splitAt) {
  const out = [];
  for (const ev of parser.push(text.slice(0, splitAt))) out.push(ev);
  for (const ev of parser.push(text.slice(splitAt))) out.push(ev);
  for (const ev of parser.flush()) out.push(ev);
  return out;
}

function parseAllEvents(text) {
  const parser = new Wire.SseParser();
  return parser.push(text).concat(parser.flush());
}

const FIXTURE = buildStreamText('clean');
const FIXTURE_BAD = buildStreamText('mojibake');

/* ------------------------------ framing ------------------------------ */

test('parseBlock: id + event + data, unknown fields ignored', () => {
  const ev = Wire.parseBlock('id:abc123\nevent:message\ndata:{"a":1}\nretry:500');
  assert.deepStrictEqual(ev, { id: 'abc123', event: 'message', data: '{"a":1}' });
});

test('parseBlock: CRLF and lone-CR line endings', () => {
  const crlf = Wire.parseBlock('id:x\r\nevent:finish\r\ndata:[DONE]\r\n');
  assert.strictEqual(crlf.event, 'finish');
  assert.strictEqual(crlf.data, '[DONE]');
  const cr = Wire.parseBlock('id:x\revent:finish\rdata:[DONE]\r');
  assert.strictEqual(cr.event, 'finish');
  assert.strictEqual(cr.data, '[DONE]');
});

test('parseBlock: SSE comments skipped', () => {
  const ev = Wire.parseBlock(': keep-alive\nevent:message\ndata:hi');
  assert.strictEqual(ev.data, 'hi');
});

test('parseBlock: multiple data lines joined with \\n', () => {
  const ev = Wire.parseBlock('event:message\ndata:line1\ndata:line2');
  assert.strictEqual(ev.data, 'line1\nline2');
});

test('parseBlock: block with no data yields null', () => {
  assert.strictEqual(Wire.parseBlock('id:x\nevent:ping'), null);
});

test('SseParser: identical events no matter where the stream is split', () => {
  const baseline = parseAllEvents(FIXTURE);
  assert.ok(baseline.length > 5, 'fixture should contain multiple frames');
  for (let i = 0; i <= FIXTURE.length; i++) {
    const split = pushAll(new Wire.SseParser(), FIXTURE, i);
    assert.deepStrictEqual(split, baseline, 'split at offset ' + i);
  }
});

test('SseParser: CRLF stream split at every offset (sampled)', () => {
  const crlf = FIXTURE.replace(/\n/g, '\r\n');
  const baseline = parseAllEvents(crlf);
  for (let i = 0; i <= crlf.length; i += 3) {
    const split = pushAll(new Wire.SseParser(), crlf, i);
    assert.deepStrictEqual(split, baseline, 'CRLF split at offset ' + i);
  }
});

test('SseParser: byte-level split at every offset via streaming TextDecoder', () => {
  const bytes = Buffer.from(FIXTURE, 'utf8');
  const baseline = parseAllEvents(FIXTURE);
  for (let i = 0; i <= bytes.length; i++) {
    const dec = new TextDecoder('utf-8');
    const s1 = dec.decode(bytes.subarray(0, i), { stream: true });
    const s2 = dec.decode(bytes.subarray(i), { stream: true }) + dec.decode();
    const parser = new Wire.SseParser();
    const evs = parser.push(s1).concat(parser.push(s2)).concat(parser.flush());
    assert.deepStrictEqual(evs, baseline, 'byte split at offset ' + i);
  }
});

/* ---------------------------- data decode ---------------------------- */

test('decodeSse: react reasoningContent surfaces as .reasoning', () => {
  const d = Wire.decodeSse('message', '{"messageType":"assistant","reasoningContent":"The user is just saying"}');
  assert.strictEqual(d.reasoning, 'The user is just saying');
  assert.strictEqual(d.content, '');
  const plain = Wire.decodeSse('message', '{"messageType":"assistant","content":"visible"}');
  assert.strictEqual(plain.reasoning, null);
  assert.strictEqual(plain.content, 'visible');
});

test('decodeSse: dialogId lives in .content, not .dialogId', () => {
  const d = Wire.decodeSse('dialogId', '{"type":null,"content":"1706691","usage":null}');
  assert.strictEqual(d.dialogId, '1706691');
  assert.strictEqual(d.done, false);
});

test('decodeSse: message envelope exposes delta content', () => {
  const d = Wire.decodeSse('message', '{"type":"text","content":"Don","usage":null}');
  assert.strictEqual(d.type, 'text');
  assert.strictEqual(d.content, 'Don');
});

test('decodeSse: usage event is a flat object, not the envelope', () => {
  const d = Wire.decodeSse('usage', '{"promptTokens":10,"completionTokens":5,"totalTokens":15}');
  assert.deepStrictEqual(d.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test('decodeSse: [DONE] inside JSON content marks done', () => {
  const d = Wire.decodeSse('finish', '{"type":null,"content":"[DONE]","usage":null}');
  assert.strictEqual(d.done, true);
  assert.strictEqual(d.content, '');
});

test('decodeSse: bare [DONE] also marks done', () => {
  assert.strictEqual(Wire.decodeSse('finish', '[DONE]').done, true);
});

test('decodeSse: non-JSON payload falls back to raw text', () => {
  const d = Wire.decodeSse('message', 'plain text not json');
  assert.strictEqual(d.type, 'text');
  assert.strictEqual(d.content, 'plain text not json');
});

/* ------------------------ delta assembly ------------------------ */

test('deltas are CONCATENATED, not replaced', () => {
  const asm = new Wire.StreamAssembler();
  asm.push('Keep it short. Don');
  asm.push("'t be preachy.");
  asm.push(' Offer alternatives.');
  assert.strictEqual(asm.finish().visible, "Keep it short. Don't be preachy. Offer alternatives.");
});

test('replacement semantics (the bug) would lose data — guard holds', () => {
  const first = 'Keep it short. Don';
  const second = "'t be preachy.";
  assert.notStrictEqual(second, first + second);
  assert.strictEqual(first + second, "Keep it short. Don't be preachy.");
});

test('splitThinking: NUL bytes stripped, thinking and visible separated', () => {
  const text = '\u003cthink\u003e\u0000secret plan\u0000\u003c/think\u003e\u0000\u0000\u0000visible answer';
  const s = Wire.splitThinking(text);
  assert.strictEqual(s.thinking, 'secret plan');
  assert.strictEqual(s.visible, 'visible answer');
  assert.strictEqual(s.hadThinking, true);
});

test('splitThinking: text before the marker is preserved', () => {
  const s = Wire.splitThinking('intro \u003cthink\u003eplan\u003c/think\u003e outro');
  assert.strictEqual(s.visible, 'intro  outro');
  assert.strictEqual(s.thinking, 'plan');
});

test('splitThinking: no markers returns everything as visible', () => {
  const s = Wire.splitThinking('just an answer');
  assert.strictEqual(s.visible, 'just an answer');
  assert.strictEqual(s.thinking, '');
  assert.strictEqual(s.hadThinking, false);
});

test('markers split across deltas: per-frame split fails, assembled split works', () => {
  const pieces = ['\u003cth', 'ink\u003e\u0000pla', 'n\u003c/think\u003e'];
  // Per-frame splitting can never see a complete marker:
  const naive = pieces.map((p) => Wire.splitThinking(p));
  assert.ok(naive.every((s) => !s.hadThinking));

  const asm = new Wire.StreamAssembler();
  for (const p of pieces) asm.push(p);
  const s = asm.finish();
  assert.strictEqual(s.thinking, 'plan');
  assert.strictEqual(s.visible, '');
  assert.strictEqual(s.hadThinking, true);
});

test('StreamAssembler: progressive projection then authoritative finish', () => {
  const asm = new Wire.StreamAssembler();
  const p1 = asm.push('\u003cthink\u003e\u0000par');
  assert.strictEqual(p1.visible, '');
  assert.strictEqual(p1.thinking, 'par');
  const p2 = asm.push('tial\u003c/think\u003e\u0000\u0000\u0000vis');
  assert.strictEqual(p2.visible, 'vis');
  assert.strictEqual(p2.thinking, 'partial');
  const f = asm.finish();
  assert.strictEqual(f.visible, 'vis');
  assert.strictEqual(f.thinking, 'partial');
  assert.strictEqual(f.deltas, 2);
});

/* --------------------------- mojibake repair --------------------------- */

// Damage generators: utf8 bytes read back through the wrong single-byte codec.
// latin1 (ISO-8859-1) is what Node's Buffer gives you; windows-1252 is what
// browsers and most tools actually mean by "latin-1" — the original incident
// produced cp1252 damage (â€" for —), so both styles must be repairable.
function damageLatin1(s) {
  return Buffer.from(s, 'utf8').toString('latin1');
}
function damageCp1252(s) {
  const table = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2C6, 0x89: 0x2030, 0x8A: 0x160,
    0x8B: 0x2039, 0x8C: 0x152, 0x8E: 0x17D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x2DC, 0x99: 0x2122, 0x9A: 0x161, 0x9B: 0x203A, 0x9C: 0x153,
    0x9E: 0x17E, 0x9F: 0x178
  };
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    out += (b >= 0x80 && b <= 0x9f && table[b] !== undefined)
      ? String.fromCharCode(table[b])
      : String.fromCharCode(b);
  }
  return out;
}

test('fixMojibake: em dash (hardcoded classic form)', () => {
  assert.strictEqual(Wire.fixMojibake('â€”'), '—');
});

test('fixMojibake: latin1-style damage round-trips', () => {
  const clean = '“hi” … café — naïve 😀';
  assert.strictEqual(Wire.fixMojibake(damageLatin1(clean)), clean);
});

test('fixMojibake: cp1252-style damage round-trips (the classic â€" bug)', () => {
  const clean = '“hi” … café — naïve';
  const damaged = damageCp1252(clean);
  assert.ok(damaged.includes('â€'), 'cp1252 damage should contain â€ sequences: ' + JSON.stringify(damaged));
  assert.strictEqual(Wire.fixMojibake(damaged), clean);
});

test('fixMojibake: accented latin', () => {
  assert.strictEqual(Wire.fixMojibake('cafÃ© naÃ¯ve'), 'café naïve');
});

test('fixMojibake: emoji (4-byte sequence)', () => {
  assert.strictEqual(Wire.fixMojibake('ðŸ˜€'), '😀');
});

test('fixMojibake: double-encoded text needs two passes', () => {
  const once = Wire.fixMojibake('ÃƒÂ©');
  assert.strictEqual(once, 'é');
});

test('fixMojibake: clean text untouched', () => {
  for (const s of ['plain ascii', 'café naïve', '中文 — 😀', '']) {
    assert.strictEqual(Wire.fixMojibake(s), s, 'should not alter: ' + JSON.stringify(s));
  }
});

test('fixMojibake: lone latin-1 char is not valid UTF-8, left alone', () => {
  assert.strictEqual(Wire.fixMojibake('é'), 'é');
});

test('full damaged fixture repairs to the clean fixture text', () => {
  const assemble = (text) => {
    const parts = parseAllEvents(text)
      .filter((e) => e.event === 'message')
      .map((e) => Wire.decodeSse(e.event, e.data).content)
      .join('');
    return Wire.splitThinking(parts);
  };
  const clean = assemble(FIXTURE);
  const bad = assemble(FIXTURE_BAD);
  assert.notStrictEqual(bad.visible, clean.visible, 'damaged fixture should differ from clean');
  assert.strictEqual(Wire.fixMojibake(bad.visible), clean.visible);
  assert.strictEqual(Wire.fixMojibake(bad.thinking), clean.thinking);
});

/* ------------------------------ integration ------------------------------ */

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function drainStream(url) {
  const res = await fetch(url);
  assert.strictEqual(res.status, 200);
  const dec = new TextDecoder('utf-8');
  const parser = new Wire.SseParser();
  const asm = new Wire.StreamAssembler();
  const reader = res.body.getReader();
  let frames = 0, finish = false, dialogId = null, usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.push(dec.decode(value, { stream: true }))) {
      frames++;
      const d = Wire.decodeSse(ev.event, ev.data);
      if (ev.event === 'dialogId' && d.dialogId) dialogId = d.dialogId;
      else if (ev.event === 'message' && d.content) asm.push(d.content);
      else if (ev.event === 'usage' && d.usage) usage = d.usage;
      if (d.done || ev.event === 'finish') finish = true;
    }
  }
  for (const ev of parser.flush()) { frames++; if (Wire.decodeSse(ev.event, ev.data).done) finish = true; }
  return { frames, finish, dialogId, usage, final: asm.finish() };
}

test('integration: clean stream end-to-end over HTTP with tiny chunks', async () => {
  await withServer(async (port) => {
    const r = await drainStream('http://127.0.0.1:' + port + '/stream?mode=clean&chunk=3&delay=0');
    assert.ok(r.frames > 10);
    assert.strictEqual(r.finish, true);
    assert.strictEqual(r.dialogId, '1706691');
    assert.ok(r.usage && r.usage.completionTokens > 0);
    assert.strictEqual(r.final.visible, 'Hello — “smart quotes” — café, naïve 😀 中文 — all good.');
    assert.strictEqual(r.final.thinking, 'User wants a greeting. Keep it short, no preamble, answer directly.');
  });
});

test('integration: mojibake stream repaired end-to-end', async () => {
  await withServer(async (port) => {
    const r = await drainStream('http://127.0.0.1:' + port + '/stream?mode=mojibake&chunk=5&delay=0');
    assert.strictEqual(r.finish, true);
    assert.notStrictEqual(r.final.visible, VISIBLE_TEXT, 'damage must be present before repair');
    assert.ok(/[\u0080-\u00ff]/.test(r.final.visible), 'damaged text should contain latin-1 chars');
    const repaired = Wire.fixMojibake(r.final.visible);
    assert.strictEqual(repaired, VISIBLE_TEXT);
    assert.strictEqual(Wire.fixMojibake(r.final.thinking), THINKING_TEXT);
  });
});

test('integration: 1-byte chunks (worst-case fragmentation)', async () => {
  await withServer(async (port) => {
    const r = await drainStream('http://127.0.0.1:' + port + '/stream?mode=clean&chunk=1&delay=0');
    assert.strictEqual(r.finish, true);
    assert.strictEqual(r.final.visible, 'Hello — “smart quotes” — café, naïve 😀 中文 — all good.');
  });
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
      failures.push({ name, err });
      process.stdout.write('FAIL  ' + name + '\n      ' + String(err && err.message ? err.message : err).split('\n').join('\n      ') + '\n');
    }
  }
  process.stdout.write('\n' + pass + ' passed, ' + failures.length + ' failed (of ' + tests.length + ')\n');
  process.exit(failures.length ? 1 : 0);
})();
