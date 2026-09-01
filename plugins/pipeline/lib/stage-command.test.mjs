import { describe, expect, it } from 'vitest';
import { stageCommand, stageTimeoutMs } from './stage-command.mjs';
import { resolveConfig } from '../config/defaults.mjs';

/**
 * Проверки состава запуска этапа.
 *
 * Проверять здесь есть что именно потому, что живой запуск проверить дорого:
 * каждый стоит десяток секунд и денег. Состав доводов же решает всё — ошибка
 * в одном ключе означает либо сессию с чужими правилами, либо запуск,
 * ждущий человека, которого нет.
 */

const { config } = resolveConfig({
  worktreeDir: '.claude/worktrees',
  commands: { verify: 'v', deploy: 'd', perf: 'p' },
  trello: { board: 'b' },
});

const root = '/repo';
const flag = (args, name) => args[args.indexOf(name) + 1];

describe('этап с рабочим деревом', () => {
  const { program, args, cwd } = stageCommand({
    assignment: {
      taskId: '0042-fix',
      stage: 'implement',
      branch: 'worktree-0042-fix',
      path: '.claude/worktrees/0042-fix',
      sessionId: 'aaaa-bbbb',
    },
    prompt: 'делай',
    config,
    root,
  });

  it('зовётся по имени, а не полным путём: правила разрешений сверяются с приставкой', () => {
    expect(program).toBe('claude');
  });

  it('работает в своём дереве, а не в основном', () => {
    expect(cwd).toContain('0042-fix');
  });

  it('получает промпт назначения входом, а не аргументом', () => {
    // Аргументы командной строки на Windows ограничены примерно тридцатью
    // двумя тысячами знаков на всё, а промпт складывается из описания задачи,
    // журнала карточки, описи доски и правил отчёта — и растёт с каждым
    // переходом. Упёршись, порождение падает с `spawn ENAMETOOLONG`, и задача
    // не может уйти на следующий этап ни в этот оборот, ни в следующий:
    // 01.09.2026 так встали четыре задачи, двадцать шесть отказов за сутки.
    const { stdin } = stageCommand({
      assignment: { taskId: '0042-fix', stage: 'implement', path: '.claude/worktrees/0042-fix' },
      prompt: 'делай',
      config,
      root,
    });
    expect(stdin).toBe('делай');
    // Ключ остаётся без значения: `claude -p` без него читает промпт из stdin.
    expect(args).toContain('-p');
    expect(args).not.toContain('делай');
  });

  it('получает правила своего этапа файлом', () => {
    expect(flag(args, '--append-system-prompt-file')).toContain('implement.md');
  });

  it('отвечает структурой, а не текстом', () => {
    expect(flag(args, '--output-format')).toBe('json');
  });

  it('получает идентификатор сессии заранее — тогда возобновлять есть что', () => {
    expect(flag(args, '--session-id')).toBe('aaaa-bbbb');
  });

  it('не обходит проверку разрешений целиком', () => {
    expect(flag(args, '--permission-mode')).toBe('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('получает разрешения конвейера отдельным файлом', () => {
    expect(flag(args, '--settings')).toContain('stage-settings.json');
  });
});

describe('этап без дерева', () => {
  it('работает в основном дереве: ни арене, ни толкованию дерева не нужно', () => {
    const { cwd } = stageCommand({
      assignment: { taskId: '0007-run', stage: 'benchmark', sessionId: 'c' },
      prompt: 'мерь',
      config,
      root,
    });
    expect(cwd).toBe(root);
  });

  it('назначение без пути не роняет сборку запуска', () => {
    // `join(root, null)` бросал TypeError, и падение уносило весь оборот
    // цикла вместе с решениями по всем прочим задачам (31.08.2026).
    // Выдавать ли работу безместной задаче — решает исполнение; здесь
    // важно только не разрушить оборот на склейке пути.
    expect(() =>
      stageCommand({
        assignment: { taskId: '0042-fix', stage: 'implement', path: null },
        prompt: 'делай',
        config,
        root,
      }),
    ).not.toThrow();
  });
});

describe('продолжение', () => {
  it('возобновляет прежнюю сессию, а не начинает новую', () => {
    const { args } = stageCommand({
      assignment: {
        taskId: '0042-fix',
        stage: 'implement',
        path: '.claude/worktrees/0042-fix',
        sessionId: 'aaaa-bbbb',
        continuation: true,
      },
      prompt: 'продолжай',
      config,
      root,
    });
    expect(flag(args, '--resume')).toBe('aaaa-bbbb');
    expect(args).not.toContain('--session-id');
  });

  it('без известного идентификатора начинает заново, а не падает', () => {
    const { args } = stageCommand({
      assignment: { taskId: '0042-fix', stage: 'triage', continuation: true },
      prompt: 'продолжай',
      config,
      root,
    });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--session-id');
  });
});

describe('модель', () => {
  it('не называется, пока проект её не назвал: угаданная модель — чужой выбор цены', () => {
    const { args } = stageCommand({
      assignment: { taskId: '0001-x', stage: 'triage' },
      prompt: 'п',
      config,
      root,
    });
    expect(args).not.toContain('--model');
  });

  it('называется, когда названа', () => {
    const named = resolveConfig({ ...config, stageModel: 'opus' });
    const { args } = stageCommand({
      assignment: { taskId: '0001-x', stage: 'triage' },
      prompt: 'п',
      config: named.config,
      root,
    });
    expect(flag(args, '--model')).toBe('opus');
  });
});

describe('сроки этапов', () => {
  it('у выкладки и разбора разные: общего срока на все этапы не бывает', () => {
    expect(stageTimeoutMs('deploy', config)).toBeGreaterThan(stageTimeoutMs('triage', config));
  });

  it('у незнакомого этапа берётся запасной, а не бесконечность', () => {
    expect(stageTimeoutMs('невиданный', config)).toBe(config.stageTimeoutMinutes.default * 60000);
  });

  it('проект правит один срок, не теряя остальных', () => {
    const { config: mine } = resolveConfig({ stageTimeoutMinutes: { triage: 5 } });
    expect(stageTimeoutMs('triage', mine)).toBe(5 * 60000);
    expect(stageTimeoutMs('deploy', mine)).toBe(DEPLOY_DEFAULT);
  });
});

const DEPLOY_DEFAULT = 60 * 60000;
