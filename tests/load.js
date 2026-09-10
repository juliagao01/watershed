/* Test loader: evaluates src files in a shared vm context with globalThis.WS. Usage: const {WS} = require('./load').load(['src/sim/state.js', ...]) — constants+rng are always loaded first. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
function load(files, extraGlobals) {
  const ctx = vm.createContext(Object.assign({ console, Math, Date, JSON, Float32Array, Int32Array, Int16Array, Uint8Array, Uint16Array, Uint32Array, Float64Array, Array, Object, Number, String, Boolean, Error, Set, Map, isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout, Promise }, extraGlobals || {}));
  ctx.globalThis = ctx;
  const all = ['src/core/constants.js', 'src/core/rng.js'].concat(files.filter(f => !/core\/(constants|rng)\.js$/.test(f)));
  for (const f of all) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return { WS: ctx.WS, ctx };
}
function assert(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); } console.log('PASS: ' + msg); }
function noNaN(obj, label, seen) {
  seen = seen || new Set(); if (obj == null || typeof obj !== 'object' || seen.has(obj)) return; seen.add(obj);
  if (ArrayBuffer.isView(obj)) { for (let i = 0; i < obj.length; i++) if (!isFinite(obj[i])) throw new Error('NaN/Inf in ' + label + '[' + i + ']'); return; }
  for (const k of Object.keys(obj)) { const v = obj[k]; if (typeof v === 'number') { if (!isFinite(v)) throw new Error('NaN/Inf at ' + label + '.' + k); } else if (typeof v === 'object') noNaN(v, label + '.' + k, seen); }
}
module.exports = { load, assert, noNaN, ROOT };
