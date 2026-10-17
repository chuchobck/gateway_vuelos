// Transformador de Jest para dos paquetes que la VM de Jest no carga tal cual, con el compilador de
// TypeScript (módulo CommonJS):
// - `jose`, que desde la versión 6 solo se publica como ESM: lo pasa a CommonJS.
// - `@opentelemetry/otlp-exporter-base`, CommonJS pero con `import('http')` dinámico, que dentro de
//   la VM de Jest falla sin --experimental-vm-modules (en producción funciona): queda en `require`. Con target es2022 las clases quedan nativas; con
// es2021 TypeScript mueve los campos de clase antes del super() de sus errores (que va dentro de
// una expresión con comas) y `new JOSEError()` falla. ts-jest no sirve aquí: Jest guarda un solo
// transformador por ruta, así que no admite otra configuración de ts-jest solo para esto.
'use strict';

const { createHash } = require('node:crypto');
const ts = require('typescript');

const OPCIONES = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  allowJs: true,
  sourceMap: true,
};

module.exports = {
  process(codigo, archivo) {
    const salida = ts.transpileModule(codigo, { fileName: archivo, compilerOptions: OPCIONES });
    return { code: salida.outputText, map: salida.sourceMapText };
  },
  getCacheKey(codigo, archivo) {
    return createHash('sha256')
      .update(`${ts.version}\0es2022\0${archivo}\0${codigo}`)
      .digest('hex');
  },
};
