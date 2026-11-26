'use strict';
// gas/*.gs を1つの vm コンテキストに順に読み込む(GAS と同様にトップレベルの宣言を共有する)。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAS_DIR = path.join(__dirname, '..', '..', 'gas');

function loadGas(files, globals) {
  const ctx = vm.createContext(Object.assign({ console }, globals || {}));
  files.forEach((f) => {
    const code = fs.readFileSync(path.join(GAS_DIR, f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  });
  return ctx;
}

module.exports = { loadGas, GAS_DIR };
