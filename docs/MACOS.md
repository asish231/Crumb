# macOS setup — Full Disk Access or manual collection

## A. Full Disk Access (recommended, enables automation)

Chrome's cookie database is protected by macOS. Any tool that reads it needs FDA.

1. Open **System Settings → Privacy & Security → Full Disk Access** and enable **the app that hosts your terminal/agent** — for this project that's the app running OpenCode/Claude Code (historically "Antigravity IDE", not VS Code). Also enable **Terminal.app** if you run commands there.
2. **Fully quit and reopen** that app (FDA only applies to freshly launched processes).
3. Verify:
   ```bash
   cd ~/programming/stream-parser
   node chrome-auth.js --list
   ```
   You should see all profiles with `[Xiaomi session ✓]` / DeepSeek session info instead of `EPERM ... Local State`.

## B. Manual collection (no FDA, works everywhere)

1. Open Chrome → `chrome://settings/cookies` → site exceptions: allow `aistudio.xiaomimimo.com` and `chat.deepseek.com`.
2. Log in to both.
3. MiMo values: DevTools → Application → Cookies → copy `xiaomichatbot_serviceToken`, `userId`, `xiaomichatbot_ph`.
4. DeepSeek values: DevTools Console → `localStorage.getItem('userToken')`; Cookies → `ds_session_id`, `aws-waf-token`, `.thumbcache_*` (see [FIELDS.md](FIELDS.md) §B).
5. Write `.env` (MiMo) / `ds-accounts.json` (DeepSeek), restart bridge, `curl localhost:8789/health`.

## C. What the automation does under the hood

- Copies the SQLite `Cookies` DB (+ WAL) to a temp dir (never touch Chrome's live DB), `0600`.
- Decrypts `v10` AES-128-CBC values with the Keychain "<Browser> Safe Storage" key (PBKDF2-SHA1, 1003 iters, `saltysalt`).
- Chrome ≥130 may prefix plaintext with SHA-256(host_key) — handled automatically.
- DeepSeek also reads `Local Storage/leveldb/` files for `userToken` and the device id via regex scan of the LevelDB log.
- Writes `.env` / `accounts.json` / `ds-accounts.json` with timestamped backups, `0600`.

## D. Browser support

Chrome (default), Chromium, Brave, Edge — pick with `--browser brave|edge|chromium`.

## E. Known macOS quirks

- FDA entries are per-app-host, not per-shell — grant to the app that launches your agent (and Terminal if you use it).
- Keychain prompt "Chrome Safe Storage" appears once — click **Allow**.
- Cookie DB may be locked/copied on profiles that were synced — unreadable ones are skipped with a reason in output.
- `--verify` checks the running bridge without needing Chrome access.

## F. Refresh cadence

- MiMo cookies live ~30 days.
- DeepSeek `userToken` lasts hours — re-run `--ds-write-pool` after re-login.
