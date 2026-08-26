import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { isPaused, readAnswers, readRegistry, readReports, readTasks } from './read-state.mjs';

/**
 * Проверки сбора картины мира.
 *
 * Проверяется главным образом стойкость: испорченный файл, чужое имя,
 * неполный отчёт, отсутствующий каталог. Беда в одной записи не должна
 * отменять остальных — иначе опечатка, сделанная в полночь, останавливала
 * бы очередь до утра.
 *
 * Каждый случай собирается во временном каталоге, своём на прогон: общий
 * каталог временных файлов один на все сессии, и соседняя запросто
 * перепишет файл с ходовым именем.
 */

const { config } = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.claude/worktrees',
});

const realSchema = fileURLToPath(new URL('../../../backlog/schema.json', import.meta.url));
const realExample = fileURLToPath(
  new URL('../../../backlog/examples/feature.json', import.meta.url),
);

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pipeline-state-'));
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.pipeline', 'reports'), { recursive: true });
  copyFileSync(realSchema, join(root, 'backlog', 'schema.json'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Положить задачу в бэклог под указанным именем файла.
 *
 * Образец берётся настоящий, из `backlog/examples/`: так проверка
 * не разойдётся с тем, что лежит в репозитории и что видит редактор.
 */
function putTask(name, over = {}) {
  const base = JSON.parse(readFileSync(realExample, 'utf8'));
  const task = { ...base, id: name, ...over };
  writeFileSync(join(root, 'backlog', 'tasks', `${name}.json`), JSON.stringify(task, null, 2));
  return task;
}

describe('чтение задач', () => {
  it('годная задача читается', () => {
    putTask('0001-one');
    const { tasks, invalid } = readTasks(root, config);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('0001-one');
    expect(invalid).toEqual([]);
  });

  it('пустой каталог не беда', () => {
    expect(readTasks(root, config)).toEqual({ tasks: [], invalid: [] });
  });

  it('испорченный файл откладывается с причиной, остальные читаются', () => {
    putTask('0001-one');
    writeFileSync(join(root, 'backlog', 'tasks', '0002-broken.json'), '{ это не JSON');
    const { tasks, invalid } = readTasks(root, config);
    expect(tasks).toHaveLength(1);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].problems.join()).toContain('не разобрался');
  });

  it('задача, не прошедшая схему, откладывается', () => {
    putTask('0001-one', { priority: -5 });
    const { tasks, invalid } = readTasks(root, config);
    expect(tasks).toEqual([]);
    expect(invalid[0].problems.join()).toContain('меньше 0');
  });

  it('имя файла обязано совпадать с полем id', () => {
    putTask('0001-one', { id: '0009-other' });
    const { invalid } = readTasks(root, config);
    expect(invalid[0].problems.join()).toContain('не совпадает');
  });
});

describe('чтение реестра', () => {
  it('нет файла — пустой реестр', () => {
    expect(readRegistry(root, config)).toEqual({ entries: [] });
  });

  it('испорченный реестр не роняет цикл', () => {
    writeFileSync(join(root, '.pipeline', 'registry.json'), 'не json');
    expect(readRegistry(root, config)).toEqual({ entries: [] });
  });

  it('годный реестр читается', () => {
    const registry = { entries: [{ taskId: '0001-one', branch: 'worktree-0001-one' }] };
    writeFileSync(join(root, '.pipeline', 'registry.json'), JSON.stringify(registry));
    expect(readRegistry(root, config).entries).toHaveLength(1);
  });
});

describe('чтение отчётов', () => {
  const putReport = (name, body) =>
    writeFileSync(join(root, '.pipeline', 'reports', `${name}.json`), JSON.stringify(body));

  it('полный отчёт читается', () => {
    putReport('0001-design', { taskId: '0001-one', stage: 'design', outcome: 'done' });
    const { reports, problems } = readReports(root, config);
    expect(reports).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it('неполный отчёт пропускается с причиной', () => {
    putReport('0002-bad', { taskId: '0002-two' });
    const { reports, problems } = readReports(root, config);
    expect(reports).toEqual([]);
    expect(problems.join()).toContain('неполон');
  });
});

describe('рубильник паузы и ответы', () => {
  it('паузы нет, пока нет файла', () => {
    expect(isPaused(root, config)).toBe(false);
    writeFileSync(join(root, '.pipeline', 'pause'), '');
    expect(isPaused(root, config)).toBe(true);
  });

  it('пустая пометка ответом не считается', () => {
    writeFileSync(
      join(root, 'backlog', 'questions.md'),
      '### 0001-one\n\nСуть вопроса.\n\n**Ответ:**\n',
    );
    expect(readAnswers(root, config)).toEqual({});
  });

  it('написанный ответ распознаётся', () => {
    writeFileSync(
      join(root, 'backlog', 'questions.md'),
      '### 0001-one\n\nСуть вопроса.\n\n**Ответ:** берём вариант А.\n',
    );
    expect(readAnswers(root, config)['0001-one']).toContain('вариант А');
  });

  it('ответ одной задаче не приписывается другой', () => {
    writeFileSync(
      join(root, 'backlog', 'questions.md'),
      '### 0001-one\n\nПервый.\n\n**Ответ:** да.\n\n### 0002-two\n\nВторой.\n\n**Ответ:**\n',
    );
    const answers = readAnswers(root, config);
    expect(answers['0001-one']).toBeTruthy();
    expect(answers['0002-two']).toBeUndefined();
  });
});
