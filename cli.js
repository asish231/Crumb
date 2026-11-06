'use strict';

/* cli.js — consume a /stream endpoint, reassemble it, print the result.
 *
 *   node cli.js [--url U] [--port N] [--mode clean|mojibake] [--fix] [--raw] [--quiet]
 *
 * The decoder always runs in streaming mode, so multibyte characters split
 * across socket chunks survive. --fix additionally runs the mojibake repair
 * over the final text (for streams that were already damaged upstream).
 */

const Wire = require('./wire.js');

function parseArgs(argv) {
  const args = { url: '', port: 8787, mode: 'clean', fix: false, raw: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i] || '';
    else if (a === '--port') args.port = Number(argv[++i]) || 8787;
    else if (a === '--mode') args.mode = argv[++i] || 'clean';
    else if (a === '--fix') args.fix = true;
    else if (a === '--raw') args.raw = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function help() {
  process.stdout.write(
    'usage: node cli.js [--url http://host:port] [--port 8787]\n' +
    '                   [--mode clean|mojibake] [--fix] [--raw] [--quiet]\n'
  );
}

function countFrameTypes(events) {
  const counts = {};
  for (const ev of events) counts[ev.event] = (counts[ev.event] || 0) + 1;
  return counts;
}

async function run(args) {
  const base = (args.url || 'http://127.0.0.1:' + args.port).replace(/\/+$/, '');
  const url = base + '/stream?mode=' + encodeURIComponent(args.mode);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error('request failed: ' + res.status + ' ' + res.statusText);
  }

  const decoder = new TextDecoder('utf-8'); // used with {stream:true} below
  const parser = new Wire.SseParser();
  const asm = new Wire.StreamAssembler();
  const reader = res.body.getReader();

  let frames = 0;
  let finishSeen = false;
  let dialogId = null;
  let usage = null;
  let lastPainted = 0;
  const events = [];

  function handle(ev) {
    frames++;
    if (args.raw) process.stdout.write('[' + ev.event + '] ' + ev.data + '\n');
    const d = Wire.decodeSse(ev.event, ev.data);
    if (ev.event === 'dialogId' && d.dialogId) dialogId = d.dialogId;
    else if (ev.event === 'message' && d.content) {
      asm.push(d.content);
      if (!args.quiet) paint(asm.project().visible);
    } else if (ev.event === 'usage' && d.usage) {
      usage = d.usage; // cumulative — last frame wins
    }
    if (d.done || ev.event === 'finish') finishSeen = true;
  }

  function paint(visible) {
    if (visible.length === lastPainted) return;
    process.stdout.write('\r\x1b[2K' + visible.slice(0, 78));
    lastPainted = visible.length;
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const evs = parser.push(decoder.decode(value, { stream: true }));
    for (const ev of evs) { events.push(ev); handle(ev); }
  }
  for (const ev of parser.flush()) { events.push(ev); handle(ev); }
  if (!args.quiet) process.stdout.write('\r\x1b[2K');

  const final = asm.finish();
  let visible = final.visible;
  let repaired = null;
  if (args.fix) {
    const fixed = Wire.fixMojibake(visible);
    repaired = fixed === visible ? 'no damage found' : 'repaired';
    visible = fixed;
  }

  process.stdout.write(
    'dialog      ' + (dialogId || '(none)') + '\n' +
    'frames      ' + frames + '  ' + JSON.stringify(countFrameTypes(events)) + '\n' +
    'deltas      ' + final.deltas + ' concatenated\n' +
    'thinking    ' + final.thinking.length + ' chars (extracted)\n' +
    'visible     ' + visible.length + ' chars\n' +
    'usage       completion ' + (usage && usage.completionTokens) + ' / total ' + (usage && usage.totalTokens) + '\n' +
    'finish      ' + (finishSeen ? 'clean ([DONE] received)' : 'MISSING') + '\n' +
    'repair      ' + (args.fix ? repaired : 'not requested (use --fix)') + '\n' +
    '\n--- visible text ---\n' + visible + '\n'
  );

  return { dialogId, usage, finishSeen, visible, thinking: final.thinking, frames };
}

module.exports = { run, parseArgs };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); process.exit(0); }
  run(args).catch((err) => {
    console.error('error: ' + err.message);
    process.exit(1);
  });
}
