#!/usr/bin/env node
'use strict';

/* deepseek-check.js — send a real chat request to DeepSeek and check what comes back.
 *
 *   node deepseek-check.js                          # official API, non-streaming
 *   node deepseek-check.js --stream                 # official API, SSE stream
 *   node deepseek-check.js --model deepseek-reasoner
 *   node deepseek-check.js --pool --stream          # local llm-pool-proxy instead
 *   node deepseek-check.js --base URL --model M     # any OpenAI-compatible endpoint
 *   node deepseek-check.js --key-env MY_KEY         # read the key from MY_KEY
 *
 * Keys come from the environment or ./.env (DEEPSEEK_API_KEY by default,
 * POOL_PROXY_KEY with --pool). The key is never printed.
 */

const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile(file) {
  try {
    const out = {};
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  } catch { return {}; }
}

function parseArgs(argv) {
  const opts = { stream: false, pool: false, help: false };
  const take = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(name + ' needs a value');
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stream') opts.stream = true;
    else if (a === '--pool') opts.pool = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--base') { opts.base = take(i, a); i++; }
    else if (a.startsWith('--base=')) opts.base = a.slice('--base='.length);
    else if (a === '--model') { opts.model = take(i, a); i++; }
    else if (a.startsWith('--model=')) opts.model = a.slice('--model='.length);
    else if (a === '--key-env') { opts.keyEnv = take(i, a); i++; }
    else if (a.startsWith('--key-env=')) opts.keyEnv = a.slice('--key-env='.length);
    else if (a === '--prompt') { opts.prompt = take(i, a); i++; }
    else if (a.startsWith('--prompt=')) opts.prompt = a.slice('--prompt='.length);
    else throw new Error('unknown option: ' + a + ' (try --help)');
  }
  return opts;
}

const FILE_ENV = loadEnvFile(path.join(__dirname, '.env'));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 12).join('\n'));
    return;
  }

  const pickEnv = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : (FILE_ENV[k] !== undefined && FILE_ENV[k] !== '' ? FILE_ENV[k] : d));

  const base = (opts.base || (opts.pool ? pickEnv('POOL_BASE_URL', 'http://127.0.0.1:3001/v1') : pickEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'))).replace(/\/+$/, '');
  const keyEnv = opts.keyEnv || (opts.pool ? 'POOL_PROXY_KEY' : 'DEEPSEEK_API_KEY');
  const key = opts.pool ? pickEnv(keyEnv, 'pool') : pickEnv(keyEnv);
  const model = opts.model || (opts.pool ? 'deepseek-v3.2' : pickEnv('DEEPSEEK_MODEL', 'deepseek-chat'));
  const prompt = opts.prompt || 'Reply with exactly one word: DEEPSEEK_OK';

  if (!key) {
    console.error('No API key. Set ' + keyEnv + ' in the environment or in ./.env.');
    console.error('  export ' + keyEnv + '=...   # official: https://platform.deepseek.com');
    console.error('  node deepseek-check.js --pool --model deepseek-v3.2   # via local pool instead');
    process.exitCode = 2;
    return;
  }

  console.log('base  : ' + base);
  console.log('model : ' + model);
  console.log('key   : ' + keyEnv + ' (set, len ' + key.length + ', value hidden)');
  console.log('stream: ' + opts.stream);
  console.log('---');

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: opts.stream,
    max_tokens: 128
  };

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + key
    },
    body: JSON.stringify(body)
  });

  if (!opts.stream) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* print raw below */ }
    if (!res.ok) {
      console.error('HTTP ' + res.status);
      console.error(text.slice(0, 1000));
      process.exitCode = 1;
      return;
    }
    const choice = json && json.choices && json.choices[0];
    if (!choice) {
      console.error('Unexpected response shape: ' + text.slice(0, 500));
      process.exitCode = 1;
      return;
    }
    const msg = choice.message || {};
    if (msg.reasoning_content) console.log('reasoning_content: ' + msg.reasoning_content.slice(0, 2000));
    console.log('content            : ' + (msg.content || ''));
    if (json.usage) console.log('usage              : ' + JSON.stringify(json.usage));
    return;
  }

  if (!res.ok) {
    console.error('HTTP ' + res.status);
    console.error((await res.text()).slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  const raw = await res.text(); // SSE is already fully buffered for a 128-token reply
  let reasoning = '', content = '', frames = 0, done = false;
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') { done = true; continue; }
    try {
      const d = JSON.parse(payload);
      frames++;
      const delta = (d.choices && d.choices[0] && d.choices[0].delta) || {};
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.content === 'string') content += delta.content;
    } catch { /* keep-alive / stray comment frames */ }
  }
  console.log('frames             : ' + frames + (done ? ' (+[DONE])' : ' (stream ended without [DONE])'));
  console.log('reasoning_content   : ' + reasoning);
  console.log('content             : ' + content);
}

main().catch((err) => {
  console.error('\n✖ ' + ((err && err.message) || err));
  process.exit(1);
});
