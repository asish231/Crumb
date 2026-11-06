# Windows & Linux setup — manual collection (current) + what automation would need

`chrome-auth.js` is macOS-only today: it uses macOS-specific Keychain (`security find-generic-password … Safe Storage`) and macOS-specific Chrome paths. **On Windows/Linux, use manual collection below. The extraction algorithm (SQLite + v10 AES-128-CBC decrypt) is OS-portable — only the key store and paths differ.**

## A. Windows — manual collection

1. Log in to `aistudio.xiaomimimo.com` and `chat.deepseek.com` in Chrome.
2. MiMo: DevTools → Application → Cookies → `https://aistudio.xiaomimimo.com` → copy `xiaomichatbot_serviceToken`, `userId`, `xiaomichatbot_ph`.
3. DeepSeek: DevTools Console → `localStorage.getItem('userToken')`; Cookies → `ds_session_id`, `aws-waf-token`, `.thumbcache_*`.
4. Create `.env` (MiMo: `XIAOMI_COOKIE=…`, `XIAOMI_USER_ID=…`, `XIAOMI_PH=…`) and `ds-accounts.json` (see [FIELDS.md](FIELDS.md)).
5. Run the bridge: `node bridge.js` (or `npm run bridge`).
6. `curl http://127.0.0.1:8789/health` → `configured: true`.

## B. Linux — manual collection

Same steps as Windows; browsers store cookies at `~/.config/google-chrome/<Profile>/Network/Cookies` (or `~/.config/chromium/...`).

## C. What native extraction would require (future work)

| Item | macOS (done) | Windows | Linux |
|---|---|---|---|
| Cookie key | Keychain `"Chrome Safe Storage"` | DPAPI `CryptUnprotectData` over `Local State` → `os_crypt.encrypted_key` | kwallet / gnome-keyring / libsecret `chrome_libsecret_password_storage` |
| Cookie DB path | `~/Library/…/Chrome/<Profile>/Network/Cookies` | `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\Network\Cookies` | `~/.config/google-chrome/<Profile>/Network/Cookies` |
| Local Storage | `…/Local Storage/leveldb` | same relative layout | same relative layout |
| Decrypt | PBKDF2(SHA1, salt=`saltysalt`, 1003) → AES-128-CBC v10 | same crypto, key from DPAPI | same crypto, key from keyring |
| SQLite read | `sqlite3` CLI | SQLite available via scoop/choco (`sqlite3`) or better-sqlite3 | `sqlite3` on PATH (present on most distros) |
| Extra | v10 + Chrome ≥130 SHA-256(host_key) prefix — same everywhere | same | same |

A Windows/Linux port of `chrome-auth.js` = swap the key-source implementation + paths; keep `copyDb`, `queryCookies`, `decryptCookie`, LevelDB scan unchanged.

## D. Full auto flow per profile (once ported)

```
for each Chrome profile:
  find Cookies DB → copy to temp (0600)
  decrypt rows where host_key LIKE '%xiaomimimo%'  → MiMo session (if serviceToken present)
  decrypt rows where host_key LIKE '%deepseek%'    → ds_session_id, aws-waf-token, .thumbcache_*
  scan Local Storage LevelDB → userToken, deepseek-device-id:chat
  merge into accounts.json / ds-accounts.json (0600, dedupe by userId/token)
```

## E. Prerequisites on every OS

- Node.js ≥ 18 (project uses `fetch`; tested on Node 25).
- Chrome logged into **AI Studio** and **DeepSeek** (same profile or different profiles for multi-account pools).
- No proxy required; upstreams are reachable directly (both ~200 ms China RTT, token streaming is server-side).
