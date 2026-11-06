# Crumb

Parses a streaming chat wire format. Zero dependencies, Node >= 18, browser-compatible core.

Detailed setup, architecture and OS guides live in [`docs/`](docs/README.md):
architecture & PoW internals, exactly which fields to collect, macOS Full
Disk Access, Windows/Linux manual collection, and an agent bring-up guide.

## The wire format

Three-line SSE frames, blank-line terminated:

```
id:<opaque run id>
event:<dialogId | message | usage | finish>
data:<json>
```

| event | data shape | notes |
|---|---|---|
| `dialogId` | `{"type":null,"content":"<ID>","usage":null}` | id lives in **`.content`** — there is no `dialogId` key |
| `message` | `{"type":"text","content":"<DELTA>","usage":null}` | content is an **incremental delta** — concatenate |
| `usage` | `{"promptTokens":N,"completionTokens":N,"totalTokens":N,...}` | **flat object**, not the envelope; cumulative, last frame wins |
| `finish` | `{"type":null,"content":"[DONE]","usage":null}` | `[DONE]` is inside JSON, not a bare line |

Reasoning is **inlined** in the same `content` stream between `–and`-style
markers (literal `ҿink>` / `ҿ/ink>` tags) with NUL (U+0000) bytes right after
each marker. Markers span multiple deltas, so splitting must happen on the
assembled buffer, never per frame.

## Hard-won rules (each backed by a test)

1. **Deltas concatenate.** Replacing the buffer with each new frame loses all
   but the last fragment.
2. **Never decode chunks in isolation.** A multibyte character split across
   socket chunks corrupts unless decoded with `TextDecoder(..., {stream:true})`.
   The test suite splits the fixture at *every byte offset* and requires
   identical output.
3. **CRLF can split mid-pair across chunks.** `SseParser` holds back a trailing
   CR and normalizes `\r\n`, lone `\r`, and lone `\n`.
4. **Split thinking after assembly.** Per-frame splitting fails whenever a
   marker itself straddles two deltas.
5. **Mojibake has two flavours.** Node's `latin1` is ISO-8859-1 (C1 controls),
   but browsers' "latin-1" is windows-1252 (the classic `â€"` for `—`).
   `fixMojibake()` repairs both, plus double-encoded text, and leaves clean
   text and genuine non-latin1 content untouched.

## Files

- `wire.js` — shared parser: `SseParser`, `decodeSse`, `StreamAssembler`,
  `splitThinking`, `fixMojibake`. UMD: `require()` it or load it in a
  `<script>` and use `window.Wire`.
- `server.js` — mock upstream reproducing the format (including a deliberately
  mojibake-damaged mode) plus a small browser viewer. Supports
  `createServer({ quotaCookies: [...], quotaMode: 'http'|'stream' })` so the
  bridge's failover tests can force one account into quota.
- `bridge.js` — Anthropic-compatible endpoint in front of the MiMo backend;
  balances across the accounts in `accounts.json` (see the pool section).
- `chrome-auth.js` — pulls the browser session out of Chrome profiles; `--all`
  builds the `accounts.json` pool.
- `accounts.json` — live multi-account pool (created by you, git-ignored).
- `cli.js` — consume a stream and print the reassembled result.
- `test/run-tests.js` — wire-format tests, no framework.

## Usage

```bash
node test/run-tests.js          # run the suite
node server.js                  # mock upstream + viewer on :8787
node cli.js --port 8787 --mode clean
node cli.js --mode mojibake --fix   # damaged stream, repaired
```

## OpenCode / Claude Code integration

`bridge.js` exposes an Anthropic-compatible API in front of the MiMo backend
(`.env` holds the session cookies — never commit them). Verified live against
`react/chat` with `conversation/save` + `modelConfig` model selection.

```bash
npm run bridge                  # terminal 1: http://127.0.0.1:8789
```

**OpenCode** (provider `mimo` already merged into `~/.config/opencode/opencode.json`):

```bash
opencode run -m mimo/mimo-v2.6-flash "..."   # CLI
opencode run -m mimo/mimo-v2.6-pro "..."     # or in the TUI: /models -> MiMo
```

**Claude Code**:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8789
export ANTHROPIC_AUTH_TOKEN=local
claude --model mimo-v2.6-flash
```

Models: `mimo-v2.6-pro` (default), `mimo-v2.6-flash`, `mimo-v2.6-pro-ultraspeed-studio`
(ultraspeed needs its own quota pool and possibly a different route — see below).

### Refreshing the session cookies from Chrome

Auth is the browser session: `xiaomichatbot_serviceToken` (httpOnly), `userId`
and `xiaomichatbot_ph` (also sent as the `?xiaomichatbot_ph=` query param).
`chrome-auth.js` pulls all three out of a Chrome profile and updates `.env`
with a timestamped backup:

```bash
node chrome-auth.js --list           # profiles + which one has a session
node chrome-auth.js                  # dry run, auto-picks the profile
node chrome-auth.js --write          # update .env (backup .env.bak.<time>)
node chrome-auth.js --verify         # confirm the bridge sees the session
node chrome-auth.js --self-test      # crypto check, no Chrome needed
```

First run needs two macOS permissions:

1. **Full Disk Access** for the terminal app (System Settings → Privacy &
   Security → Full Disk Access), because macOS protects Chrome's cookie DB.
2. A Keychain prompt for **"Chrome Safe Storage"** — click Allow.

If Chrome is running, the script copies the DB (including WAL) to a temp dir,
so no need to quit it. Values are never printed in full; only masked previews.
Reads `Network/Cookies` (Chrome 96+) or the legacy `Cookies` path, handles the
`v10` AES-128-CBC keychain scheme and the Chrome 130+ host-hash prefix.

### Account pool: use every Chrome session, fail over on quota

If several Chrome profiles are logged into AI Studio, the bridge can cycle
through them instead of being stuck on one account's daily quota:

```bash
node chrome-auth.js --all              # show every profile with a Xiaomi session
node chrome-auth.js --write-pool       # collect them into accounts.json (0600)
```

`accounts.json` holds one entry per unique account (deduped by `userId`; the
longest-lived session wins). Re-running `--write-pool` refreshes the cookies
**without losing quota state** — `exhaustedUntil`, `invalidUntil` and
`lastUsedAt` are carried over per account.

The bridge prefers `accounts.json` when it exists and falls back to `.env`
otherwise. On HTTP 429 / `code 4004` (daily quota) it parks that account until
**00:00 UTC+8** and retries the next; on 401 it cools the session down for 10
minutes; if the upstream fails *before* any bytes were delivered to the client,
the failover is invisible to the caller — the client sees one clean stream and
one `message_start`. When every account is parked, the client gets
`rate_limit_error` with the reset time. Pool state is shown by
`node chrome-auth.js --verify` and in `/health` under `session.accounts`.

```bash
node chrome-auth.js --write-pool    # after signing in to another profile
pkill -f 'node bridge.js' && nohup node bridge.js > /tmp/mimo-bridge.log 2>&1 &
node chrome-auth.js --verify        # expect 2/2 healthy, or 1 parked
```

Keep `accounts.json` out of git (already in `.gitignore`). It carries the same
live cookies as `.env`.

Known limits: every request opens a fresh upstream conversation (they pile up
in AI Studio history); daily quota resets 00:00 UTC+8.

## Tool calling (agentic use)

The MiMo backend has **native function calling** (`toolCalls` frames), but its
server-side executor only knows its own tools — client tools fail with
`工具调用失败`. The bridge bridges that gap:

1. Anthropic `tools` are described to the model in the transcript preamble.
2. When the model emits a `toolCalls` frame, the bridge converts it to a real
   Anthropic `tool_use` block (upstream call id preserved) and **aborts** the
   upstream stream before the backend's doomed execution/retry loop.
3. OpenCode/Claude Code executes the tool locally and sends `tool_result`;
   the bridge replays prior calls/results to the model in its native
   `{"toolCalls":[...]}` / `{"responses":[{...,"responseData":...}]}` shapes.

`SHOW_THINKING` streams the model's reasoning as Anthropic `thinking` blocks
(OpenCode displays it); reasoning never mixes into answer text.

Test counts: wire parser (`npm test`) + bridge pool/failover
(`npm run test:bridge`, 23 tests: HTTP-429 failover, in-stream quota failover,
all-accounts-exhausted) + cookie collector (`npm run test:chrome-auth`, 7
tests, incl. pool dedupe and 0600 write).

```js
const Wire = require('./wire.js');
const parser = new Wire.SseParser();
const asm = new Wire.StreamAssembler();

// value: a UTF-8 chunk from the socket (decode with {stream:true}!)
for (const ev of parser.push(chunkText)) {
  const d = Wire.decodeSse(ev.event, ev.data);
  if (ev.event === 'message' && d.content) {
    const p = asm.push(d.content);       // live projection
    render(p.visible, p.thinking);
  }
  if (ev.event === 'usage' && d.usage) usage = d.usage;
}
const final = asm.finish();              // authoritative: visible + thinking
final.visible = Wire.fixMojibake(final.visible);
```
