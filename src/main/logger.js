'use strict';

const fs = require('fs');

function createLogger(isDebug, file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.truncateSync(file, 0);
  } catch {
    /* лог не критичен */
  }

  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };

  const write = (level, args) => {
    const line = `${new Date().toISOString()} [${level}] ${args.map(fmt).join(' ')}`;
    console.log(line);
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      /* ignore */
    }
  };

  return {
    info: (...a) => write('info', a),
    error: (...a) => write('error', a),
    // подробные логи (все команды pipe с ответами) пишутся только при включённой отладке
    debug: (...a) => {
      if (isDebug()) write('debug', a);
    },
  };
}

module.exports = { createLogger };
