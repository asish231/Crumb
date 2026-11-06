# Architecture & How It Works

This bridge exposes a **localhost Anthropic-compatible API** in front of two web chat backends so coding agents (Claude Code, OpenCode) can use them with no code changes.

```
Claude Code / OpenCode ──HTTP /v1/messages SSE──▶  bridge.js (127.0.0.1:8789)
                                                     │
                                ┌────────────────────┴─────────────────────┐
                                ▼                                          ▼
                    aistudio.xiaomimimo.com                 chat.deepseek.com
                    (MiMo react/chat API)                    (DeepSeek web API + PoW)
```

## 1. Why stateless

Both upstreams keep conversation state server-side, but the bridge is deliberately stateless: every client request flattens the full Anthropic `messages` array into one transcript and opens a **fresh upstream conversation** per request. This avoids history drift on client compaction/edits. Consequence: every request spends ~3.8k prompt tokens of preamble (MiMo react) and creates orphaned conversations in AI Studio history.

## 2. Anthropic → upstream translation (`bridge.js`)

- `flatten(body)` — system prompt + tools preamble + `### role` markers, tool_use/tool_result rendered in the model's native shapes.
- `contentToText` — blocks → text (tool_use → native `toolCalls` JSON, tool_result → native `responses` JSON).
- `Wire.SseParser` / `StreamAssembler` — incrementally decodes upstream SSE (splits UTF-8 mid-frame, repairs mojibake).
- `makeEmitter` — upstream reasoning → `thinking_delta` blocks (signature `bridge-local`; never mixed into `text`).
- `inlineMarkers` (fastchat mode only) — `<think>…</think>` scanning with NUL-byte cleanup.
- Native `toolCalls` frames → real Anthropic `tool_use` blocks; the upstream stream is **aborted immediately** so the backend's doomed retry loop does not burn quota.

## 3. MiMo specifics (react mode)

Flow per request:
1. `POST /open-apis/chat/conversation/save` → `conversationId` (hex32, client-generated).
2. `POST /open-apis/react/chat` with `modelConfig.model` → SSE stream of `message` (content/reasoningContent), `usage`, `finish` events.
- Model selected per request via `modelConfig.model` (`mimo-v2.6-pro|flash|...`).
- `?xiaomichatbot_ph=` query param must match the session's `ph` value.

## 4. DeepSeek specifics (`deepseek.js`)

Per request:
1. **Parallel preflight** — `POST /api/v0/chat/create_pow_challenge` and `POST /api/v0/chat_session/create` are independent → fired concurrently (saves ~200ms China RTT).
2. **PoW** — DeepSeek requires a proof-of-work per completion call:
   - Challenge: `{algorithm:"DeepSeekHashV1", challenge, salt, difficulty, expire_at, signature}`.
   - Prefix built as `${salt}_${expire_at}_`, solved by **DeepSeek's own WASM** (`sha3_wasm_bg.wasm`, self-contained, 7 exports, no imports) calling `wasm_solve` with the real `expire_at` from the challenge → `nonce`.
   - Sent as header `X-DS-PoW-Response: base64(JSON({algorithm, challenge, salt, answer:nonce, signature, target_path:"/api/v0/chat/completion"}))`.
   - Solve time ≈ 30 ms (single WASM instance, loads once).
3. `POST /api/v0/chat/completion` with header + body `{chat_session_id, prompt, ref_file_ids:[], thinking_enabled, search_enabled}` → SSE.
- Stream frames: `event: ready` → `update_session` → `data: {"p":"response/fragments/-1/content","o":"APPEND"}` (incremental text) → `data: {"p":"response/status","o":"SET","v":"FINISHED"}` → `event: title` → `event: close`.

## 5. Account pools & failover

Both providers support multi-account pools (`accounts.json` for MiMo, `ds-accounts.json` for DeepSeek):

- **Quota exhausted** (MiMo HTTP 429 / code 4004, daily; DeepSeek same-shape errors) → parked until **00:00 UTC+8**.
- **Auth rejected** (MiMo 401, DeepSeek code `40003`) → 10-minute cooldown.
- Failover is **silent to the client** only if the failure happens *before the first delta* is delivered; if bytes already went out, the upstream error is surfaced as an Anthropic `error` event.
- Pool state is persisted (`0600`, atomic tmp+rename) and shown in `/health`.
- Chrome extraction: `chrome-auth.js` (MiMo cookies via sqlite3 + Keychain-decrypted v10 AES-128-CBC; DeepSeek: cookies + `userToken` from localStorage LevelDB).
- DeepSeek `userToken` expires after hours (vs MiMo's ~30-day cookies) — re-extract after re-logging in.

## 6. Wire format & SSE details

- MiMo fastchat: `<think>` markers with NUL bytes (`\u0000`), inline reasoning; react mode: `reasoningContent` field separate from `content`.
- DeepSeek: no think markers; a `THINK` fragment, then a `RESPONSE` fragment; deltas are JSON Patch operations on a shared response object.
- Both are translated to the Anthropic stream: `message_start → ping → content_block_(start|delta|stop)* → message_delta → message_stop`, with `thinking_delta`s before `text_delta`s.

## 7. Startup & client hookup

```bash
npm run bridge                 # starts 127.0.0.1:8789
curl -s localhost:8789/health
curl -s localhost:8789/v1/models
```

OpenCode provider `mimo` points at `http://127.0.0.1:8789/v1` with models `mimo/*` and `deepseek-*`.
Claude Code via `~/.local/bin/claude-mimo` (or env):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8789
export ANTHROPIC_AUTH_TOKEN=local
claude --model mimo-v2.6-flash        # or deepseek-reasoner
```
