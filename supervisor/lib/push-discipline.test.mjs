import { describe, expect, it } from 'vitest';
import { classifyPushFailure, createGit, isRebaseConflict } from './git.mjs';
import { cycleMayFinish, handleTail, pushMain } from './push-discipline.mjs';

/**
 * Проверки дисциплины отправки.
 *
 * Настоящий git здесь не запускается ни разу: исполнитель команд подставной,
 * и каждая проверка задаёт ему заранее известные ответы. Так проверяются
 * ровно те ходы событий, которые в жизни случаются редко и стоят дорого:
 * чужой коммит опередил, сеть пропала, перевыкладка встала на конфликте,
 * в дереве чужая незавершённая правка.
 */

const OK = { code: 0, stdout: '', stderr: '' };
const FAIL = (stderr) => ({ code: 1, stdout: '', stderr });

/**
 * Подставной исполнитель: отвечает по первому подходящему образцу и помнит,
 * что у него спросили.
 */
function fakeRunner(rules) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    for (const [pattern, reply] of rules) {
      if (args.join(' ').includes(pattern)) {
        return typeof reply === 'function' ? reply(calls) : reply;
      }
    }
    return OK;
  };
  return { run, calls };
}

/**
 * Умолчания подставного исполнителя.
 *
 * Ссылок незавершённой операции по умолчанию нет: `--verify --quiet`
 * отвечает отказом, когда ссылки не существует. Без этого умолчания каждая
 * проверка думала бы, что в дереве идёт слияние.
 */
const DEFAULTS = [
  ['rev-parse --verify --quiet MERGE_HEAD', FAIL('')],
  ['rev-parse --verify --quiet REBASE_HEAD', FAIL('')],
];

const gitWith = (rules) => {
  const { run, calls } = fakeRunner([...rules, ...DEFAULTS]);
  return { git: createGit(run, { remote: 'origin', mainBranch: 'main' }), calls };
};

/** Часы, которые стоят: бюджет времени в проверках не мешает. */
const stopped = () => 0;

describe('разбор отказа отправки', () => {
  it('не ускоряющая отправка распознаётся', () => {
    expect(classifyPushFailure('! [rejected] main -> main (non-fast-forward)')).toBe('rejected');
    expect(classifyPushFailure('Updates were rejected because... fetch first')).toBe('rejected');
  });

  it('недоступная сеть распознаётся', () => {
    expect(classifyPushFailure('fatal: unable to access https://github.com/...')).toBe('offline');
    expect(classifyPushFailure('ssh: Could not resolve host github.com')).toBe('offline');
  });

  it('прочее не выдаётся за гонку', () => {
    expect(classifyPushFailure('error: failed to push some refs')).toBe('other');
  });

  it('конфликт перевыкладки распознаётся', () => {
    expect(isRebaseConflict('CONFLICT (content): Merge conflict in manage/questions.md')).toBe(
      true,
    );
    expect(isRebaseConflict('Successfully rebased')).toBe(false);
  });
});

describe('команды самообновления', () => {
  it('ветка дерева читается, а отсоединённая голова — тоже ответ', () => {
    const { git } = gitWith([['rev-parse --abbrev-ref HEAD', { code: 0, stdout: 'main\n' }]]);
    expect(git.currentBranch()).toBe('main');
    const { git: lost } = gitWith([['rev-parse --abbrev-ref HEAD', FAIL('fatal')]]);
    expect(lost.currentBranch()).toBeNull();
  });

  it('отставание по путям спрашивается с разделителем путей', () => {
    // Без `--` git счёл бы `supervisor` именем ревизии.
    const { git, calls } = gitWith([
      ['rev-list --count main..origin/main -- supervisor', { code: 0, stdout: '3\n' }],
    ]);
    expect(git.aheadOn(['supervisor'])).toBe(3);
    expect(calls).toContain('rev-list --count main..origin/main -- supervisor');
  });

  it('хеш дерева каталога берётся из названной ревизии', () => {
    const { git, calls } = gitWith([
      ['rev-parse HEAD:supervisor', { code: 0, stdout: 'abc123\n' }],
    ]);
    expect(git.treeOf('supervisor')).toBe('abc123');
    expect(calls).toContain('rev-parse HEAD:supervisor');
    const { git: none } = gitWith([['rev-parse HEAD:supervisor', FAIL('fatal')]]);
    expect(none.treeOf('supervisor')).toBeNull();
  });
});

describe('отправка с первого раза', () => {
  it('удачная отправка не трогает ни дерева, ни истории', () => {
    const { git, calls } = gitWith([]);
    const result = pushMain({ git, elapsed: stopped, branch: 'main' });
    expect(result.outcome).toBe('pushed');
    expect(result.attempts).toBe(1);
    expect(calls.join()).not.toContain('rebase');
  });
});

describe('кто-то успел раньше', () => {
  it('перевыкладываемся и отправляем снова', () => {
    let pushes = 0;
    const { git, calls } = gitWith([
      [
        'push origin main',
        () => {
          pushes += 1;
          return pushes === 1 ? FAIL('! [rejected] main (non-fast-forward), fetch first') : OK;
        },
      ],
      ['status --porcelain', OK],
    ]);
    const result = pushMain({ git, elapsed: stopped, branch: 'main' });
    expect(result.outcome).toBe('pushed');
    expect(result.attempts).toBe(2);
    expect(calls.join()).toContain('rebase origin/main');
    expect(calls.join()).not.toContain('--force');
  });

  it('перевыкладка на конфликте отменяется целиком, цикл встаёт', () => {
    const { git, calls } = gitWith([
      ['push origin main', FAIL('! [rejected] non-fast-forward')],
      ['status --porcelain', OK],
      ['rebase origin/main', { code: 1, stdout: 'CONFLICT (content): questions.md', stderr: '' }],
    ]);
    const result = pushMain({ git, elapsed: stopped, branch: 'main' });
    expect(result.outcome).toBe('conflict');
    expect(calls.join()).toContain('rebase --abort');
  });

  it('грязное дерево останавливает цикл, ничего не пряча', () => {
    const { git, calls } = gitWith([
      ['push origin main', FAIL('! [rejected] non-fast-forward')],
      ['status --porcelain', { code: 0, stdout: ' M apps/client/src/main.ts', stderr: '' }],
    ]);
    const result = pushMain({ git, elapsed: stopped, branch: 'main' });
    expect(result.outcome).toBe('dirty');
    expect(result.notes.join()).toContain('apps/client/src/main.ts');
    expect(calls.join()).not.toContain('stash');
    expect(calls.join()).not.toContain('checkout --');
    expect(calls.join()).not.toContain('reset --hard');
    expect(calls.join()).not.toContain('rebase origin/main');
  });

  it('незавершённая операция останавливает цикл', () => {
    const { git } = gitWith([
      ['push origin main', FAIL('! [rejected] non-fast-forward')],
      ['rev-parse --verify --quiet MERGE_HEAD', OK],
    ]);
    expect(pushMain({ git, elapsed: stopped, branch: 'main' }).outcome).toBe('busy');
  });

  it('повторы не бесконечны', () => {
    const { git } = gitWith([
      ['push origin main', FAIL('! [rejected] non-fast-forward')],
      ['status --porcelain', OK],
    ]);
    const result = pushMain({ git, elapsed: stopped, branch: 'main', maxRetries: 2 });
    expect(result.outcome).toBe('exhausted');
    expect(result.attempts).toBe(3);
  });

  it('бюджет времени останавливает раньше повторов', () => {
    const { git } = gitWith([['push origin main', FAIL('! [rejected] non-fast-forward')]]);
    const result = pushMain({ git, elapsed: () => 999, branch: 'main', budgetSeconds: 10 });
    expect(result.outcome).toBe('exhausted');
    expect(result.attempts).toBe(0);
  });
});

describe('сети нет', () => {
  it('отказ временный: не повторяем и не роняем задачи', () => {
    const { git, calls } = gitWith([
      ['push origin main', FAIL('fatal: unable to access https://github.com/Dezintegra/TD_Game')],
    ]);
    const result = pushMain({ git, elapsed: stopped, branch: 'main' });
    expect(result.outcome).toBe('offline');
    expect(result.attempts).toBe(1);
    expect(calls.join()).not.toContain('rebase');
  });
});

describe('хвост главной ветки', () => {
  const ours = ['Конвейер'];

  it('хвоста нет — делать нечего', () => {
    const { git } = gitWith([['rev-list --count', { code: 0, stdout: '0', stderr: '' }]]);
    expect(handleTail({ git, branch: 'main', ourAuthors: ours, elapsed: stopped }).outcome).toBe(
      'clean',
    );
  });

  it('свой хвост досылается', () => {
    const { git } = gitWith([
      ['rev-list --count', { code: 0, stdout: '2', stderr: '' }],
      ['log --format=%an', { code: 0, stdout: 'Конвейер\nКонвейер', stderr: '' }],
    ]);
    expect(handleTail({ git, branch: 'main', ourAuthors: ours, elapsed: stopped }).outcome).toBe(
      'pushed',
    );
  });

  it('чужой хвост не отправляется и называется вслух', () => {
    const { git, calls } = gitWith([
      ['rev-list --count', { code: 0, stdout: '1', stderr: '' }],
      ['log --format=%an', { code: 0, stdout: 'Ivanov Dm', stderr: '' }],
    ]);
    const result = handleTail({ git, branch: 'main', ourAuthors: ours, elapsed: stopped });
    expect(result.outcome).toBe('foreign');
    expect(result.notes.join()).toContain('Ivanov Dm');
    expect(calls.join()).not.toContain('push origin main');
  });
});

describe('сторож завершения цикла', () => {
  it('без хвоста цикл вправе закончиться', () => {
    const { git } = gitWith([['rev-list --count', { code: 0, stdout: '0', stderr: '' }]]);
    expect(cycleMayFinish(git, 'main').ok).toBe(true);
  });

  it('с хвостом — не вправе', () => {
    const { git } = gitWith([['rev-list --count', { code: 0, stdout: '3', stderr: '' }]]);
    const verdict = cycleMayFinish(git, 'main');
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain('3');
  });

  it('отставание завершению не мешает', () => {
    // Отставание считается другой командой; хвост при этом пуст.
    const { git } = gitWith([['rev-list --count', { code: 0, stdout: '0', stderr: '' }]]);
    expect(cycleMayFinish(git, 'main').ok).toBe(true);
  });
});
