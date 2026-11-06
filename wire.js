'use strict';

/* wire.js — SSE parsing + stream assembly for the observed chat wire format.
 *
 * Node:    const Wire = require('./wire.js')
 * Browser: <script src="wire.js"></script>   ->  window.Wire
 *
 * Frame format (three lines, blank-line terminated):
 *   id:<opaque run id>
 *   event:<dialogId | message | usage | finish>
 *   data:<json>
 *
 * Rules that matter:
 *   1. `content` on event:message is an INCREMENTAL DELTA. Concatenate deltas;
 *      never replace the buffer with the newest frame.
 *   2. The dialog id lives in `.content` of the dialogId frame — there is no
 *      `dialogId` key in the payload.
 *   3. `event:usage` carries a FLAT object (not the type/content envelope)
 *      with cumulative counts; the last frame wins.
 *   4. `[DONE]` arrives inside JSON `content`, not as a bare data line.
 *   5. Reasoning is inlined in the same `content` stream between the literal
 *      markers below, with NUL (U+0000) bytes right after each marker. Split
 *      AFTER assembling the full buffer, never per frame.
 *   6. Never decode network chunks in isolation: multibyte UTF-8 sequences
 *      straddling a chunk boundary corrupt unless you use a streaming decoder
 *      (TextDecoder with {stream:true} / StringDecoder).
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.Wire = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var THINK_OPEN = '\u003cthink\u003e';
  var THINK_CLOSE = '\u003c/think\u003e';

  function parseJsonLoose(text) {
    try { return JSON.parse(text); } catch (e) { return undefined; }
  }

  /* ------------------------- SSE framing ------------------------- */

  function parseBlock(block) {
    var event = 'message';
    var id = null;
    var data = [];
    var lines = String(block).replace(/\r\n?/g, '\n').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.charAt(0) === ':') continue; // SSE comment / keep-alive
      if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.indexOf('id:') === 0) id = line.slice(3).trim();
      // unknown fields are ignored, per the SSE spec
    }
    if (!data.length) return null;
    return { id: id, event: event, data: data.join('\n') };
  }

  function SseParser() {
    this.buf = '';
  }

  SseParser.prototype.push = function (text) {
    this.buf += String(text);
    // A trailing CR may be the first half of a CRLF pair that arrives in the
    // next chunk — hold it back so it can be normalized as a pair.
    var hold = '';
    if (this.buf.charAt(this.buf.length - 1) === '\r') {
      hold = '\r';
      this.buf = this.buf.slice(0, -1);
    }
    this.buf = this.buf.replace(/\r\n?/g, '\n');

    var out = [];
    var idx;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      var block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      var ev = parseBlock(block);
      if (ev) out.push(ev);
    }
    this.buf += hold;
    return out;
  };

  SseParser.prototype.flush = function () {
    if (!this.buf) return [];
    var buf = this.buf.replace(/\r\n?/g, '\n');
    this.buf = '';
    var ev = parseBlock(buf);
    return ev ? [ev] : [];
  };

  /* --------------------- data payload decode --------------------- */

  function decodeSse(event, raw) {
    var trimmed = String(raw === undefined || raw === null ? '' : raw).trim();
    var out = {
      event: event,
      raw: trimmed,
      type: null,
      content: '',
      reasoning: null,
      messageType: null,
      toolCalls: null,
      usage: null,
      dialogId: null,
      done: false
    };

    if (trimmed === '[DONE]') { out.done = true; return out; }

    if (event === 'usage') {
      var u = parseJsonLoose(trimmed);
      out.usage = u && typeof u === 'object' && !Array.isArray(u) ? u : null;
      return out;
    }

    var obj = parseJsonLoose(trimmed);
    if (obj !== undefined && obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      out.type = typeof obj.type === 'string' ? obj.type : null;
      out.content = typeof obj.content === 'string' ? obj.content : '';
      out.reasoning = typeof obj.reasoningContent === 'string' ? obj.reasoningContent : null;
      out.messageType = typeof obj.messageType === 'string' ? obj.messageType : null;
      out.toolCalls = Array.isArray(obj.toolCalls) ? obj.toolCalls : null;
      out.usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;
    } else if (typeof obj === 'string') {
      out.type = 'text';
      out.content = obj;
    } else if (trimmed) {
      out.type = 'text';
      out.content = trimmed;
    }

    if (out.content === '[DONE]') { out.done = true; out.content = ''; }
    if (event === 'dialogId') out.dialogId = out.content || null;

    return out;
  }

  /* --------------------- assembly / cleanup --------------------- */

  function stripNul(s) {
    return String(s === undefined || s === null ? '' : s).replace(/\u0000/g, '');
  }

  // Call on the ASSEMBLED buffer. Per-frame splitting breaks whenever a
  // marker itself straddles two deltas.
  function splitThinking(text) {
    var cleaned = stripNul(text);
    var open = cleaned.indexOf(THINK_OPEN);
    var close = cleaned.indexOf(THINK_CLOSE);
    if (open === -1 || close === -1 || close < open) {
      return { thinking: '', visible: cleaned, hadThinking: false };
    }
    return {
      thinking: cleaned.slice(open + THINK_OPEN.length, close).trim(),
      visible: stripNul(cleaned.slice(0, open) + cleaned.slice(close + THINK_CLOSE.length)).trim(),
      hadThinking: true
    };
  }

  /* Incremental accumulator for live UIs: push each delta, read the current
   * best-effort projection, then call finish() for the authoritative result. */
  function StreamAssembler() {
    this.raw = '';
    this.deltas = 0;
  }

  StreamAssembler.prototype.push = function (delta) {
    this.raw += String(delta === undefined || delta === null ? '' : delta);
    this.deltas += 1;
    return this.project();
  };

  StreamAssembler.prototype.project = function () {
    var open = this.raw.indexOf(THINK_OPEN);
    if (open === -1) {
      return { thinking: '', visible: stripNul(this.raw), hadThinking: false, complete: false };
    }
    var close = this.raw.indexOf(THINK_CLOSE, open);
    if (close === -1) {
      return {
        thinking: stripNul(this.raw.slice(open + THINK_OPEN.length)).trim(),
        visible: stripNul(this.raw.slice(0, open)),
        hadThinking: true,
        complete: false
      };
    }
    var s = splitThinking(this.raw);
    s.complete = true;
    return s;
  };

  StreamAssembler.prototype.finish = function () {
    var s = splitThinking(this.raw);
    s.deltas = this.deltas;
    return s;
  };

  /* ------------------------- mojibake repair ---------------------
   * Repairs text that was UTF-8 encoded, then decoded as cp1252/latin-1
   * (the classic "â€” for —" capture bug). Rebuilds the original byte
   * sequence and re-decodes it as UTF-8. Conservative: returns the input
   * unchanged unless the rebuilt bytes form valid UTF-8 and the result
   * actually reduces latin-1 supplement characters. */

  var CP1252_HIGH = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };

  function latin1Score(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x80 && c <= 0xff) n++;
    }
    return n;
  }

  function decodeStrictUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (e) {
        return null;
      }
    }
    if (typeof Buffer !== 'undefined') {
      try {
        var b = Buffer.from(bytes);
        var s = b.toString('utf8');
        // Node decodes invalid sequences to U+FFFD; verify by re-encoding.
        return Buffer.from(s, 'utf8').equals(b) ? s : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function fixMojibakeOnce(str) {
    if (!/[\u0080-\u00ff]/.test(str)) return null; // nothing that could be damaged
    var bytes = new Uint8Array(str.length);
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes[n++] = c;
      else if (c <= 0xff) bytes[n++] = c;
      else if (CP1252_HIGH[c] !== undefined) bytes[n++] = CP1252_HIGH[c];
      else return null; // genuine non-latin1 content — not repairable here
    }
    var decoded = decodeStrictUtf8(bytes.subarray(0, n));
    if (decoded === null || decoded === str) return null;
    if (latin1Score(decoded) >= latin1Score(str)) return null; // must reduce damage
    return decoded;
  }

  function fixMojibake(s) {
    var str = String(s === undefined || s === null ? '' : s);
    for (var pass = 0; pass < 3; pass++) { // handles double-encoded text too
      var fixed = fixMojibakeOnce(str);
      if (fixed === null) break;
      str = fixed;
    }
    return str;
  }

  return {
    THINK_OPEN: THINK_OPEN,
    THINK_CLOSE: THINK_CLOSE,
    SseParser: SseParser,
    parseBlock: parseBlock,
    decodeSse: decodeSse,
    splitThinking: splitThinking,
    StreamAssembler: StreamAssembler,
    stripNul: stripNul,
    fixMojibake: fixMojibake,
    parseJsonLoose: parseJsonLoose
  };
});
