'use strict';
// GAS API のインメモリモック(テスト専用)。Shift.gs が使う範囲だけを実装する。
const crypto = require('crypto');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createGasMock(options) {
  options = options || {};
  const sheets = {};
  const props = {};
  const cache = {};
  const state = { lockCalls: 0, templates: [] };

  function makeSheet(name) {
    const sh = { name, rows: [], formats: [] };
    const api = {
      getName: () => name,
      getDataRange: () => ({
        getValues: () => (sh.rows.length ? sh.rows.map((r) => r.slice()) : [['']]),
      }),
      getLastRow: () => sh.rows.length,
      getLastColumn: () => sh.rows.reduce((m, r) => Math.max(m, r.length), 0),
      getRange: (row, col, nr, nc) => ({
        setValues: (vals) => {
          vals.forEach((vr, i) => {
            const r = row - 1 + i;
            while (sh.rows.length <= r) sh.rows.push([]);
            vr.forEach((v, j) => {
              const stored = (options.dateCells && typeof v === 'string' && DATE_RE.test(v))
                ? new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10)))
                : v;
              sh.rows[r][col - 1 + j] = stored;
            });
          });
          return api;
        },
        getValues: () => {
          const out = [];
          for (let i = 0; i < (nr || 1); i++) {
            const r = sh.rows[row - 1 + i] || [];
            const line = [];
            for (let j = 0; j < (nc || 1); j++) line.push(r[col - 1 + j] === undefined ? '' : r[col - 1 + j]);
            out.push(line);
          }
          return out;
        },
        setNumberFormat: (fmt) => { sh.formats.push({ col, fmt }); return api; },
      }),
      appendRow: (r) => { sh.rows.push(r.slice()); return api; },
      clearContents: () => { sh.rows = []; return api; },
      setFrozenRows: () => api,
    };
    sh.api = api;
    return sh;
  }

  const ss = {
    getSheetByName: (name) => (sheets[name] ? sheets[name].api : null),
    insertSheet: (name) => { sheets[name] = makeSheet(name); return sheets[name].api; },
  };

  function chainable(rec) {
    const o = {
      evaluate: () => o, setTitle: (t) => { rec.title = t; return o; },
      addMetaTag: () => o, setXFrameOptionsMode: () => o,
    };
    return o;
  }

  const globals = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = String(v); },
        remove: (k) => { delete cache[k]; },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => { state.lockCalls++; },
        tryLock: () => { state.lockCalls++; return true; },
        releaseLock: () => {},
      }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        const p = (n) => (n < 10 ? '0' + n : '' + n);
        if (fmt !== 'yyyy-MM-dd') throw new Error('mock formatDate: unsupported ' + fmt);
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      },
    },
    Logger: { log: () => {} },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.example/exec' }) },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile: (name) => {
        const rec = { name, vars: {} };
        state.templates.push(rec);
        const t = new Proxy({}, {
          set: (_, k, v) => { rec.vars[k] = v; return true; },
          get: (_, k) => (k === 'evaluate' ? () => chainable(rec) : rec.vars[k]),
        });
        return t;
      },
    },
  };

  return {
    globals,
    sheets: (name) => (sheets[name] ? sheets[name].rows : null),
    sheetFormats: (name) => (sheets[name] ? sheets[name].formats : null),
    props,
    get lockCalls() { return state.lockCalls; },
    templates: state.templates,
    loginToken: (token) => { cache['admin_' + token] = '1'; },
  };
}

module.exports = { createGasMock };
