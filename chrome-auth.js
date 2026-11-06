#!/usr/bin/env node
'use strict';

/* chrome-auth.js — pull the Xiaomi AI Studio session cookies out of a local
 * Chrome profile and (optionally) write them into .env for bridge.js.
 *
 * macOS only. Chrome encrypts cookie values with a key held in the login
 * Keychain ("Chrome Safe Storage"), and macOS protects the cookie database
 * with Full Disk Access. Both are one-time setup.
 *
 *   node chrome-auth.js --list            # profiles + Xiaomi session presence
 *   node chrome-auth.js                   # dry run: auto-pick the profile
 *   node chrome-auth.js --write           # update .env (backup created)
 *   node chrome-auth.js --profile Work --write
 *   node chrome-auth.js --all             # every profile with a session (dry run)
 *   node chrome-auth.js --write-pool      # collect all sessions into accounts.json
 *   node chrome-auth.js --browser brave --write
 *   node chrome-auth.js --verify          # check the bridge picked it up
 *   node chrome-auth.js --self-test       # crypto round-trip, no Chrome needed
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;
const DEFAULT_ENV = path.join(HERE, '.env');
const CHROME_EPOCH_MS = Date.UTC(1601, 0, 1);
const KEYCHAIN_TIMEOUT_MS = 20000;
const REQUIRED = ['xiaomichatbot_serviceToken', 'xiaomichatbot_ph'];
const OPTIONAL = ['userId'];

const BROWSERS = {
  chrome: {
    label: 'Google Chrome',
    root: path.join(os.homedir(), 'Library/Application Support/Google/Chrome'),
    service: 'Chrome Safe Storage',
    account: 'Chrome'
  },
  chromium: {
    label: 'Chromium',
    root: path.join(os.homedir(), 'Library/Application Support/Chromium'),
    service: 'Chromium Safe Storage',
    account: 'Chromium'
  },
  brave: {
    label: 'Brave',
    root: path.join(os.homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
    service: 'Brave Safe Storage',
    account: 'Brave'
  },
  edge: {
    label: 'Microsoft Edge',
    root: path.join(os.homedir(), 'Library/Application Support/Microsoft Edge'),
    service: 'Microsoft Edge Safe Storage',
    account: 'Microsoft Edge'
  }
};

/* ------------------------------- CLI ------------------------------- */

function parseArgs(argv) {
  const opts = {
    browser: 'chrome',
    profile: null,
    db: null,
    envFile: DEFAULT_ENV,
    poolFile: path.join(HERE, 'accounts.json'),
    dsPoolFile: path.join(HERE, 'ds-accounts.json'),
    write: false,
    all: false,
    writePool: false,
    dsWritePool: false,
    list: false,
    verify: false,
    selfTest: false,
    help: false,
    port: null
  };
  const take = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(name + ' needs a value');
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--browser') { opts.browser = take(i, a); i++; }
    else if (a.startsWith('--browser=')) opts.browser = a.slice('--browser='.length);
    else if (a === '--profile') { opts.profile = take(i, a); i++; }
    else if (a.startsWith('--profile=')) opts.profile = a.slice('--profile='.length);
    else if (a === '--db') { opts.db = take(i, a); i++; }
    else if (a.startsWith('--db=')) opts.db = a.slice('--db='.length);
    else if (a === '--env-out') { opts.envFile = take(i, a); i++; }
    else if (a.startsWith('--env-out=')) opts.envFile = a.slice('--env-out='.length);
    else if (a === '--pool') { opts.poolFile = take(i, a); i++; }
    else if (a.startsWith('--pool=')) opts.poolFile = a.slice('--pool='.length);
    else if (a === '--ds-pool') { opts.dsPoolFile = take(i, a); i++; }
    else if (a.startsWith('--ds-pool=')) opts.dsPoolFile = a.slice('--ds-pool='.length);
    else if (a === '--ds-write-pool') { opts.dsWritePool = true; opts.all = true; }
    else if (a === '--port') { opts.port = Number(take(i, a)); i++; }
    else if (a === '--write') opts.write = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--write-pool') { opts.writePool = true; opts.all = true; }
    else if (a === '--list') opts.list = true;
    else if (a === '--verify') opts.verify = true;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error('unknown option: ' + a + ' (try --help)');
  }
  if (!BROWSERS[opts.browser]) {
    throw new Error('unknown browser "' + opts.browser + '" (choose: ' + Object.keys(BROWSERS).join(', ') + ')');
  }
  if (opts.all && opts.profile) throw new Error('use either --all or --profile, not both');
  if (opts.all && opts.db) throw new Error('use either --all or --db, not both');
  if (opts.writePool && opts.write) throw new Error('use either --write-pool or --write, not both');
  return opts;
}

function printHelp() {
  console.log(`chrome-auth — refresh the Xiaomi AI Studio cookies in .env from Chrome

  node chrome-auth.js                     dry run, auto-picks the profile with a session
  node chrome-auth.js --list              list profiles and which one has a session
  node chrome-auth.js --write             update .env (timestamped backup first)
  node chrome-auth.js --profile "Work"    pick by profile name or directory (Default, Profile 1…)
  node chrome-auth.js --all               show every profile that has a Xiaomi session
  node chrome-auth.js --write-pool        collect all sessions into accounts.json (failover pool)
  node chrome-auth.js --pool FILE         pool location (default: ./accounts.json)
  node chrome-auth.js --browser brave     chrome (default), chromium, brave, edge
  node chrome-auth.js --verify            ask the running bridge whether the session is set
  node chrome-auth.js --self-test         verify the crypto path without Chrome
  node chrome-auth.js --env-out FILE      write somewhere other than ./.env

The bridge uses accounts.json when it exists: accounts are tried in file order and
quota-rejected ones are parked until the next 00:00 UTC+8 reset.

Requires:
  1. System Settings → Privacy & Security → Full Disk Access → enable your
     terminal app (and the app hosting this shell, e.g. OpenCode), then restart it.
  2. A Keychain prompt for "Chrome Safe Storage" on first run — click Allow.

The script never prints full cookie values.`);
}

/* ----------------------------- profiles ----------------------------- */

function permissionError(target, err, browserId) {
  const term = process.env.TERM_PROGRAM || '';
  const app =
    term === 'Apple_Terminal' ? 'Terminal' :
    term === 'iTerm.app' ? 'iTerm' :
    term === 'vscode' ? 'Visual Studio Code' :
    term === 'WarpTerminal' ? 'Warp' :
    term === 'ghostty' ? 'Ghostty' :
    term === 'Hyper' ? 'Hyper' :
    term || 'your terminal app';
  return new Error([
    'macOS denied access to ' + BROWSERS[browserId].label + ' data (Full Disk Access required).',
    '',
    '  1. Open System Settings → Privacy & Security → Full Disk Access',
    '  2. Enable ' + app + ' (and the app that launched this shell, if different)',
    '  3. Fully quit and reopen it, then rerun this command',
    '',
    'Blocked path: ' + target,
    'Underlying error: ' + ((err && (err.code || err.message)) || err)
  ].join('\n'));
}

function dbForProfile(root, dir) {
  const modern = path.join(root, dir, 'Network', 'Cookies');
  const legacy = path.join(root, dir, 'Cookies');
  if (fs.existsSync(modern)) return modern;
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

function loadProfiles(browserId) {
  const b = BROWSERS[browserId];
  const root = b.root;
  if (!fs.existsSync(root)) {
    throw new Error(b.label + ' profile folder not found:\n  ' + root);
  }

  let info = {};
  const localState = path.join(root, 'Local State');
  try {
    const state = JSON.parse(fs.readFileSync(localState, 'utf8'));
    info = (state.profile && state.profile.info_cache) || {};
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) throw permissionError(localState, err, browserId);
    // Missing or corrupt Local State is fine — fall back to directory names.
  }

  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    throw permissionError(root, err, browserId);
  }

  const out = [];
  for (const dir of dirs) {
    const db = dbForProfile(root, dir);
    if (!db) continue;
    const meta = info[dir] || {};
    out.push({
      dir,
      name: meta.name || dir,
      account: meta.user_name || meta.gaia_name || meta.shortcut_name || '',
      db
    });
  }
  return out;
}

function profileLabel(p) {
  if (!p.dir) return p.name;
  return p.dir + ' (' + p.name + (p.account ? ' — ' + p.account : '') + ')';
}

function chooseProfile(opts) {
  const profiles = loadProfiles(opts.browser);
  if (!profiles.length) {
    throw new Error('No ' + BROWSERS[opts.browser].label + ' profiles with a cookie database were found.');
  }

  if (opts.profile) {
    const found = profiles.find((p) => p.dir === opts.profile || p.name === opts.profile || p.account === opts.profile);
    if (!found) {
      throw new Error('Profile not found: ' + opts.profile + '\nAvailable:\n' +
        profiles.map((p) => '  - ' + profileLabel(p)).join('\n'));
    }
    return found;
  }

  if (profiles.length === 1) return profiles[0];

  // Auto-pick: the profile whose Xiaomi session expires last.
  const candidates = [];
  for (const p of profiles) {
    try {
      const rows = queryCookies(p.db);
      if (!rows.some((r) => r.name === 'xiaomichatbot_serviceToken')) continue;
      const latest = Math.max(0, ...rows.map((r) => Number(r.expires_utc) || 0));
      candidates.push({ profile: p, latest });
    } catch {
      // Unreadable/locked profile: let the others win.
    }
  }
  if (candidates.length === 1) return candidates[0].profile;

  if (candidates.length > 1) {
    candidates.sort((a, b) => b.latest - a.latest);
    throw new Error(
      'Multiple Chrome profiles have a Xiaomi session:\n' +
      candidates.map((c) => '  - ' + profileLabel(c.profile)).join('\n') +
      '\nPick one explicitly, e.g. --profile "Profile 1" (or --profile Default).'
    );
  }
  throw new Error(
    'No profile contains a Xiaomi AI Studio session.\n' +
    'Open https://aistudio.xiaomimimo.com in Chrome, sign in, then rerun.\n\nProfiles checked:\n' +
    profiles.map((p) => '  - ' + profileLabel(p)).join('\n')
  );
}

function listProfiles(opts) {
  const profiles = loadProfiles(opts.browser);
  if (!profiles.length) throw new Error('No profiles with a cookie database found.');
  console.log(BROWSERS[opts.browser].label + ' profiles:');
  for (const p of profiles) {
    let note;
    try {
      const rows = queryCookies(p.db);
      note = rows.some((r) => r.name === 'xiaomichatbot_serviceToken')
        ? 'Xiaomi session ✓'
        : 'no Xiaomi session';
    } catch (err) {
      note = 'unreadable (' + ((err && (err.code || err.message)) || err) + ')';
    }
    console.log('  ' + p.dir.padEnd(16) + p.name + (p.account ? ' — ' + p.account : '') + '  [' + note + ']');
  }
}

/* --------------------------- cookie database --------------------------- */

function copyDb(src) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-cookies-'));
  const dest = path.join(tmp, 'Cookies');
  fs.copyFileSync(src, dest);
  for (const suffix of ['-wal', '-shm']) {
    try {
      if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dest + suffix);
    } catch {
      // A missing sidecar just means no uncheckpointed writes.
    }
  }
  try {
    fs.chmodSync(tmp, 0o700);
    fs.chmodSync(dest, 0o600);
  } catch {
    // Best effort on permissions.
  }
  return { tmp, dest };
}

function queryCookies(dbPath) {
  const { tmp, dest } = copyDb(dbPath);
  try {
    const sql = [
      'SELECT host_key, name, value, hex(encrypted_value) AS enc_hex, path,',
      '       expires_utc, is_secure, is_httponly, creation_utc',
      'FROM cookies',
      "WHERE host_key LIKE '%xiaomimimo%'",
      'ORDER BY length(path) DESC, creation_utc ASC'
    ].join('\n');
    const out = execFileSync('/usr/bin/sqlite3', ['-json', dest, sql], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
    const trimmed = out.trim();
    return trimmed ? JSON.parse(trimmed) : [];
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

/* ----------------------------- decryption ----------------------------- */

function deriveKey(password) {
  return crypto.pbkdf2Sync(String(password), 'saltysalt', 1003, 16, 'sha1');
}

function decryptCbc(body, key, iv) {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    // Some cookies are unpadded; retry without PKCS#7 and strip NULs later.
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(body), d.final()]);
  }
}

function decryptCookie(encrypted, key, hostKey) {
  if (!encrypted || !encrypted.length) return '';
  const magic = encrypted.subarray(0, 3).toString('latin1');
  if (magic !== 'v10' && magic !== 'v11' && magic !== 'v12') {
    if (magic === 'v20') {
      throw new Error('cookie uses v20 app-bound encryption (unsupported). Copy XIAOMI_COOKIE from DevTools instead.');
    }
    return encrypted.toString('utf8');
  }

  const iv = Buffer.alloc(16, 0x20);
  let plain = decryptCbc(encrypted.subarray(3), key, iv);

  // Chrome 130+ prefixes the plaintext with SHA-256(host_key) on some builds.
  const hostHash = crypto.createHash('sha256').update(String(hostKey || '')).digest();
  if (plain.length > 32 && plain.subarray(0, 32).equals(hostHash)) plain = plain.subarray(32);

  while (plain.length && plain[plain.length - 1] === 0) plain = plain.subarray(0, -1);
  return plain.toString('utf8');
}

function keychainPassword(browserId) {
  if (process.env.CHROME_COOKIE_PASSWORD) return process.env.CHROME_COOKIE_PASSWORD; // tests only

  const b = BROWSERS[browserId];
  const attempts = [
    ['find-generic-password', '-s', b.service, '-a', b.account, '-w'],
    ['find-generic-password', '-s', b.service, '-w']
  ];
  let last = null;

  for (const args of attempts) {
    try {
      const pw = execFileSync('/usr/bin/security', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: KEYCHAIN_TIMEOUT_MS
      }).trim();
      if (pw) return pw;
    } catch (err) {
      last = err;
    }
  }

  const msg = String((last && (last.stderr || last.message)) || last || 'unknown error').trim();
  const interaction = /interaction is not allowed|user canceled|denied/i.test(msg);
  throw new Error([
    'Could not read "' + b.service + '" from the macOS Keychain.',
    interaction
      ? 'macOS suppressed the Keychain prompt because this process is not interactive. Run this command directly in Terminal/iTerm and click Allow.'
      : msg,
    '',
    'Keychain item: ' + b.service + ' (account: ' + b.account + ')',
    'If it is missing, launch ' + b.label + ' once, then retry.'
  ].join('\n'));
}

function readCookies(dbPath, password) {
  const rows = queryCookies(dbPath);
  const key = deriveKey(password);
  return rows.map((row) => {
    let value;
    if (row.value !== null && row.value !== undefined && String(row.value) !== '') {
      value = String(row.value);
    } else {
      value = decryptCookie(Buffer.from(row.enc_hex || '', 'hex'), key, row.host_key);
    }
    return { ...row, value };
  });
}

/* ------------------------------ helpers ------------------------------ */

function appliesToAistudio(hostKey) {
  const host = String(hostKey || '').replace(/^\./, '');
  if (!/xiaomimimo\.com$/i.test(host)) return false;
  // Domain cookies (leading dot) and the exact hosts the bridge talks to.
  return String(hostKey || '').startsWith('.') || host === 'xiaomimimo.com' || host === 'aistudio.xiaomimimo.com';
}

function isExpired(expiresUtc) {
  const n = Number(expiresUtc);
  if (!n || n <= 0) return false; // session cookie
  return CHROME_EPOCH_MS + Math.floor(n / 1000) <= Date.now();
}

function formatExpiry(expiresUtc) {
  const n = Number(expiresUtc);
  if (!n || n <= 0) return 'session';
  const d = new Date(CHROME_EPOCH_MS + Math.floor(n / 1000));
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function mask(value) {
  const s = String(value || '');
  if (!s) return '(empty)';
  if (s.length <= 8) return s.slice(0, 1) + '…' + s.slice(-1) + ' (len ' + s.length + ')';
  return s.slice(0, 3) + '…' + s.slice(-3) + ' (len ' + s.length + ')';
}

function setEnvValue(text, key, value) {
  const line = key + '=' + value;
  const re = new RegExp('^' + key + '=.*$', 'm');
  if (re.test(text)) return text.replace(re, () => line);
  if (text.length && !text.endsWith('\n')) text += '\n';
  return text + line + '\n';
}

function writeEnvFile(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backup = file + '.bak.' + stamp;
    fs.copyFileSync(file, backup);
    try { fs.chmodSync(backup, 0o600); } catch { /* best effort */ }
  }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  for (const [key, value] of Object.entries(values)) text = setEnvValue(text, key, value);

  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
  return { backup };
}

function bridgePort(envFile, explicit) {
  if (explicit) return explicit;
  try {
    const text = fs.readFileSync(envFile, 'utf8');
    const m = /^PORT=(.*)$/m.exec(text);
    if (m) return Number(m[1].trim()) || 8789;
  } catch { /* fall through */ }
  return 8789;
}

async function verifyBridge(envFile, explicitPort) {
  const port = bridgePort(envFile, explicitPort);
  const url = 'http://127.0.0.1:' + port + '/health';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    const session = body.session || {};
    let line = 'bridge ' + port + ': ' + (res.ok ? 'up' : 'HTTP ' + res.status) +
      ' | mode: ' + (body.mode || '?') +
      ' | session: ' + (session.configured ? 'configured (' + session.mode + ')' : 'NOT configured');
    if (Array.isArray(session.accounts) && session.accounts.length) {
      const healthy = session.accounts.filter((a) => a.healthy).length;
      line += ' | pool: ' + healthy + '/' + session.accounts.length + ' healthy';
    }
    console.log(line);
    if (Array.isArray(session.accounts)) {
      for (const a of session.accounts) {
        const state = a.healthy ? 'ready'
          : a.exhaustedUntil ? 'quota until ' + new Date(a.exhaustedUntil + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC+8'
          : a.invalidUntil ? 'invalid until ' + new Date(a.invalidUntil).toISOString().slice(0, 16) + ' UTC'
          : 'unavailable';
        console.log('  ' + (a.healthy ? '●' : '○') + ' ' + (a.label || 'account') + (a.email ? ' <' + a.email + '>' : '') + ' — ' + state);
      }
    }
  } catch (err) {
    console.error('bridge ' + port + ': unreachable (' + ((err && err.message) || err) + ')');
    console.error('start it with: cd ' + HERE + ' && nohup node bridge.js > /tmp/mimo-bridge.log 2>&1 &');
    process.exitCode = 1;
  }
}

/* --------------------------- account pool --------------------------- */

function sessionFor(profile, cookies) {
  const byName = new Map();
  for (const c of cookies) byName.set(c.name, c);
  const missing = REQUIRED.filter((n) => !byName.has(n));
  const latest = Math.max(0, ...cookies.map((c) => Number(c.expires_utc) || 0));
  return {
    profile,
    cookies,
    byName,
    missing,
    header: cookies.map((c) => c.name + '=' + c.value).join('; '),
    ph: byName.has('xiaomichatbot_ph') ? byName.get('xiaomichatbot_ph').value : '',
    userId: byName.has('userId') ? byName.get('userId').value : '',
    expiresAt: latest ? CHROME_EPOCH_MS + Math.floor(latest / 1000) : 0
  };
}

function scanSessions(opts) {
  const profiles = loadProfiles(opts.browser);
  if (!profiles.length) throw new Error('No ' + BROWSERS[opts.browser].label + ' profiles with a cookie database were found.');
  const password = keychainPassword(opts.browser);
  const sessions = [];
  const skipped = [];
  for (const p of profiles) {
    let all;
    try {
      all = readCookies(p.db, password);
    } catch (err) {
      skipped.push({ profile: p, reason: 'unreadable (' + String((err && (err.code || err.message)) || err).split('\n')[0] + ')' });
      continue;
    }
    const cookies = all.filter((c) => appliesToAistudio(c.host_key) && !isExpired(c.expires_utc));
    if (!cookies.length) {
      skipped.push({ profile: p, reason: 'no Xiaomi session' });
      continue;
    }
    const session = sessionFor(p, cookies);
    if (session.missing.length) {
      skipped.push({ profile: p, reason: 'missing ' + session.missing.join(', ') });
      continue;
    }
    sessions.push(session);
  }
  return { sessions, skipped };
}

function printSession(session) {
  console.log(profileLabel(session.profile));
  for (const c of session.cookies) {
    console.log('  ' + (REQUIRED.includes(c.name) ? '●' : '○') + ' ' + c.name.padEnd(26) +
      mask(c.value).padEnd(22) + ' expires ' + formatExpiry(c.expires_utc) +
      (Number(c.is_httponly) ? '  httpOnly' : ''));
  }
  if (!session.byName.has('userId')) console.log('  ! optional cookie "userId" not found');
  console.log('  account  : ' + (session.userId || '(no userId cookie)'));
  if (session.expiresAt) {
    const days = Math.floor((session.expiresAt - Date.now()) / 86400000);
    console.log('  session  : valid for ~' + days + ' more day' + (days === 1 ? '' : 's'));
  } else {
    console.log('  session  : no explicit expiry (session cookies)');
  }
}

function listAllSessions(opts) {
  const { sessions, skipped } = scanSessions(opts);
  if (!sessions.length) {
    throw new Error(
      'No profile contains a Xiaomi AI Studio session.\n' +
      'Open https://aistudio.xiaomimimo.com in Chrome, sign in, then rerun.\n\nProfiles checked:\n' +
      skipped.map((s) => '  - ' + profileLabel(s.profile) + ' — ' + s.reason).join('\n')
    );
  }
  console.log(BROWSERS[opts.browser].label + ' — profiles with a Xiaomi session: ' + sessions.length + '\n');
  for (const s of sessions) {
    printSession(s);
    console.log('');
  }
  const noSession = skipped.filter((s) => s.reason === 'no Xiaomi session').length;
  const problems = skipped.length - noSession;
  console.log(skipped.length + ' other profile(s) skipped (' + noSession + ' without a Xiaomi session' +
    (problems ? ', ' + problems + ' unreadable/incomplete' : '') + ').');
  if (opts.writePool) return;
  console.log('\nDry run — nothing written. Re-run with --write-pool to build ' + opts.poolFile);
}

function loadPool(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const accounts = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.accounts) ? raw.accounts : []);
    return { version: 1, updatedAt: raw.updatedAt || null, accounts };
  } catch {
    return null;
  }
}

function accountsFromSessions(sessions, existing) {
  const prevById = new Map();
  for (const a of (existing && existing.accounts) || []) {
    const id = String(a.id || a.userId || '');
    if (id) prevById.set(id, a);
  }

  const byId = new Map();
  const duplicates = [];
  for (const s of sessions) {
    const id = s.userId || 'profile:' + s.profile.dir;
    const account = {
      id,
      label: s.profile.name || s.profile.dir || id,
      profile: s.profile.dir || '',
      name: s.profile.name || '',
      email: s.profile.account || '',
      cookie: s.header,
      ph: s.ph,
      userId: s.userId,
      expiresAt: s.expiresAt,
      exhaustedUntil: 0,
      invalidUntil: 0,
      lastUsedAt: 0,
      lastError: ''
    };
    const prev = prevById.get(id);
    if (prev) {
      account.exhaustedUntil = Number(prev.exhaustedUntil) || 0;
      account.invalidUntil = Number(prev.invalidUntil) || 0;
      account.lastUsedAt = Number(prev.lastUsedAt) || 0;
      account.lastError = prev.lastError ? String(prev.lastError).slice(0, 300) : '';
    }

    const already = byId.get(id);
    if (already) {
      duplicates.push({ profile: s.profile, id });
      // Same Xiaomi account signed into two browser profiles: keep the session
      // that lives longer, but never lose the quota/auth state carried above.
      if (account.expiresAt > already.expiresAt) byId.set(id, account);
      continue;
    }
    byId.set(id, account);
  }
  return { accounts: [...byId.values()], duplicates };
}

function writePoolFile(file, accounts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backup = file + '.bak.' + stamp;
    fs.copyFileSync(file, backup);
    try { fs.chmodSync(backup, 0o600); } catch { /* best effort */ }
  }
  const payload = { version: 1, updatedAt: new Date().toISOString(), accounts };
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
  return { backup, payload };
}

function writePoolCommand(opts) {
  const { sessions, skipped } = scanSessions(opts);
  if (!sessions.length) {
    throw new Error(
      'No profile contains a Xiaomi AI Studio session — the pool would be empty.\n' +
      'Sign in at https://aistudio.xiaomimimo.com in at least one Chrome profile, then rerun.\n\nProfiles checked:\n' +
      skipped.map((s) => '  - ' + profileLabel(s.profile) + ' — ' + s.reason).join('\n')
    );
  }

  const existing = loadPool(opts.poolFile);
  const { accounts, duplicates } = accountsFromSessions(sessions, existing);
  const { backup } = writePoolFile(opts.poolFile, accounts);

  console.log(BROWSERS[opts.browser].label + ' — collected ' + sessions.length + ' session(s), ' + accounts.length + ' unique account(s):\n');
  for (const a of accounts) {
    const now = Date.now();
    const state = a.exhaustedUntil > now ? 'quota parked until ' + new Date(a.exhaustedUntil + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC+8'
      : a.invalidUntil > now ? 'session cooldown until ' + new Date(a.invalidUntil).toISOString().slice(0, 16) + ' UTC'
      : 'ready';
    console.log('  ● ' + a.label + (a.email ? ' — ' + a.email : '') +
      '\n      profile ' + (a.profile || '?') + ' | userId ' + mask(a.userId) +
      ' | header ' + a.cookie.length + ' chars | expires ' + (a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0, 10) : 'session') +
      '\n      ' + state);
  }
  for (const d of duplicates) {
    console.log('\n  ! ' + profileLabel(d.profile) + ' duplicates account ' + d.id + ' — merged, longest-lived session kept');
  }
  console.log('\nWrote ' + opts.poolFile + (backup ? '\nBackup: ' + backup : ''));
  console.log('File mode: 0600 (contains live cookies — keep it out of git)');
  console.log('\nRestart the bridge to pick up the pool:');
  console.log("  pkill -f 'node bridge.js'; cd " + HERE + ' && nohup node bridge.js > /tmp/mimo-bridge.log 2>&1 &');
  console.log('Then: node chrome-auth.js --verify');
}

/* ------------------------------- main ------------------------------- */

/* ----------------------- DeepSeek extraction ----------------------- */

const DS_COOKIE_NAMES = ['ds_session_id', 'aws-waf-token'];
const DS_HOST_FILTER = '%deepseek%';

function appliesToDeepSeek(hostKey) {
  const host = String(hostKey || '').replace(/^\./, '');
  return /deepseek\.com$/i.test(host);
}

function queryDsCookies(dbPath) {
  const { tmp, dest } = copyDb(dbPath);
  try {
    const sql = [
      'SELECT host_key, name, value, hex(encrypted_value) AS enc_hex, path,',
      '       expires_utc, is_secure, is_httponly, creation_utc',
      'FROM cookies',
      "WHERE host_key LIKE '%deepseek%'",
      'ORDER BY length(path) DESC, creation_utc ASC'
    ].join('\n');
    const out = execFileSync('/usr/bin/sqlite3', ['-json', dest, sql], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    });
    const trimmed = out.trim();
    return trimmed ? JSON.parse(trimmed) : [];
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function readDsCookies(dbPath, password) {
  const rows = queryDsCookies(dbPath);
  const key = deriveKey(password);
  return rows.map((row) => {
    let value;
    if (row.value !== null && row.value !== undefined && String(row.value) !== '') {
      value = String(row.value);
    } else {
      value = decryptCookie(Buffer.from(row.enc_hex || '', 'hex'), key, row.host_key);
    }
    return { ...row, value };
  });
}

function readDsLocalStorage(profileDir, browserId) {
  const b = BROWSERS[browserId];
  const lsDir = path.join(b.root, profileDir, 'Local Storage', 'leveldb');
  if (!fs.existsSync(lsDir)) return {};
  const result = {};
  const files = fs.readdirSync(lsDir).filter(f => f.endsWith('.log') || f.endsWith('.ldb'));
  for (const file of files) {
    try {
      const data = fs.readFileSync(path.join(lsDir, file));
      const text = data.toString('latin1');
      const tokenMatch = text.match(/userToken[\s\S]{0,10}(\{[^}]*"value":"([A-Za-z0-9+/]{40,80})"[^}]*\})/);
      if (tokenMatch && !result.userToken) result.userToken = tokenMatch[2];
      const devMatch = text.match(/deepseek-device-id:chat[\s\S]{0,10}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
      if (devMatch && !result.deviceId) result.deviceId = devMatch[1];
    } catch {}
  }
  return result;
}

function dsSessionFromProfile(profile, password, browserId) {
  const all = readDsCookies(profile.db, password);
  const cookies = all.filter((c) => appliesToDeepSeek(c.host_key) && !isExpired(c.expires_utc));
  if (!cookies.length) return null;
  const byName = new Map();
  for (const c of cookies) byName.set(c.name, c);
  if (!byName.has('ds_session_id')) return null;
  const ls = readDsLocalStorage(profile.dir, browserId);
  if (!ls.userToken) return null;
  let thumbcacheValue = '';
  for (const c of cookies) {
    if (c.name.startsWith('.thumbcache_')) { thumbcacheValue = c.value; break; }
  }
  return {
    profile, cookies, byName,
    token: ls.userToken,
    deviceId: ls.deviceId || '',
    sessionId: byName.get('ds_session_id').value,
    wafToken: byName.has('aws-waf-token') ? byName.get('aws-waf-token').value : '',
    thumbcache: thumbcacheValue
  };
}

function dsAccountFromSession(session) {
  const id = session.token.slice(0, 8) + '…' + session.token.slice(-4);
  return {
    id: 'ds-' + id,
    label: session.profile.name || session.profile.dir || id,
    email: session.profile.account || '',
    token: session.token,
    deviceId: session.deviceId,
    wafToken: session.wafToken,
    sessionId: session.sessionId,
    thumbcache: session.thumbcache,
    exhaustedUntil: 0, invalidUntil: 0, lastUsedAt: 0, lastError: ''
  };
}

function scanDsSessions(opts) {
  const profiles = loadProfiles(opts.browser);
  if (!profiles.length) throw new Error('No ' + BROWSERS[opts.browser].label + ' profiles found.');
  const password = keychainPassword(opts.browser);
  const sessions = [];
  const skipped = [];
  for (const p of profiles) {
    try {
      const session = dsSessionFromProfile(p, password, opts.browser);
      if (session) sessions.push(session);
      else skipped.push({ profile: p, reason: 'no DeepSeek session' });
    } catch (err) {
      skipped.push({ profile: p, reason: String((err && err.message) || err).split('\n')[0] });
    }
  }
  return { sessions, skipped };
}

function writeDsPoolCommand(opts) {
  const { sessions, skipped } = scanDsSessions(opts);
  if (!sessions.length) {
    throw new Error(
      'No profile contains a DeepSeek session — the pool would be empty.\n' +
      'Sign in at https://chat.deepseek.com in at least one Chrome profile, then rerun.\n\nProfiles checked:\n' +
      skipped.map((s) => '  - ' + profileLabel(s.profile) + ' — ' + s.reason).join('\n')
    );
  }
  let existing = null;
  try {
    const raw = JSON.parse(fs.readFileSync(opts.dsPoolFile, 'utf8'));
    existing = Array.isArray(raw) ? raw : (raw.accounts || []);
  } catch {}
  const prevById = new Map();
  for (const a of existing || []) { if (a.token) prevById.set(a.token.slice(0, 12), a); }
  const byToken = new Map();
  for (const s of sessions) {
    const account = dsAccountFromSession(s);
    const prev = prevById.get(account.token.slice(0, 12));
    if (prev) {
      account.exhaustedUntil = Number(prev.exhaustedUntil) || 0;
      account.invalidUntil = Number(prev.invalidUntil) || 0;
      account.lastUsedAt = Number(prev.lastUsedAt) || 0;
      account.lastError = prev.lastError ? String(prev.lastError).slice(0, 300) : '';
    }
    if (!byToken.has(account.token)) byToken.set(account.token, account);
  }
  const accounts = [...byToken.values()];
  fs.mkdirSync(path.dirname(opts.dsPoolFile), { recursive: true });
  let backup = null;
  if (fs.existsSync(opts.dsPoolFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backup = opts.dsPoolFile + '.bak.' + stamp;
    fs.copyFileSync(opts.dsPoolFile, backup);
    try { fs.chmodSync(backup, 0o600); } catch {}
  }
  const payload = { version: 1, updatedAt: new Date().toISOString(), accounts };
  const tmp = opts.dsPoolFile + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, opts.dsPoolFile);
  console.log(BROWSERS[opts.browser].label + ' — collected ' + sessions.length + ' DeepSeek session(s), ' + accounts.length + ' unique account(s):\n');
  for (const a of accounts) {
    const now = Date.now();
    const state = a.exhaustedUntil > now ? 'quota parked' : a.invalidUntil > now ? 'session cooldown' : 'ready';
    console.log('  ● ' + a.label + (a.email ? ' — ' + a.email : '') +
      '\n      token ' + mask(a.token) + ' | deviceId ' + (a.deviceId || '(none)') +
      ' | session ' + mask(a.sessionId) + ' | ' + state);
  }
  console.log('\nWrote ' + opts.dsPoolFile + (backup ? '\nBackup: ' + backup : ''));
  console.log('File mode: 0600 (contains live tokens — keep it out of git)');
  console.log('\nRestart the bridge to pick up the pool:');
  console.log("  kill $(cat /tmp/mimo-bridge.pid); cd " + HERE + ' && nohup node bridge.js > /tmp/mimo-bridge.log 2>&1 &');
}

/* ------------------------------- main ------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();
  if (opts.selfTest) return selfTest();
  if (opts.list) return listProfiles(opts);
  if (opts.dsWritePool) return writeDsPoolCommand(opts);
  if (opts.writePool) return writePoolCommand(opts);
  if (opts.all) {
    listAllSessions(opts);
    if (opts.verify) await verifyBridge(opts.envFile, opts.port);
    return;
  }
  if (opts.verify && !opts.write) return verifyBridge(opts.envFile, opts.port);

  const profile = opts.db
    ? { dir: null, name: 'custom database', account: '', db: opts.db }
    : chooseProfile(opts);

  if (!fs.existsSync(profile.db)) {
    throw new Error('cookie database not found: ' + profile.db);
  }

  const password = keychainPassword(opts.browser);
  const all = readCookies(profile.db, password);
  const cookies = all.filter((c) => appliesToAistudio(c.host_key) && !isExpired(c.expires_utc));

  if (!cookies.length) {
    throw new Error(
      'No live Xiaomi AI Studio cookies in ' + profileLabel(profile) + '.\n' +
      'Sign in at https://aistudio.xiaomimimo.com in that profile, then rerun.'
    );
  }

  const byName = new Map();
  for (const c of cookies) byName.set(c.name, c);

  const missing = REQUIRED.filter((n) => !byName.has(n));
  if (missing.length) {
    throw new Error(
      'Missing required cookie' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ') + '\n' +
      'Found: ' + cookies.map((c) => c.name).join(', ') + '\n' +
      'Make sure you are signed in at https://aistudio.xiaomimimo.com in this profile.'
    );
  }

  console.log('Profile   : ' + profileLabel(profile));
  console.log('Cookie DB : ' + profile.db);
  console.log('Cookies   :');
  for (const c of cookies) {
    console.log('  ' + (REQUIRED.includes(c.name) ? '●' : '○') + ' ' + c.name.padEnd(26) +
      mask(c.value).padEnd(22) + ' expires ' + formatExpiry(c.expires_utc) +
      (Number(c.is_httponly) ? '  httpOnly' : ''));
  }

  for (const name of OPTIONAL) {
    if (!byName.has(name)) console.warn('  ! optional cookie "' + name + '" not found — raw-cookie mode still works');
  }

  const latest = Math.max(0, ...cookies.map((c) => Number(c.expires_utc) || 0));
  if (latest) {
    const days = Math.floor((CHROME_EPOCH_MS + Math.floor(latest / 1000) - Date.now()) / 86400000);
    console.log('Session   : valid for ~' + days + ' more day' + (days === 1 ? '' : 's'));
  }

  const header = cookies.map((c) => c.name + '=' + c.value).join('; ');
  console.log('Preview   : ' + cookies.map((c) => c.name + '=' + mask(c.value)).join('; '));

  if (!opts.write) {
    console.log('\nDry run — nothing written. Re-run with --write to update ' + opts.envFile);
    if (opts.verify) await verifyBridge(opts.envFile, opts.port);
    return;
  }

  const values = {
    XIAOMI_COOKIE: header,
    XIAOMI_USER_ID: byName.has('userId') ? byName.get('userId').value : '',
    XIAOMI_PH: byName.get('xiaomichatbot_ph').value
  };
  const { backup } = writeEnvFile(opts.envFile, values);

  console.log('\nWrote XIAOMI_COOKIE, XIAOMI_USER_ID, XIAOMI_PH to ' + opts.envFile);
  if (backup) console.log('Backup: ' + backup);
  console.log('Restart the bridge to pick them up:');
  console.log("  kill $(cat /tmp/mimo-bridge.pid); cd " + HERE + ' && nohup node bridge.js > /tmp/mimo-bridge.log 2>&1 &');

  if (opts.verify) {
    console.log('\nSkipping --verify: the running bridge still holds the old cookies.');
    console.log('Restart it, then run: node chrome-auth.js --verify');
  }
}

/* ----------------------------- self-test ----------------------------- */

function encryptForTest(plain, key, hostKey, bindHost) {
  const iv = Buffer.alloc(16, 0x20);
  const d = crypto.createCipheriv('aes-128-cbc', key, iv);
  const prefix = bindHost ? crypto.createHash('sha256').update(hostKey).digest() : Buffer.alloc(0);
  const body = Buffer.concat([prefix, Buffer.from(plain, 'utf8')]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), d.update(body), d.final()]);
}

function selfTest() {
  const password = 'self-test-password';
  const key = deriveKey(password);
  const host = '.xiaomimimo.com';
  const samples = [
    'a'.repeat(64),
    '123456789012',
    '"FAKETESTPH_AAAABBBBCCCC%3D%3D"'
  ];
  for (const sample of samples) {
    for (const bind of [false, true]) {
      const enc = encryptForTest(sample, key, host, bind);
      const got = decryptCookie(enc, key, host);
      if (got !== sample) throw new Error('round-trip failed for ' + JSON.stringify(sample) + ' (host-bound: ' + bind + ')');
    }
  }
  if (!appliesToAistudio('.xiaomimimo.com') || !appliesToAistudio('aistudio.xiaomimimo.com')) {
    throw new Error('host matching is broken');
  }
  if (appliesToAistudio('example.com')) throw new Error('host matching is too broad');

  const env = '# keep me\nXIAOMI_COOKIE=old\nPORT=8789\n';
  const next = setEnvValue(env, 'XIAOMI_COOKIE', 'new; value=1');
  if (!next.includes('# keep me') || !next.includes('XIAOMI_COOKIE=new; value=1')) {
    throw new Error('env rewriting is broken');
  }
  console.log('self-test: ok (AES-128-CBC v10, host-bound prefix, host matching, env rewrite)');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n✖ ' + ((err && err.message) || err));
    process.exit(1);
  });
}

module.exports = {
  BROWSERS, parseArgs, loadProfiles, chooseProfile,
  queryCookies, deriveKey, decryptCookie, decryptCbc, readCookies,
  appliesToAistudio, isExpired, formatExpiry,
  setEnvValue, writeEnvFile,
  sessionFor, scanSessions, accountsFromSessions, loadPool, writePoolFile,
  queryDsCookies, readDsCookies, readDsLocalStorage, dsSessionFromProfile,
  dsAccountFromSession, scanDsSessions, writeDsPoolCommand,
  mask, selfTest
};
