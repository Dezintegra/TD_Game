import { describe, expect, it } from 'vitest';
import { checkEnvironment } from './environment.mjs';
import { resolveConfig } from '../config/defaults.mjs';

/**
 * Проверки осмотра окружения.
 *
 * Запуск программ и проверка файлов приходят доводами, поэтому весь набор
 * идёт за миллисекунды и не запускает ничего. Иначе проверять пришлось бы
 * настоящими запусками, а их четыре, и каждый не бесплатен.
 */

const { config } = resolveConfig({
  worktreeDir: '.claude/worktrees',
  commands: { verify: 'v', deploy: 'd', perf: 'p' },
  trello: { board: 'b' },
  backlog: 'trello',
});

const home = '/repo/supervisor';
const root = '/repo';

/** Осмотр в мире, где всё на месте; отклонения задаются доводами. */
function look({ missing = [], noFiles = [], node = '22.4.0', env, files } = {}) {
  return checkEnvironment({
    home,
    root,
    config,
    nodeVersion: node,
    env: env ?? { TRELLO_KEY: 'кккккккккккк', TRELLO_TOKEN: 'ттттттттттттттт' },
    envFiles: files ?? ['/repo/supervisor/.env'],
    run: (program) =>
      missing.includes(program)
        ? { code: 1, stdout: '' }
        : { code: 0, stdout: `${program} version 1.2.3\n` },
    exists: (path) => !noFiles.some((part) => String(path).includes(part)),
  });
}

const named = (world, name) => world.rows.find(([key]) => key === name)?.[1];

describe('полное окружение', () => {
  it('не даёт ни одной жалобы', () => {
    const world = look();
    expect(world.problems).toEqual([]);
    expect(world.fatal).toBe(null);
  });

  it('называет версии программ, а не просто «есть»', () => {
    // Половина бед на чужой машине — это старая сборка приложения, и версия
    // отвечает на вопрос раньше, чем он задан.
    expect(named(look(), 'claude')).toContain('1.2.3');
    expect(named(look(), 'git')).toContain('1.2.3');
  });
});

describe('нехватка внешних программ', () => {
  it('нет gh — предупреждение, а не остановка: до проверок ещё дойти надо', () => {
    const world = look({ missing: ['gh'] });
    expect(world.fatal).toBe(null);
    expect(world.problems.join(' ')).toContain('gh');
    expect(named(world, 'gh')).toBe('НЕ НАЙДЕНА');
  });

  it('нет приложения — тоже предупреждение, но названное прямо', () => {
    const world = look({ missing: ['claude'] });
    expect(world.problems.join(' ')).toContain('ни шага');
  });
});

describe('свои файлы инструмента', () => {
  it('нет правил этапов — запуск останавливается', () => {
    // Приложение ключ на несуществующий файл не отвергает: этап пойдёт
    // работать без своих правил, и заметить это нечем.
    const world = look({ noFiles: ['skills'] });
    expect(world.fatal).toContain('правил этапов');
  });

  it('нет настройки разрешений — предупреждение с объяснением последствий', () => {
    const world = look({ noFiles: ['stage-settings'] });
    expect(world.fatal).toBe(null);
    expect(world.problems.join(' ')).toContain('отказом');
  });

  it('правила ищутся в каталоге инструмента, а не в корне проекта', () => {
    expect(named(look(), 'правила этапов')).toContain('supervisor');
  });
});

describe('доступ к доске', () => {
  it('пустой токен назван вслух, а не выясняется на первом обороте', () => {
    const world = look({ env: { TRELLO_KEY: 'ключ' } });
    expect(named(world, 'TRELLO_TOKEN')).toBe('НЕ ЗАДАН');
    expect(world.problems.join(' ')).toContain('TRELLO_TOKEN');
  });

  it('заданный токен не печатается целиком: вывод уезжает в чужие руки', () => {
    const secret = 'ATTAсекретныйтокендоски';
    const shown = named(look({ env: { TRELLO_KEY: 'к', TRELLO_TOKEN: secret } }), 'TRELLO_TOKEN');
    expect(shown).not.toContain(secret);
    expect(shown).toContain('ATTA');
    expect(shown).toContain(String(secret.length));
  });

  it('ненайденный .env назван: иначе «доска недоступна» значит четыре разные беды', () => {
    expect(named(look({ files: [] }), 'файлы .env')).toBe('не найдены');
  });

  it('файловому бэклогу доступ к доске не нужен', () => {
    expect(fileBacklog().problems).toEqual([]);
  });
});

/** Осмотр в проекте с файловым бэклогом; отклонения задаются доводами. */
function fileBacklog({ noFiles = [], config: given } = {}) {
  const { config: local } = resolveConfig({ ...config, ...given, backlog: 'files' });
  return checkEnvironment({
    home,
    root,
    config: local,
    env: {},
    envFiles: [],
    run: () => ({ code: 0, stdout: 'v1' }),
    exists: (path) => !noFiles.some((part) => String(path).includes(part)),
  });
}

describe('схема записи бэклога', () => {
  it('берётся из каталога инструмента, а не из проекта', () => {
    // Проба 01.09.2026: скопированный в чужой репозиторий инструмент падал
    // на первом обороте с голым ENOENT по пути `manage/schema.json`,
    // которого на чужой машине нет и быть не может.
    const shown = fileBacklog().rows.find(([key]) => key === 'схема записи')?.[1];
    expect(shown).toContain('supervisor');
    expect(shown).not.toContain('manage');
  });

  it('своя схема проекта побеждает и считается от корня', () => {
    const shown = fileBacklog({ config: { paths: { schema: 'manage/schema.json' } } }).rows.find(
      ([key]) => key === 'схема записи',
    )?.[1];
    expect(shown).toContain('manage');
  });

  it('её отсутствие останавливает запуск, а не роняет первый оборот', () => {
    expect(fileBacklog({ noFiles: ['task-schema'] }).fatal).toContain('схема записи');
  });

  it('бэклогу на доске она не нужна и не спрашивается', () => {
    const world = look({ noFiles: ['task-schema'] });
    expect(world.fatal).toBe(null);
    expect(world.rows.some(([key]) => key === 'схема записи')).toBe(false);
  });
});

describe('версия среды исполнения', () => {
  it('старая названа с требуемой: на ней стоит чтение .env', () => {
    const world = look({ node: '18.20.0' });
    expect(named(world, 'node')).toContain('СТАРА');
    expect(world.problems.join(' ')).toContain('20.12');
  });

  it('младшая версия тоже считается, а не только старшая', () => {
    expect(look({ node: '20.11.0' }).problems.join(' ')).toContain('20.12');
    expect(look({ node: '20.12.0' }).problems).toEqual([]);
  });
});
