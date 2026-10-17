// Pruebas: Jest + ts-jest contra servidores HTTP reales (upstreams falsos e identity falso).
// `jose` 6 (solo ESM) y el `import()` dinámico del exportador OTLP pasan a CommonJS con
// test/utils/transformar-a-commonjs.js.
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '/node_modules/(jose|@opentelemetry/otlp-exporter-base)/.+\\.js$':
      '<rootDir>/test/utils/transformar-a-commonjs.js',
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(jose|@opentelemetry/otlp-exporter-base)/)'],
  testTimeout: 30000,
};
