# What to extract & collect (field reference)

Never commit or paste these. Use placeholders below; all real values stay in local 0600 files.

## A. Xiaomi MiMo — required fields

| Field | Source | Expiry | Notes |
|---|---|---|---|
| `XIAOMI_COOKIE` | Full cookie header incl. `xiaomichatbot_serviceToken`, `userId`, `xiaomichatbot_ph` | ~30 days | httpOnly serviceToken cannot be read by document.cookie — copy from DevTools or DB |
| `XIAOMI_USER_ID` | Cookie `userId` | ~30 days | |
| `XIAOMI_PH` | Cookie `xiaomichatbot_ph` | ~30 days | Must also be OK as `?xiaomichatbot_ph=` query param — bridge encodes it |
| `XIAOMI_EXTRA_COOKIES` | optional | — | extra cookies appended to the header |
| `accounts.json` | output of `--write-pool` (all profiles, deduped) | per account | pool failover |

**Manual collection (any OS)**: DevTools → Application → Cookies → `https://aistudio.xiaomimimo.com` → copy `xiaomichatbot_serviceToken`, `userId`, `xiaomichatbot_ph` → put into `.env` as above + restart.

**Automated (macOS)**: `node chrome-auth.js --list` then `--write` / `--write-pool`.

## B. DeepSeek — required fields

| Field | Source | Expiry | Notes |
|---|---|---|---|
| `userToken` | `localStorage["userToken"]` on chat.deepseek.com (JSON `{"value": "<token>"}`) | **hours** (short-lived) | Becomes `Authorization: Bearer <token>`; also `/api/v0/users/current` echoes it |
| `ds_session_id` | HttpOnly cookie | session | Session marker |
| `aws-waf-token` | `.deepseek.com` cookie | ~1 hour | AWS WAF token |
| `.thumbcache_<hex>` | `chat.deepseek.com` cookie | long (~2027) | Tracking cache cookie |
| `deepseek-device-id:chat` | `localStorage` | stable | UUID; used as `x-device-id` header; not strictly required |
| `ds-accounts.json` | output of `--ds-write-pool` (Chrome profiles) | per account | pool failover |

**Manual collection (any OS)**:
1. Open `https://chat.deepseek.com`, log in.
2. DevTools Console → `localStorage.getItem('userToken')` → the Bearer token.
3. Application → Cookies → copy `ds_session_id`, `aws-waf-token`, any `.thumbcache_*`.
4. Put `token`, `sessionId`, `wafToken`, `thumbcache`, `deviceId` into `ds-accounts.json` (see schema in `deepseek.js:normalizeAccount`).
5. Restart bridge.

**Automated (macOS)**: `node chrome-auth.js --ds-write-pool`.

## C. Bridge environment (.env)

| Key | Required | Purpose |
|---|---|---|
| `PORT` | no (default 8789) | listen port |
| `BRIDGE_TOKEN` | no | if set, clients must send it; leave empty for local use |
| `SHOW_THINKING` | no (default true) | forward reasoning as `thinking_delta` |
| `CHAT_MODE` | no (react) | `react` or `fastchat` |
| `REACT_MODEL` | no (mimo-v2.6-pro) | default MiMo model |
| `ACCOUNTS_FILE` | no (./accounts.json) | MiMo pool path |
| `DS_ACCOUNTS_FILE` | no (./ds-accounts.json) | DeepSeek pool path |
| `REQUEST_TIMEOUT_MS` | no (300000) | upstream timeout |

## D. File schemas

`accounts.json` / `ds-accounts.json`:
```json
{"version":1,"updatedAt":"…","accounts":[{"id":"…","label":"Asish","email":"…",
  "token":"…","cookie":"…","ph":"…","userId":"…","deviceId":"…","wafToken":"…",
  "sessionId":"…","thumbcache":"…","expiresAt":0,"exhaustedUntil":0,
  "invalidUntil":0,"lastUsedAt":0,"lastError":""}]}
```
- MiMo entries use `cookie` + `ph` + `userId` (token not used).
- DeepSeek entries use `token` + `sessionId` + `wafToken` + `thumbcache` + `deviceId`.
- Both keep `exhaustedUntil` / `invalidUntil` / `lastUsedAt` / `lastError` across `--write-pool` refreshes.

## E. Where values live (CHROME)

| OS | Cookies DB | Local Storage (localStorage) |
|---|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/<Profile>/Network/Cookies` | `<Profile>/Local Storage/leveldb` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\Network\Cookies` | `…\<Profile>\Local Storage\leveldb` |
| Linux | `~/.config/google-chrome/<Profile>/Network/Cookies` | `…\<Profile>\Local Storage\leveldb` |

Cookie values are AES-128-CBC (`v10`) with a 16-byte key: macOS — Keychain `"<Browser> Safe Storage"`; Windows — DPAPI `Google Chrome os_crypt`; Linux — keyring/kwallet (or `chrome_libsecret_password_storage`). Chrome >=130 may prefix plaintext with SHA-256(host_key).

## F. Account pools vs single login

If you have multiple browser profiles logged into AI Studio / DeepSeek, the pool (`--write-pool`, `--ds-write-pool`) uses the first healthy account and fails over automatically. If you only want one account, `.env` (MiMo) / `ds-accounts.json` with one entry (DeepSeek) is sufficient.
