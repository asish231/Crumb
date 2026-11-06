# Agent guide — bring-up on any OS, step by step

You are an AI agent helping a user run this bridge. Follow the steps in order. Do not skip verification steps. Never print, log or paste tokens/cookies/userIds. If blocked on a manual UI step, say exactly what the user must do.

## Mission
Get the Anthropic-compatible bridge answering through OpenCode or Claude Code, with MiMo and DeepSeek working, optionally with multi-account pooling.

## Step 0 — Repo check
```
cd <repo>            # contains bridge.js, chrome-auth.js, package.json, .env, accounts.json?
node --version       # need >= 18
ls
```
Files: `bridge.js` (server), `deepseek.js` (DeepSeek + PoW + pool), `chrome-auth.js` (extraction), `wire.js` (SSE), `server.js` (mock), `test/`.

## Step 1 — MiMo auth (required)
- If you are on **macOS**: `node chrome-auth.js --list` → all profiles listed with `[Xiaomi session ✓]`/`[no session]`. If EPERM → user must grant Full Disk Access to the app hosting this shell (see docs/MACOS.md), then relaunch.
- If not on macOS, or extraction fails → manual: user logs into https://aistudio.xiaomimimo.com, copies `xiaomichatbot_serviceToken`, `userId`, `xiaomichatbot_ph` (DevTools → Cookies), gives them to `.env`:
  ```
  XIAOMI_COOKIE="xiaomichatbot_serviceToken=…; userId=…; xiaomichatbot_ph=…"
  XIAOMI_USER_ID=…
  XIAOMI_PH=…
  ```
- Verify: restart bridge, `curl localhost:8789/health` → `session.configured: true`.

## Step 2 — DeepSeek auth (optional but supported)
- macOS: `node chrome-auth.js --ds-write-pool` → builds `ds-accounts.json`.
- Any OS manual: user logs into https://chat.deepseek.com; Console → `localStorage.getItem('userToken')`; Cookies → `ds_session_id`, `aws-waf-token`, `.thumbcache_*`; write `ds-accounts.json` (schema in docs/FIELDS.md §D) — or hand it to the user and have them paste a filled template (never show real values back).
- Verify: `curl localhost:8789/health | jq .deepseek` → `configured: true`.

## Step 3 — Start the server
```
pkill -f 'node bridge.js'   # Windows: taskkill /IM node.exe
cd <repo> && nohup node bridge.js > /tmp/mimo-bridge.log 2>&1 &   # Windows: start /b node bridge.js
curl localhost:8789/health
curl localhost:8789/v1/models
```
Expect `mode: react`, models `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro-ultraspeed-studio`, `deepseek-chat`, `deepseek-reasoner`.

## Step 4 — Connect a client
- **OpenCode**: add/verify provider `mimo` in `~/.config/opencode/opencode.json`: `baseURL http://127.0.0.1:8789/v1`, `tools: true`, models listed above; test: `opencode run -m mimo/mimo-v2.6-flash "reply with one word: OK"`.
- **Claude Code**: `export ANTHROPIC_BASE_URL=http://127.0.0.1:8789` and `export ANTHROPIC_AUTH_TOKEN=local`; or use `~/.local/bin/claude-mimo mimo-v2.6-flash` wrapper. Test: `claude -p "reply with one word: OKcode " --model mimo-v2.6-flash`.
- **OpenAI-compatible client**: point baseURL at `http://127.0.0.1:8789/v1` with model `deepseek-chat|deepseek-reasoner|mimo-v2.6-pro|flash` — the bridge speaks Anthropic `/v1/messages`; for OpenAI-shaped clients put a proxy in front (e.g., the bundled llm-pool-proxy) — do not claim native OpenAI compat.
- Verify reasoning streams: ask for a step-by-step answer and check the client shows a thinking block.

## Step 5 — Multi-account pool (optional)
- `node chrome-auth.js --write-pool` → MiMo pool; `--ds-write-pool` → DeepSeek pool. Report dedupe results + `0600` perms + backups created.
- Explain failover: quota → parked until 00:00 UTC+8; auth → 10-minute cooldown; silent only before first byte to client; `/health` shows pool status.

## Step 6 — Prove tool calling + failover (report evidence)
- Tool call: `opencode run -m mimo/mimo-v2.6-flash "read proof.txt, say its contents"` in a temp dir with a file → expect a `tool_use` block and correct file contents in output.
- Health check output, `tail -3 /tmp/mimo-bridge.log` showing account used, and `node chrome-auth.js --verify`.

## What to report
1. `health` JSON (account labels only, no secrets).
2. Which model + client were used end-to-end and the response.
3. Test results if run: `node test/run-tests.js && node test/bridge-tests.js && node test/chrome-auth-tests.js`.
4. Any EPERM/contention issues and the exact fix applied.

## Hard rules for the agent
- Never echo secrets; reference files by path.
- Do not invent endpoints or env vars — this bridge exposes only `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, `/health`.
- Keep credentials out of git (`.gitignore` covers `.env`, `*.bak.*`, `accounts.json*`, `ds-accounts.json*`, `sha3_wasm_bg.wasm`).
- On first sign of quota/auth failure, tell the user to re-extract — do not retry in a tight loop.
- Server lives on 127.0.0.1:8789 — do not expose externally without a proxy + token.
