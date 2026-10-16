// Formato de los mensajes de commit: Conventional Commits, en español.
//   tipo(ámbito): verbo en infinitivo y qué cambia
//   ej.  feat(reservas): crear reserva desde un hold
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'refactor',
        'test',
        'docs',
        'chore',
        'ci',
        'style',
        'perf',
        'build',
        'revert',
      ],
    ],
    // Los asuntos nombran cosas como CRUD, DTO o README: no se fuerza minúscula.
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
    // El cuerpo y el pie pueden llevar URL largas.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
