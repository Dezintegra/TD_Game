import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Плоская конфигурация ESLint (flat config) для всего монорепозитория.
 *
 * Блоки идут сверху вниз, каждый следующий уточняет предыдущие.
 * Самое важное здесь — не стилистика, а два архитектурных барьера:
 * запрет недетерминированных API в ядре симуляции и запрет
 * "неправильных" направлений импорта между пакетами.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Барьер №1: детерминизм ядра симуляции.
  //
  // Всё, что возвращает разный результат при одинаковых входных данных,
  // рано или поздно разведёт состояние мира у клиента и у сервера.
  // Дешевле запретить это на уровне линта, чем ловить рассинхрон в бою.
  {
    files: ['packages/sim/**/*.ts'],
    ignores: ['packages/sim/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Ядро симуляции должно работать и в Node.js.' },
        { name: 'document', message: 'Ядро симуляции должно работать и в Node.js.' },
        { name: 'process', message: 'Ядро симуляции должно работать и в браузере.' },
        { name: 'performance', message: 'Время измеряется номером тика, а не часами.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Используйте seeded PRNG из состояния мира.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Время измеряется номером тика, а не настенными часами.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Date недетерминирован. Время измеряется номером тика.',
        },
      ],
    },
  },

  // Барьер №2: направление зависимостей.
  //
  // Граф пакетов односторонний: shared <- sim/protocol/ui <- client/server.
  // Библиотеки ничего не знают о приложениях, приложения не знают друг о друге.
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@td/client', '@td/server', '**/apps/**'],
              message: 'Библиотека не может зависеть от приложения.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@td/client', '**/apps/client/**', 'react', 'pixi.js'],
              message: 'Сервер не может зависеть от клиента и его рендер-стека.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/client/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@td/server', '**/apps/server/**', 'fastify', 'ws'],
              message: 'Клиент не может зависеть от сервера и его серверного стека.',
            },
          ],
        },
      ],
    },
  },

  // Prettier идёт последним и гасит все стилистические правила,
  // чтобы линт и форматтер не спорили друг с другом.
  prettier,
);
