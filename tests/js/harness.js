'use strict';
// Shared test harness for the classic-script dashboard in static/js.
//
// Every test gets a fresh jsdom window built from static/index.html. The
// dashboard scripts are compiled with vm.Script using their real file:// URL
// as the filename, so V8 coverage (node --experimental-test-coverage)
// attributes the hits to static/js/*.js. Scripts share one global lexical
// scope, exactly as classic <script> tags do in the browser.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { afterEach } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATIC_DIR = path.join(REPO_ROOT, 'static');
const JS_DIR = path.join(STATIC_DIR, 'js');

// Same order as the <script> tags in static/index.html.
const SCRIPT_ORDER = Array.from(
  fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8').matchAll(/<script src="\/js\/([^"]+)"><\/script>/g),
  (m) => m[1]
);

const INDEX_HTML = fs
  .readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '');

const compiledScripts = new Map();
function compiledScript(name) {
  if (!compiledScripts.has(name)) {
    const file = path.join(JS_DIR, name);
    compiledScripts.set(
      name,
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: pathToFileURL(file).href })
    );
  }
  return compiledScripts.get(name);
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

// Deterministic replacement for setTimeout/setInterval/Date.now.
function installFakeClock(window, startAt) {
  const clock = { now: startAt, nextId: 1, timers: new Map() };

  window.Date.now = () => clock.now;
  window.setTimeout = (fn, ms = 0) => {
    const id = clock.nextId++;
    clock.timers.set(id, { fn, at: clock.now + ms, interval: null });
    return id;
  };
  window.setInterval = (fn, ms = 0) => {
    const id = clock.nextId++;
    clock.timers.set(id, { fn, at: clock.now + ms, interval: ms });
    return id;
  };
  window.clearTimeout = (id) => clock.timers.delete(id);
  window.clearInterval = (id) => clock.timers.delete(id);

  clock.pending = () => Array.from(clock.timers.values());
  clock.set = (ms) => { clock.now = ms; };
  // Advance virtual time, firing due timers in chronological order.
  clock.advance = (ms) => {
    const target = clock.now + ms;
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, t] of clock.timers) {
        if (t.at <= target && (!next || t.at < next.at)) { next = t; nextId = id; }
      }
      if (!next) break;
      clock.now = next.at;
      if (next.interval === null) clock.timers.delete(nextId);
      else next.at += next.interval || 1;
      next.fn();
    }
    clock.now = target;
  };
  return clock;
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    if (this.onclose) this.onclose();
  }
}

function makeFakeContext2d() {
  const calls = [];
  const state = {};
  const record = (name) => (...args) => {
    calls.push({ name, args, state: { ...state } });
  };
  const target = { calls };
  for (const name of ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'fillText', 'setTransform']) {
    target[name] = record(name);
  }
  return new Proxy(target, {
    get(obj, key) { return key in obj ? obj[key] : state[key]; },
    set(obj, key, value) { state[key] = value; return true; }
  });
}

const liveEnvs = [];
afterEach(() => {
  const errors = liveEnvs.flatMap((env) => env.errors);
  for (const env of liveEnvs.splice(0)) env.window.close();
  if (errors.length) {
    const details = errors.map((e) => (e.detail && e.detail.stack) || e.stack || String(e));
    throw new Error(`Uncaught error(s) inside jsdom:\n${details.join('\n')}`);
  }
});

/**
 * Build a fresh dashboard environment.
 *
 * options.scripts: script file names to load (default: all except start-dashboard.js)
 * options.fetch:   (url, init) => Response|Promise<Response>
 * options.url:     page URL (default http://localhost:8000/)
 * options.now:     initial virtual time
 * options.html:    override body HTML
 */
function createDashboard(options = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  // Exceptions thrown inside jsdom event listeners are reported here rather
  // than propagated; collect them so the afterEach hook can fail the test.
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(options.html !== undefined ? options.html : INDEX_HTML, {
    url: options.url || 'http://localhost:8000/',
    runScripts: 'outside-only',
    pretendToBeVisual: false,
    virtualConsole
  });
  const { window } = dom;
  const context = dom.getInternalVMContext();

  const clock = installFakeClock(window, options.now !== undefined ? options.now : 1_000_000);

  const logs = { error: [], log: [] };
  window.console.error = (...args) => logs.error.push(args);
  window.console.log = (...args) => logs.log.push(args);

  const fetchCalls = [];
  const env = {
    dom, window, document: window.document, context, clock, logs, fetchCalls, errors,
    fetchHandler: options.fetch || (() => jsonResponse({})),
    run(code) { return vm.runInContext(code, context); },
    get(name) { return vm.runInContext(name, context); },
    set(name, value) {
      window.__harnessValue = value;
      vm.runInContext(`${name} = window.__harnessValue`, context);
      delete window.__harnessValue;
    },
    load(name) { compiledScript(name).runInContext(context); },
    async flush(rounds = 10) {
      for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
    },
    callsTo(prefix) { return fetchCalls.filter((c) => c.url.startsWith(prefix)); }
  };

  window.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    return Promise.resolve().then(() => env.fetchHandler(url, init));
  };

  FakeWebSocket.instances = [];
  window.WebSocket = FakeWebSocket;
  env.sockets = FakeWebSocket.instances;

  env.ctx2d = makeFakeContext2d();
  window.HTMLCanvasElement.prototype.getContext = function () { return env.ctx2d; };

  liveEnvs.push(env);

  const scripts = options.scripts || SCRIPT_ORDER.filter((s) => s !== 'start-dashboard.js');
  for (const name of scripts) env.load(name);
  return env;
}

module.exports = { createDashboard, jsonResponse, SCRIPT_ORDER, REPO_ROOT, JS_DIR };

// Values created inside the jsdom realm have foreign prototypes; normalise
// them before deepStrictEqual.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Replace window.localStorage with something that throws on access.
function breakLocalStorage(window) {
  const broken = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); }
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => broken });
}

module.exports.plain = plain;
module.exports.breakLocalStorage = breakLocalStorage;
