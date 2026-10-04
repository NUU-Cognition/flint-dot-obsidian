// Patch 007: the copy and paste chords of the terminal on Linux.
// The tests take real code from the bundles: the key handler class (Gc) and the p0 helper of the released
// bundle (payload/plugins/terminal/main.js) and of the unpatched bundle (upstream/terminal/main.js), and,
// from the released bundle, the paste function and the composition helper of xterm.js and the onKey and
// onData callbacks of the developer console. Only the terminal around them is a fake.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib.mjs';

const PATCHED = readFileSync(join(ROOT, 'payload/plugins/terminal/main.js'), 'utf8');
const UPSTREAM = readFileSync(join(ROOT, 'upstream/terminal/main.js'), 'utf8');
const ANCHOR = 'activate(t){let i=a=>n1(this,Er)?!0:a.key==="Enter"&&a.shiftKey?';
const ESC = '\x1B';
const INSERT = 45, C = 67, V = 86, ENTER = 13;

/** The text between `start` (included) and `end` (included) in a bundle. */
function cut(src, start, end, from = 0) {
  const i = src.indexOf(start, from);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `the bundle holds ${start.slice(0, 40)}`);
  return src.slice(i, j + end.length);
}

/** The Gc class of one bundle on one platform. `require` answers "electron" with the given clipboard. */
function loadGc(src, platform, clipboard, calls) {
  const gc = cut(src, 'var Er,Gc=class{', '};Er=new WeakMap;');
  const p0 = cut(src, 'function p0(e){', 'return self.activeWindow}');
  const require = (name) => {
    calls.push(name);
    if (name === 'electron' && clipboard) return { clipboard };
    throw new Error(`Cannot find module '${name}'`);
  };
  return new Function('A2', 'self', 'require', `
    var w9="\\x1B";
    var M1=(e,t,i)=>{if(t.has(e))throw TypeError("twice");t.set(e,i)};
    var n1=(e,t)=>{if(!t.has(e))throw TypeError("read");return t.get(e)};
    var y1=(e,t,i)=>{if(!t.has(e))throw TypeError("write");t.set(e,i);return i};
    ${p0}
    ${gc}
    return Gc;`)({ CURRENT: platform }, { activeWindow: null }, require);
}

/** The real xterm.js clipboard module (paste() clears the helper textarea) and composition helper. */
function xtermModules() {
  const clip = {};
  new Function(`return (${cut(PATCHED, '(c,s)=>{function n(p){return p.replace(', 's.rightClickHandler=function(p,g,v,d,u){l(p,g,v),u&&d.rightClickSelect(p),g.value=d.selectionText,g.select()}}')})`)()({}, clip);
  const comp = {};
  const ids = { IBufferService: () => {}, IOptionsService: () => {}, ICoreService: () => {}, IRenderService: () => {} };
  const deps = (id) => (id === 3534 ? { C0: { DEL: '\x7F' } } : ids);
  const start = PATCHED.indexOf('3618:function(c,s,n){') + '3618:'.length;
  const text = cut(PATCHED, 'function(c,s,n){var r=this&&this.__decorate', 'h(5,l.IRenderService)],v)}', start - 1);
  new Function('G', `return (${text})`)(setTimeout).call(undefined, {}, comp, deps);
  return { paste: clip.paste, CompositionHelper: comp.CompositionHelper };
}
const XTERM = xtermModules();

/** The real onData and onKey callbacks of the developer console (its pipe() method), around a fake line buffer. */
function devConsole(term) {
  const onData = cut(PATCHED, 'async l=>{if(n){n=!1;return}await c.acquire(z5.syncLock', 'for(;p;)await this.syncBuffer(s,!1);await g})}');
  const keyStart = PATCHED.indexOf('i.onKey(({domEvent:l})=>{var v;if(!r3(kn(l)))return;') + 'i.onKey('.length;
  const onKey = PATCHED.slice(keyStart, PATCHED.indexOf('),i.onResize(', keyStart));
  const kn = cut(PATCHED, 'function kn(e){', 'e.shiftKey&&t.push("Shift"),T1(t)}');
  const x3 = cut(PATCHED, 'function x3(e){', 'e.stopPropagation()}');
  const state = { evaluated: [] };
  const line = { value: { string: '' }, write(d) { this.value.string += d; return Promise.resolve(); }, setValue(v) { this.value.string = v; return Promise.resolve(); } };
  const e5 = new WeakMap(), z9 = new WeakMap();
  const host = {
    syncBuffer: () => Promise.resolve(),
    eval() { state.evaluated.push(line.value.string); line.value.string = ''; return Promise.resolve(); },
  };
  e5.set(host, ['']);
  z9.set(host, 0);
  const make = new Function('a', 'c', 's', 'z5', 'n1', 'y1', 'e5', 'z9', 'r3', 'p0', `
    var T1=(e)=>e;
    ${kn}
    ${x3}
    return function(){let n=!1;return [${onData}, ${onKey}]};`);
  const [dataCb, keyCb] = make(line, { acquire: (_k, fn) => fn() }, [], { syncLock: 'sync' },
    (o, m) => m.get(o), (o, m, v) => (m.set(o, v), v), e5, z9, (list) => list.length === 0, () => ({ console })).call(host);
  term.onData.push(dataCb);
  term.onKey.push(keyCb);
  return { state, line };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((y, n) => { resolve = y; reject = n; });
  promise.catch(() => {}); // a test can reject a read that the handler never takes
  return { promise, resolve, reject };
}

/**
 * A fake xterm.js terminal. The core service records each send in `sent` (user input as is, other data as
 * `reply:<data>`) and calls the onData listeners. paste() is the real paste of xterm.js on a textarea.
 * `electron` is the list of texts that the synchronous clipboard gives, or null when it is not available.
 * `reads` is the list of results of navigator.clipboard.readText(): a string, an Error, or a deferred.
 */
function terminal({ selection = '', electron = ['clip text'], reads = [], failWrite = false, bracketed = true } = {}) {
  const fx = { sent: [], paste: [], written: [], reads: 0, errors: [] };
  const onData = [], onKey = [];
  const coreService = {
    decPrivateModes: { bracketedPasteMode: bracketed },
    triggerDataEvent(d, u = false) { fx.sent.push(u ? d : `reply:${d}`); for (const cb of onData) cb(d); },
  };
  const original = coreService.triggerDataEvent;
  const textarea = { value: '' };
  const clipboard = electron && {
    readText: () => { const next = electron.shift() ?? ''; if (next instanceof Error) throw next; return next; },
    writeText: (s) => { if (failWrite) throw new Error('denied'); fx.written.push(s); },
  };
  const queue = [...reads];
  const win = {
    navigator: {
      clipboard: {
        writeText: async (s) => { if (failWrite) throw new Error('denied'); fx.written.push(s); },
        readText: () => {
          fx.reads++;
          const next = queue.shift() ?? 'nav text';
          if (next instanceof Error) return Promise.reject(next);
          return typeof next === 'string' ? Promise.resolve(next) : next.promise;
        },
      },
    },
    console: { error: (e) => fx.errors.push(String(e)) },
  };
  const t = {
    element: { ownerDocument: { defaultView: win } },
    textarea,
    _core: { coreService },
    onData, onKey,
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    paste(s) { fx.paste.push(s); XTERM.paste(s, textarea, coreService, { rawOptions: {} }); },
    input(s, u = true) { coreService.triggerDataEvent(s, u); },
    attachCustomKeyEventHandler(fn) { this.handler = fn; },
  };
  return { t, fx, coreService, original, clipboard };
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

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 2)); };
const bracket = (s) => `${ESC}[200~${s}${ESC}[201~`;

/** Activate a handler of one bundle on a fake terminal. */
function setup(src, platform, opts = {}, passthrough = false) {
  const term = terminal(opts);
  const requires = [];
  const Gc = loadGc(src, platform, term.clipboard, requires);
  const g = new Gc(() => passthrough);
  g.activate(term.t);
  return { g, requires, ...term };
}

/**
 * Press one key as _keyDown of xterm.js does: the custom handler first; when it returns true, a keydown of
 * Enter, Ctrl+C, Ctrl+V, or a letter fires onKey, and then sends its data through the core service.
 */
function press(s, event) {
  const result = s.t.handler(event);
  if (result && event.type === 'keydown') {
    const data = event.keyCode === ENTER ? '\r'
      : event.ctrlKey && event.keyCode === C ? '\x03'
        : event.ctrlKey && event.keyCode === V ? '\x16'
          : !event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1 ? event.key : null;
    if (data) {
      for (const cb of s.t.onKey) cb({ key: data, domEvent: event });
      s.t._core.coreService.triggerDataEvent(data, true);
    }
  }
  return result;
}

async function run(src, platform, event, opts = {}, passthrough = false) {
  const s = setup(src, platform, opts, passthrough);
  const result = s.t.handler(event);
  await settle();
  return { result, event, fx: s.fx };
}

test('patch 007: the anchor is unique in the upstream bundle, and the released bundle holds the new handler', () => {
  assert.equal(UPSTREAM.split(ANCHOR).length, 2);
  assert.equal(PATCHED.split(ANCHOR).length, 1);
  assert.ok(PATCHED.includes('i=a=>n1(this,Er)?!0:q(a)?!1:a.key==="Enter"&&a.shiftKey?'));
});

for (const [name, code, mods] of [['Ctrl+Shift+C', C, 'cs'], ['Ctrl+Insert', INSERT, 'c'], ['Ctrl+Insert with Super held', INSERT, 'cm']]) {
  test(`patch 007 on linux: ${name} copies the selection at once and sends nothing`, () => {
    const s = setup(PATCHED, 'linux', { selection: 'hello world' });
    const ev = key(code, mods);
    assert.equal(s.t.handler(ev), false);
    assert.equal(ev.prevented, true);
    assert.equal(ev.stopped, true);
    assert.deepEqual(s.fx.written, ['hello world']);
    assert.deepEqual([s.fx.sent, s.fx.paste], [[], []]);
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
  test(`patch 007 on linux: ${name} pastes one time, inside its keydown, through paste() of xterm.js`, () => {
    const s = setup(PATCHED, 'linux', { electron: ['line 1\nline 2'] });
    const ev = key(code, mods);
    assert.equal(s.t.handler(ev), false);
    assert.equal(ev.prevented, true, 'the default paste of Chromium stops, so the text does not paste two times');
    assert.deepEqual(s.fx.paste, ['line 1\nline 2']);
    assert.deepEqual(s.fx.sent, [bracket('line 1\rline 2')], 'the paste is sent before the handler returns');
    assert.equal(s.fx.reads, 0, 'no asynchronous read');
  });
}

test('patch 007 on linux: two pastes go out in the order of their keys, with the keys between them', () => {
  const s = setup(PATCHED, 'linux', { electron: ['one', 'two'] });
  press(s, key(V, 'cs'));
  press(s, key(65));
  press(s, key(INSERT, 's'));
  press(s, key(ENTER));
  assert.deepEqual(s.fx.sent, [bracket('one'), 'a', bracket('two'), '\r']);
});

test('patch 007 on linux: a read that fails pastes nothing, and the next keys go out at once', () => {
  const s = setup(PATCHED, 'linux', { electron: [new Error('read denied')] });
  const ev = key(V, 'cs');
  assert.equal(press(s, ev), false);
  press(s, key(ENTER));
  assert.equal(ev.prevented, true);
  assert.deepEqual(s.fx.sent, ['\r']);
  assert.deepEqual(s.fx.paste, []);
  assert.match(s.fx.errors[0], /read denied/);
});

test('patch 007 on linux: the core service is not wrapped, and nothing waits after a key', async () => {
  const s = setup(PATCHED, 'linux', { electron: ['x'] });
  press(s, key(V, 'cs'));
  const sent = [...s.fx.sent];
  await settle();
  assert.deepEqual(s.fx.sent, sent, 'no paste comes later');
  assert.equal(s.coreService.triggerDataEvent, s.original);
  assert.ok(!PATCHED.includes('S.triggerDataEvent=(d,u)=>'), 'the queue of 77e8524 is gone');
});

// Review finding 1 (round 2): an IME composition must keep its text when a paste comes near it.
test('patch 007 on linux: an IME composition after two pastes keeps its text (real paste and composition helper)', async () => {
  const first = deferred(), second = deferred();
  const s = setup(PATCHED, 'linux', { electron: ['one', 'two'], reads: [first, second] });
  const view = { textContent: '', classList: { add() {}, remove() {} }, style: {}, getBoundingClientRect: () => ({ width: 1, height: 1 }) };
  const ime = new XTERM.CompositionHelper(s.t.textarea, view, { buffer: { isCursorInViewport: false } }, { rawOptions: {} }, s.coreService, {});
  press(s, key(V, 'cs'));
  press(s, key(INSERT, 's'));
  second.resolve('two');
  await settle();
  ime.compositionstart();
  s.t.textarea.value += 'あ';
  ime.compositionupdate({ data: 'あ' });
  await settle();
  first.reject(new Error('read denied'));
  await settle();
  ime.compositionend();
  await settle();
  assert.deepEqual(s.fx.sent, [bracket('one'), bracket('two'), 'あ']);
});

// Review finding 2 (round 2): the developer console must see each key action with its own data.
test('patch 007 on linux: in the developer console, Ctrl+Shift+V and then Enter evaluate the pasted text (real onKey and onData)', async () => {
  const read = deferred();
  const s = setup(PATCHED, 'linux', { electron: ['1+1'], reads: [read], bracketed: false });
  const dev = devConsole(s.t);
  press(s, key(V, 'cs'));
  const enter = key(ENTER);
  press(s, enter);
  read.resolve('1+1');
  await settle();
  assert.deepEqual(dev.state.evaluated, ['1+1']);
  assert.equal(dev.line.value.string, '', 'the Enter data is consumed by its own key action');
  assert.equal(enter.prevented, true, 'the console callback handled Enter');
});

test('patch 007 on linux: with no synchronous clipboard, a paste chord goes to the upstream paste path', async () => {
  for (const ev of [key(V, 'cs'), key(INSERT, 's'), key(INSERT, 'sm')]) {
    const s = setup(PATCHED, 'linux', { electron: null });
    assert.equal(s.t.handler(ev), true, 'xterm.js gets the key, and Chromium fires its synchronous paste event');
    await settle();
    assert.equal(ev.prevented, false);
    assert.deepEqual([s.fx.paste, s.fx.sent, s.fx.reads], [[], [], 0]);
    assert.deepEqual(s.requires, ['electron']);
  }
});

test('patch 007 on linux: with no synchronous clipboard, a copy chord uses navigator.clipboard', async () => {
  const { result, event, fx } = await run(PATCHED, 'linux', key(C, 'cs'), { electron: null, selection: 'sel' });
  assert.equal(result, false);
  assert.equal(event.prevented, true);
  assert.deepEqual(fx.written, ['sel']);
});

test('patch 007 on linux: a clipboard write failure goes to the console and does not throw', async () => {
  for (const electron of [['x'], null]) {
    const { result, fx } = await run(PATCHED, 'linux', key(INSERT, 'c'), { selection: 'x', failWrite: true, electron });
    assert.equal(result, false);
    assert.equal(fx.errors.length, 1);
    assert.match(fx.errors[0], /denied/);
  }
});

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

test('patch 007 on linux: after dispose, the chords go to xterm.js', async () => {
  const s = setup(PATCHED, 'linux', { selection: 'x' });
  s.g.dispose();
  const ev = key(C, 'cs');
  assert.equal(s.t.handler(ev), true);
  await settle();
  assert.equal(ev.prevented, false);
  assert.deepEqual(s.fx.written, []);
});

test('patch 007 on darwin: the handler does not look up the Electron clipboard', () => {
  const s = setup(PATCHED, 'darwin');
  assert.deepEqual(s.requires, []);
  assert.deepEqual(setup(PATCHED, 'linux').requires, ['electron']);
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

for (const electron of [true, false]) {
  test(`patch 007 on linux (${electron ? 'with' : 'without'} the Electron clipboard): every event that is not a handled chord gives the result of upstream`, async () => {
    const copy = (code, mods) => (code === INSERT && mods.includes('c') && !mods.includes('s')) || (code === C && mods.includes('c') && mods.includes('s') && !mods.includes('m'));
    const paste = (code, mods) => (code === INSERT && mods.includes('s') && !mods.includes('c')) || (code === V && mods.includes('c') && mods.includes('s') && !mods.includes('m'));
    const handled = (code, mods, type) => type !== 'keypress' && !mods.includes('a') && (copy(code, mods) || (electron && paste(code, mods)));
    let same = 0, changed = 0;
    for (const [code, mods, type] of matrix()) {
      const opts = { selection: 'sel', electron: electron ? ['x'] : null };
      const a = await run(PATCHED, 'linux', key(code, mods, type), opts);
      const b = await run(UPSTREAM, 'linux', key(code, mods, type), opts);
      if (handled(code, mods, type)) { assert.equal(a.result, false); changed++; } else { assert.equal(snapshot(a), snapshot(b), `keyCode ${code} mods "${mods}" ${type}`); same++; }
    }
    // Copy: Insert c, cm; C cs. Paste: Insert s, sm; V cs. Each as keydown and keyup.
    assert.equal(changed, 2 * (electron ? 6 : 3));
    assert.equal(same, 7 * 16 * 3 - changed);
  });
}
