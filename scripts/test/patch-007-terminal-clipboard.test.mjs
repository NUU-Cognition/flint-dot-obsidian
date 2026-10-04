// Patch 007: the copy and paste chords of the terminal on Linux.
// The tests take the real key handler class (Gc) and the real p0 helper from the released bundle
// (payload/plugins/terminal/main.js) and from the unpatched bundle (upstream/terminal/main.js), and run
// them with a fake xterm.js terminal, a fake clipboard, and a fake core service that records each send.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { ROOT } from '../lib.mjs';

const PATCHED = readFileSync(join(ROOT, 'payload/plugins/terminal/main.js'), 'utf8');
const UPSTREAM = readFileSync(join(ROOT, 'upstream/terminal/main.js'), 'utf8');
const ANCHOR = 'activate(t){let i=a=>n1(this,Er)?!0:a.key==="Enter"&&a.shiftKey?';
const ESC = '\x1B';
const INSERT = 45, C = 67, V = 86, ENTER = 13;

/** The source of `var Er,Gc=class{...};Er=new WeakMap;` and of `function p0(e){...}` in one bundle. */
function extract(src) {
  const start = src.indexOf('var Er,Gc=class{');
  const end = src.indexOf('};Er=new WeakMap;', start);
  const p0Start = src.indexOf('function p0(e){');
  const p0End = src.indexOf('return self.activeWindow}', p0Start);
  assert.ok(start >= 0 && end > start && p0Start >= 0 && p0End > p0Start, 'the bundle holds Gc and p0');
  return { gc: src.slice(start, end + '};Er=new WeakMap;'.length), p0: src.slice(p0Start, p0End + 'return self.activeWindow}'.length) };
}

/** The Gc class of one bundle on one platform. The private-field helpers do what the esbuild helpers do. */
function loadGc(src, platform) {
  const { gc, p0 } = extract(src);
  return new Function('A2', 'self', `
    var w9="\\x1B";
    var M1=(e,t,i)=>{if(t.has(e))throw TypeError("twice");t.set(e,i)};
    var n1=(e,t)=>{if(!t.has(e))throw TypeError("read");return t.get(e)};
    var y1=(e,t,i)=>{if(!t.has(e))throw TypeError("write");t.set(e,i);return i};
    ${p0}
    ${gc}
    return Gc;`)({ CURRENT: platform }, { activeWindow: null });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((y, n) => { resolve = y; reject = n; });
  return { promise, resolve, reject };
}

/**
 * A fake xterm.js terminal. `sent` records each send of the core service in order: user input as is,
 * other data as `reply:<data>`. paste() sends the bracketed text, as xterm.js does in bracketed paste mode.
 * `reads` is a list of results for readText(): a string, an Error (a rejection), or a deferred.
 */
function terminal({ selection = '', reads = ['clip text'], core = true, failWrite = false } = {}) {
  const fx = { sent: [], paste: [], input: [], written: [], errors: [] };
  const coreService = { triggerDataEvent(d, u = false) { fx.sent.push(u ? d : `reply:${d}`); } };
  const original = coreService.triggerDataEvent;
  const queue = [...reads];
  const win = {
    navigator: {
      clipboard: {
        writeText: async (s) => { if (failWrite) throw new Error('denied'); fx.written.push(s); },
        readText: () => {
          const next = queue.shift() ?? 'clip text';
          if (next instanceof Error) return Promise.reject(next);
          return typeof next === 'string' ? Promise.resolve(next) : next.promise;
        },
      },
    },
    console: { error: (e) => fx.errors.push(String(e)) },
  };
  const t = {
    element: { ownerDocument: { defaultView: win } },
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    paste(s) { fx.paste.push(s); coreService.triggerDataEvent(`${ESC}[200~${s}${ESC}[201~`, true); },
    input(s, u = true) { fx.input.push(s); coreService.triggerDataEvent(s, u); },
    attachCustomKeyEventHandler(fn) { this.handler = fn; },
  };
  if (core) t._core = { coreService };
  return { t, fx, coreService, original };
}

const KEYS = { 45: ['Insert', 'Insert'], 67: ['c', 'C'], 86: ['v', 'V'], 13: ['Enter', 'Enter'], 37: ['ArrowLeft', 'ArrowLeft'], 65: ['a', 'A'], 8: ['Backspace', 'Backspace'] };

/** A keyboard event. `mods` holds the letters c (Ctrl), s (Shift), a (Alt), and m (Meta or Super). */
function key(keyCode, mods = '', type = 'keydown') {
  const shift = mods.includes('s');
  return {
    type, keyCode, key: KEYS[keyCode][shift ? 1 : 0],
    ctrlKey: mods.includes('c'), shiftKey: shift, altKey: mods.includes('a'), metaKey: mods.includes('m'),
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** Activate a handler of one bundle on a fake terminal. */
function setup(src, platform, opts = {}, passthrough = false) {
  const Gc = loadGc(src, platform);
  const g = new Gc(() => passthrough);
  const term = terminal(opts);
  g.activate(term.t);
  return { g, ...term };
}

/**
 * Press one key as xterm.js does: the custom handler first; when it returns true, a keydown of
 * Enter, Ctrl+C, Ctrl+V, or a letter sends its data through the core service.
 */
function press(s, event) {
  const result = s.t.handler(event);
  if (result && event.type === 'keydown') {
    const data = event.keyCode === ENTER ? '\r'
      : event.ctrlKey && event.keyCode === C ? '\x03'
        : event.ctrlKey && event.keyCode === V ? '\x16'
          : !event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1 ? event.key : null;
    if (data) s.t._core.coreService.triggerDataEvent(data, true);
  }
  return result;
}

async function run(src, platform, event, opts = {}, passthrough = false) {
  const s = setup(src, platform, opts, passthrough);
  const result = s.t.handler(event);
  await settle();
  return { result, event, fx: s.fx };
}

const bracket = (s) => `${ESC}[200~${s}${ESC}[201~`;

test('patch 007: the anchor is unique in the upstream bundle, and the released bundle holds the new handler', () => {
  assert.equal(UPSTREAM.split(ANCHOR).length, 2);
  assert.equal(PATCHED.split(ANCHOR).length, 1);
  assert.ok(PATCHED.includes('i=a=>n1(this,Er)?!0:q(a)?!1:a.key==="Enter"&&a.shiftKey?'));
});

for (const [name, code, mods] of [['Ctrl+Shift+C', C, 'cs'], ['Ctrl+Insert', INSERT, 'c'], ['Ctrl+Insert with Super held', INSERT, 'cm']]) {
  test(`patch 007 on linux: ${name} copies the selection and sends nothing`, async () => {
    const { result, event, fx } = await run(PATCHED, 'linux', key(code, mods), { selection: 'hello world' });
    assert.equal(result, false);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(fx.written, ['hello world']);
    assert.deepEqual([fx.sent, fx.paste], [[], []]);
  });

  test(`patch 007 on linux: ${name} with no selection does nothing`, async () => {
    const { result, event, fx } = await run(PATCHED, 'linux', key(code, mods));
    assert.equal(result, false);
    assert.equal(event.prevented, true);
    assert.deepEqual([fx.written, fx.sent], [[], []]);
  });

  test(`patch 007 on linux: the keyup of ${name} makes no second copy`, async () => {
    const { result, event, fx } = await run(PATCHED, 'linux', key(code, mods, 'keyup'), { selection: 'x' });
    assert.equal(result, false);
    assert.equal(event.prevented, false);
    assert.deepEqual(fx.written, []);
  });
}

for (const [name, code, mods] of [['Ctrl+Shift+V', V, 'cs'], ['Shift+Insert', INSERT, 's'], ['Shift+Insert with Super held', INSERT, 'sm']]) {
  test(`patch 007 on linux: ${name} pastes the clipboard one time through paste() of xterm.js`, async () => {
    const { result, event, fx } = await run(PATCHED, 'linux', key(code, mods), { reads: ['line 1\nline 2'] });
    assert.equal(result, false);
    assert.equal(event.prevented, true, 'the default paste of Chromium stops, so the text does not paste two times');
    assert.deepEqual(fx.paste, ['line 1\nline 2']);
    assert.deepEqual(fx.sent, [bracket('line 1\nline 2')]);
  });
}

test('patch 007 on linux: Ctrl+C with a selection is not changed (xterm.js sends ^C, SIGINT)', async () => {
  const { result, event, fx } = await run(PATCHED, 'linux', key(C, 'c'), { selection: 'hello' });
  assert.equal(result, true);
  assert.equal(event.prevented, false);
  assert.deepEqual(fx.written, []);
});

test('patch 007 on linux: Ctrl+C with no selection, Ctrl+V, Insert, and plain keys are not changed', async () => {
  for (const ev of [key(C, 'c'), key(V, 'c'), key(INSERT), key(65), key(65, 's')]) {
    const { result, event, fx } = await run(PATCHED, 'linux', ev);
    assert.equal(result, true, `${ev.key} ctrl=${ev.ctrlKey}`);
    assert.equal(event.prevented, false);
    assert.deepEqual([fx.written, fx.paste, fx.sent], [[], [], []]);
  }
});

test('patch 007 on linux: Alt, Super on C or V, and Ctrl+Shift+Insert cancel the chords', async () => {
  for (const ev of [key(INSERT, 'ca'), key(INSERT, 'sa'), key(C, 'csa'), key(V, 'csa'), key(C, 'csm'), key(V, 'csm'), key(INSERT, 'cs')]) {
    const { result, event, fx } = await run(PATCHED, 'linux', ev, { selection: 'x' });
    assert.equal(result, true);
    assert.equal(event.prevented, false);
    assert.deepEqual([fx.written, fx.paste], [[], []]);
  }
});

test('patch 007 on linux: a keypress of "-" with Shift (character code 45) is not Shift+Insert', async () => {
  const { result, event, fx } = await run(PATCHED, 'linux', { ...key(INSERT, 's', 'keypress'), key: '-', charCode: 45 });
  assert.equal(result, true);
  assert.equal(event.prevented, false);
  assert.deepEqual(fx.paste, []);
});

test('patch 007 on linux: Shift+Enter keeps the upstream behaviour', async () => {
  const { result, fx } = await run(PATCHED, 'linux', key(ENTER, 's'));
  assert.equal(result, false);
  assert.deepEqual(fx.sent, [`${ESC}\r`]);
});

test('patch 007 on linux: after dispose, the chords go to xterm.js and input is not held', async () => {
  const s = setup(PATCHED, 'linux', { selection: 'x' });
  s.g.dispose();
  const ev = key(C, 'cs');
  assert.equal(s.t.handler(ev), true);
  s.t._core.coreService.triggerDataEvent('a', true);
  await settle();
  assert.equal(ev.prevented, false);
  assert.deepEqual([s.fx.written, s.fx.sent], [[], ['a']]);
});

test('patch 007 on linux: a clipboard write failure goes to the console and does not throw', async () => {
  const { result, fx } = await run(PATCHED, 'linux', key(INSERT, 'c'), { selection: 'x', failWrite: true });
  assert.equal(result, false);
  assert.equal(fx.errors.length, 1);
  assert.match(fx.errors[0], /denied/);
});

// The order of the input while a clipboard read waits.

test('patch 007 on linux: a delayed read holds the next keys, then sends the paste before them', async () => {
  const read = deferred();
  const s = setup(PATCHED, 'linux', { reads: [read] });
  press(s, key(V, 'cs'));
  press(s, key(65));
  press(s, key(ENTER));
  await settle();
  assert.deepEqual(s.fx.sent, [], 'nothing goes out while the read waits');
  read.resolve('ls -la');
  await settle();
  assert.deepEqual(s.fx.sent, [bracket('ls -la'), 'a', '\r']);
  press(s, key(65));
  assert.deepEqual(s.fx.sent.at(-1), 'a', 'with no read waiting, input goes out at once');
});

test('patch 007 on linux: two pastes go out in the order of the keys when the second read settles first', async () => {
  const first = deferred(), second = deferred();
  const s = setup(PATCHED, 'linux', { reads: [first, second] });
  press(s, key(V, 'cs'));
  press(s, key(65));
  press(s, key(INSERT, 's'));
  press(s, key(ENTER));
  second.resolve('two');
  await settle();
  assert.deepEqual(s.fx.sent, []);
  first.resolve('one');
  await settle();
  assert.deepEqual(s.fx.sent, [bracket('one'), 'a', bracket('two'), '\r']);
});

test('patch 007 on linux: a read that fails pastes nothing, and the held input goes out', async () => {
  const read = deferred();
  const s = setup(PATCHED, 'linux', { reads: [read] });
  press(s, key(INSERT, 's'));
  press(s, key(ENTER));
  read.reject(new Error('read denied'));
  await settle();
  assert.deepEqual(s.fx.sent, ['\r']);
  assert.deepEqual(s.fx.paste, []);
  assert.equal(s.fx.errors.length, 1);
  assert.match(s.fx.errors[0], /read denied/);
});

test('patch 007 on linux: a read that fails at once pastes nothing and holds nothing', async () => {
  const s = setup(PATCHED, 'linux', { reads: [new Error('no clipboard')] });
  press(s, key(V, 'cs'));
  await settle();
  press(s, key(65));
  assert.deepEqual(s.fx.sent, ['a']);
  assert.equal(s.fx.errors.length, 1);
});

test('patch 007 on linux: a read that takes more than 2 seconds pastes nothing, and the held input goes out', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const read = deferred();
    const s = setup(PATCHED, 'linux', { reads: [read] });
    press(s, key(V, 'cs'));
    press(s, key(ENTER));
    mock.timers.tick(1999);
    await settle();
    assert.deepEqual(s.fx.sent, []);
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(s.fx.sent, ['\r']);
    assert.match(s.fx.errors[0], /timed out/);
    read.resolve('late');
    await settle();
    assert.deepEqual(s.fx.sent, ['\r'], 'a late read pastes nothing');
  } finally {
    mock.timers.reset();
  }
});

test('patch 007 on linux: Ctrl+C goes out at once and clears the held pastes and input', async () => {
  const read = deferred(), next = deferred();
  const s = setup(PATCHED, 'linux', { reads: [read, next] });
  press(s, key(V, 'cs'));
  press(s, key(65));
  press(s, key(ENTER));
  press(s, key(C, 'c'));
  assert.deepEqual(s.fx.sent, ['\x03']);
  read.resolve('rm -rf build');
  await settle();
  assert.deepEqual(s.fx.sent, ['\x03'], 'the paste and the input before Ctrl+C are discarded');
  press(s, key(INSERT, 's'));
  press(s, key(ENTER));
  next.resolve('echo ok');
  await settle();
  assert.deepEqual(s.fx.sent, ['\x03', bracket('echo ok'), '\r'], 'a paste after Ctrl+C works');
});

test('patch 007 on linux: data that is not user input is not held', async () => {
  const read = deferred();
  const s = setup(PATCHED, 'linux', { reads: [read] });
  press(s, key(V, 'cs'));
  s.t._core.coreService.triggerDataEvent(`${ESC}[0n`, false);
  assert.deepEqual(s.fx.sent, [`reply:${ESC}[0n`]);
  read.resolve('x');
  await settle();
  assert.deepEqual(s.fx.sent, [`reply:${ESC}[0n`, bracket('x')]);
});

test('patch 007 on linux: input from t.input (the Alt passthrough path) waits in the same queue', async () => {
  const read = deferred();
  const s = setup(PATCHED, 'linux', { reads: [read] });
  press(s, key(V, 'cs'));
  s.t.input(`${ESC}b`);
  read.resolve('x');
  await settle();
  assert.deepEqual(s.fx.sent, [bracket('x'), `${ESC}b`]);
});

test('patch 007 on linux: with no core service, a paste still works', async () => {
  const { fx } = await run(PATCHED, 'linux', key(V, 'cs'), { core: false, reads: ['plain'] });
  assert.deepEqual(fx.paste, ['plain']);
});

test('patch 007 on darwin: the core service is not wrapped', () => {
  const s = setup(PATCHED, 'darwin');
  assert.equal(s.coreService.triggerDataEvent, s.original);
  const l = setup(PATCHED, 'linux');
  assert.notEqual(l.coreService.triggerDataEvent, l.original);
});

// The full matrix: every key, every modifier set, keydown, keyup, and keypress.
const MOD_SETS = ['', 'c', 's', 'a', 'm', 'cs', 'ca', 'cm', 'sa', 'sm', 'am', 'csa', 'csm', 'cam', 'sam', 'csam'];
function* matrix() {
  for (const code of Object.keys(KEYS).map(Number)) for (const mods of MOD_SETS) for (const type of ['keydown', 'keyup', 'keypress']) yield [code, mods, type];
}
const snapshot = (r) => JSON.stringify({ result: r.result, prevented: r.event.prevented, stopped: r.event.stopped, ...r.fx });

for (const passthrough of [false, true]) {
  test(`patch 007 on darwin: every event gives the result of upstream (Option passthrough ${passthrough ? 'on' : 'off'})`, async () => {
    let n = 0;
    for (const [code, mods, type] of matrix()) {
      const a = await run(PATCHED, 'darwin', key(code, mods, type), { selection: 'sel' }, passthrough);
      const b = await run(UPSTREAM, 'darwin', key(code, mods, type), { selection: 'sel' }, passthrough);
      assert.equal(snapshot(a), snapshot(b), `keyCode ${code} mods "${mods}" ${type}`);
      n++;
    }
    assert.equal(n, 7 * 16 * 3);
  });
}

test('patch 007 on linux: every event that is not a clipboard chord gives the result of upstream', async () => {
  const chord = (code, mods, type) => type !== 'keypress' && !mods.includes('a') && (
    (code === INSERT && mods.includes('c') !== mods.includes('s')) ||
    ((code === C || code === V) && mods.includes('c') && mods.includes('s') && !mods.includes('m')));
  let same = 0, changed = 0;
  for (const [code, mods, type] of matrix()) {
    const a = await run(PATCHED, 'linux', key(code, mods, type), { selection: 'sel' });
    const b = await run(UPSTREAM, 'linux', key(code, mods, type), { selection: 'sel' });
    if (chord(code, mods, type)) { assert.equal(a.result, false); changed++; } else { assert.equal(snapshot(a), snapshot(b), `keyCode ${code} mods "${mods}" ${type}`); same++; }
  }
  assert.equal(changed, 2 * (4 + 1 + 1)); // Insert: c, cm, s, sm; C: cs; V: cs; as keydown and keyup
  assert.equal(same, 7 * 16 * 3 - changed);
});
