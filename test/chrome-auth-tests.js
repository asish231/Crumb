'use strict';

/* chrome-auth-tests.js — verifies cookie decryption and the full --db CLI path
 * against a synthetic Chrome cookie database. No Chrome, Keychain or Full Disk
 * Access needed.
 *
 *   node test/chrome-auth-tests.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const Auth = require('../chrome-auth.js');

const CHROME_EPOCH_MS = Date.UTC(1601, 0, 1);
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function encrypt(plain, key, host, bindHost) {
  const iv = Buffer.alloc(16, 0x20);
  const d = crypto.createCipheriv('aes-128-cbc', key, iv);
  const prefix = bindHost ? crypto.createHash('sha256').update(host).digest() : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from('v10', 'latin1'),
    d.update(Buffer.concat([prefix, Buffer.from(plain, 'utf8')])),
    d.final()
  ]);
}

function sqlQuote(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function makeDb(dir, password) {
  const db = path.join(dir, 'Cookies');
  const key = Auth.deriveKey(password);
  const host = '.xiaomimimo.com';
  const future = (Date.now() + 10 * 86400000 - CHROME_EPOCH_MS) * 1000;

  const rows = [
    {
      host, name: 'xiaomichatbot_serviceToken', value: null,
      enc: encrypt('svc-token-123', key, host, true), // Chrome 130 host-bound shape
      expires: future, httpOnly: 1, created: 1
    },
    {
      host, name: 'userId', value: '570391234567',
      enc: null, expires: future, httpOnly: 0, created: 2
    },
    {
      host, name: 'xiaomichatbot_ph', value: null,
      enc: encrypt('"FAKETESTPH_AAAABBBBCCCC%3D%3D"', key, host, false),
      expires: future, httpOnly: 0, created: 3
    },
    {
      host, name: 'expired-cookie', value: 'gone',
      enc: null, expires: (Date.now() - 86400000 - CHROME_EPOCH_MS) * 1000, httpOnly: 0, created: 4
    }
  ];

  const sql = [
    'CREATE TABLE cookies (',
    '  host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,',
    '  expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, creation_utc INTEGER',
    ');',
    ...rows.map((r) => 'INSERT INTO cookies VALUES (' + [
      sqlQuote(r.host), sqlQuote(r.name),
      r.value === null ? 'NULL' : sqlQuote(r.value),
      r.enc ? "X'" + r.enc.toString('hex') + "'" : 'NULL',
      sqlQuote('/'), String(r.expires), '1', String(r.httpOnly), String(r.created)
    ].join(',') + ');')
  ].join('\n');

  execFileSync('/usr/bin/sqlite3', [db], { input: sql });
  return db;
}

test('decryptCookie: v10 with and without the Chrome 130 host hash', () => {
  const key = Auth.deriveKey('pw');
  const host = '.xiaomimimo.com';
  for (const bind of [false, true]) {
    const enc = encrypt('token-' + bind, key, host, bind);
    assert.strictEqual(Auth.decryptCookie(enc, key, host), 'token-' + bind);
  }
  assert.throws(() => Auth.decryptCookie(Buffer.from('v20abc', 'latin1'), key, host), /v20/);
});

test('appliesToAistudio: domain cookies and the API host only', () => {
  assert.ok(Auth.appliesToAistudio('.xiaomimimo.com'));
  assert.ok(Auth.appliesToAistudio('aistudio.xiaomimimo.com'));
  assert.ok(!Auth.appliesToAistudio('other.xiaomimimo.com'));
  assert.ok(!Auth.appliesToAistudio('example.com'));
});

test('isExpired: session cookies are kept, past UTC times are dropped', () => {
  assert.strictEqual(Auth.isExpired(0), false);
  assert.strictEqual(Auth.isExpired((Date.now() + 3600000 - CHROME_EPOCH_MS) * 1000), false);
  assert.strictEqual(Auth.isExpired((Date.now() - 3600000 - CHROME_EPOCH_MS) * 1000), true);
});

test('setEnvValue: replaces in place and preserves comments', () => {
  const src = '# note\nXIAOMI_COOKIE=old\nPORT=8789\n';
  const out = Auth.setEnvValue(src, 'XIAOMI_COOKIE', 'a=1; b=2');
  assert.strictEqual(out, '# note\nXIAOMI_COOKIE=a=1; b=2\nPORT=8789\n');
  const appended = Auth.setEnvValue('PORT=8789\n', 'XIAOMI_PH', '"x"');
  assert.strictEqual(appended, 'PORT=8789\nXIAOMI_PH="x"\n');
});

test('pool: dedupe by userId, longest session wins, quota state preserved', () => {
  const future = (Date.now() + 5 * 86400000 - CHROME_EPOCH_MS) * 1000;
  const mk = (dir, userId, token, exp) => Auth.sessionFor({ dir, name: dir, account: userId + '@example.com' }, [
    { name: 'xiaomichatbot_serviceToken', value: token, expires_utc: exp, is_httponly: 1 },
    { name: 'userId', value: userId, expires_utc: exp, is_httponly: 0 },
    { name: 'xiaomichatbot_ph', value: '"ph-' + userId + '"', expires_utc: exp, is_httponly: 0 }
  ]);
  const existing = { accounts: [{ id: '111', exhaustedUntil: 123, invalidUntil: 0, lastUsedAt: 456, lastError: 'quota' }] };
  const { accounts, duplicates } = Auth.accountsFromSessions([
    mk('Default', '111', 'token-a', future),
    mk('Profile 1', '222', 'token-b', future),
    mk('Profile 9', '111', 'token-a-newer', future + 1000000)
  ], existing);

  assert.strictEqual(accounts.length, 2, 'one account per userId');
  assert.strictEqual(duplicates.length, 1, 'duplicate profile reported');
  assert.strictEqual(accounts[0].id, '111');
  assert.strictEqual(accounts[0].exhaustedUntil, 123, 'quota state survives regeneration');
  assert.strictEqual(accounts[0].lastUsedAt, 456);
  assert.strictEqual(accounts[0].lastError, 'quota');
  assert.ok(accounts[0].cookie.includes('token-a-newer'), 'longest-lived session kept');
  assert.strictEqual(accounts[1].userId, '222');
});

test('pool: writePoolFile is atomic, 0600, backed up, and round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-auth-pool-'));
  const file = path.join(dir, 'accounts.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [{ id: 'old' }] }), { mode: 0o644 });
    const { backup } = Auth.writePoolFile(file, [{ id: 'new', label: 'New', cookie: 'a=b' }]);
    assert.ok(backup && fs.existsSync(backup), 'backup created');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'pool is owner-only');
    const round = Auth.loadPool(file);
    assert.strictEqual(round.version, 1);
    assert.strictEqual(round.accounts.length, 1);
    assert.strictEqual(round.accounts[0].id, 'new');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: synthetic Chrome DB -> decrypted .env (dry run then --write)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-auth-test-'));
  const envFile = path.join(dir, '.env');
  const password = 'test-password';
  try {
    const db = makeDb(dir, password);
    const cli = path.join(__dirname, '..', 'chrome-auth.js');
    const env = { ...process.env, CHROME_COOKIE_PASSWORD: password };

    const dry = execFileSync(process.execPath, [cli, '--db', db, '--env-out', envFile], { encoding: 'utf8', env });
    assert.match(dry, /Dry run/);
    assert.ok(!fs.existsSync(envFile), 'dry run must not write');

    const out = execFileSync(process.execPath, [cli, '--db', db, '--env-out', envFile, '--write'], { encoding: 'utf8', env });
    assert.match(out, /Wrote XIAOMI_COOKIE/);

    const text = fs.readFileSync(envFile, 'utf8');
    assert.ok(text.includes('XIAOMI_COOKIE=xiaomichatbot_serviceToken=svc-token-123; userId=570391234567; xiaomichatbot_ph="FAKETESTPH_AAAABBBBCCCC%3D%3D"'));
    assert.ok(text.includes('XIAOMI_USER_ID=570391234567'));
    assert.ok(text.includes('XIAOMI_PH="FAKETESTPH_AAAABBBBCCCC%3D%3D"'));
    assert.ok(!text.includes('expired-cookie'), 'expired cookies must be skipped');

    const mode = fs.statSync(envFile).mode & 0o777;
    assert.strictEqual(mode, 0o600, '.env must be owner-only');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (err) {
      failed++;
      console.error('FAIL  ' + name);
      console.error('      ' + String((err && err.message) || err).split('\n').join('\n      '));
    }
  }
  console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed (of ' + tests.length + ')');
  process.exitCode = failed ? 1 : 0;
})();
