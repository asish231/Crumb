# Stream Parser Bridge — Docs index

A localhost Anthropic-compatible bridge in front of **Xiaomi MiMo** (web chat API) and **DeepSeek** (web API + PoW), for use with Claude Code / OpenCode.

| File | Purpose |
|---|---|
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | Architecture, wire formats, PoW internals, account pools, SSE translation, startup |
| [FIELDS.md](FIELDS.md) | Exact fields to collect (MiMo + DeepSeek), where they live per OS, pool file schema, token expiry |
| [MACOS.md](MACOS.md) | Full Disk Access or manual collection; what the automation does under the hood |
| [WINDOWS-LINUX.md](WINDOWS-LINUX.md) | Manual collection, and what a native DPAPI/keyring port would require |
| [AGENT-GUIDE.md](AGENT-GUIDE.md) | Step-by-step mission for an AI agent: bring-up, client hookup, verification, report |

Root README.md covers day-to-day usage (bridge, pools, tool calling).

## Quick start

```bash
cd <repo>
node chrome-auth.js --list                 # or manual: see FIELDS.md
node chrome-auth.js --write-pool           # MiMo pool (macOS auto / others manual)
node chrome-auth.js --ds-write-pool        # DeepSeek pool
npm run bridge                             # 127.0.0.1:8789
curl -s localhost:8789/health
opencode run -m mimo/mimo-v2.6-flash "say OK"
```

## Safety

- All credential files are `0600` and git-ignored (`.env`, `accounts.json*`, `ds-accounts.json*`, `sha3_wasm_bg.wasm`, `*.bak.*`).
- Docs contain no credentials — only placeholders and instructions.
- Bridge binds localhost by default; no public exposure without proxy + token.
