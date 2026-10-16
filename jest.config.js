// Pruebas: Jest + ts-jest contra servidores HTTP reales (upstreams falsos e identity falso).
// `jose` 6 solo se publica como ESM: test/utils/transformar-jose.js lo pasa a CommonJS.
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '/node_modules/jose/.+\\.js$': '<rootDir>/test/utils/transformar-jose.js',
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
  },
  transformIgnorePatterns: ['/node_modules/(?!jose/)'],
  testTimeout: 30000,
};
