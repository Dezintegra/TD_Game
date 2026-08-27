import { describe, expect, it } from 'vitest';
import { classifyClaim, createGit } from './git.mjs';

/**
 * Проверки захвата задачи.
 *
 * Захват — единственное место конвейера, где ошибка стоит двух рабочих
 * деревьев, двух веток и двух pull request по одной задаче. Поэтому
 * проверяется он подробнее прочего, и в первую очередь — на ответах,
 * которые выглядят успехом, но захватом не являются.
 */

/** Подставной исполнитель git: отвечает по первому доводу команды. */
function fakeGit(replies = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = args.join(' ');
    const reply = Object.entries(replies).find(([pattern]) => key.includes(pattern))?.[1];
    return { code: 0, stdout: '', stderr: '', ...(reply ?? {}) };
  };
  return { run, calls };
}

const git = (run) => createGit(run, { remote: 'origin', mainBranch: 'main' });
const when = { machine: 'станция-1', now: '2026-08-27T21:00:00.000Z' };

describe('толкование ответа на отправку', () => {
  it('созданный тег — это захват', () => {
    expect(classifyClaim({ code: 0, stderr: ' * [new tag] claim-0031 -> claim-0031' })).toBe(
      'ours',
    );
  });

  it('«already exists» — задачу заняли', () => {
    expect(classifyClaim({ code: 1, stderr: '! [rejected] claim-0031 (already exists)' })).toBe(
      'taken',
    );
  });

  it('«Everything up-to-date» захватом НЕ считается, хотя код нулевой', () => {
    // Ровно та ловушка, ради которой захват стал аннотированным тегом:
    // обе машины стоят на одном коммите, и git отвечает успехом обеим.
    expect(classifyClaim({ code: 0, stdout: 'Everything up-to-date' })).toBe('taken');
  });

  it('успех без создания ссылки честно назван невнятным', () => {
    expect(classifyClaim({ code: 0, stdout: '' })).toBe('unclear');
  });

  it('обрыв связи отделён от отказа: он лечится ожиданием', () => {
    expect(
      classifyClaim({ code: 1, stderr: 'fatal: unable to access ... Could not resolve host' }),
    ).toBe('offline');
  });

  it('прочий отказ — это отказ, а не занятость', () => {
    expect(classifyClaim({ code: 1, stderr: 'fatal: не хватило прав' })).toBe('failed');
  });
});

describe('захват', () => {
  it('ставит тег на вершину удалённой ветки, а не на местную', () => {
    const { run, calls } = fakeGit({
      'push origin refs/tags': { stderr: ' * [new tag] claim-0031' },
    });
    git(run).claim('0031-proba', when);

    const tagged = calls.find((args) => args[0] === 'tag' && args[1] === '-a');
    expect(tagged.at(-1)).toBe('origin/main');
  });

  it('называет в описании тега машину и время: по ним узнаётся свой захват', () => {
    const { run, calls } = fakeGit({
      'push origin refs/tags': { stderr: ' * [new tag] claim-0031' },
    });
    git(run).claim('0031-proba', when);

    const message = calls.find((args) => args[0] === 'tag' && args[1] === '-a')[4];
    expect(message).toContain('станция-1');
    expect(message).toContain('2026-08-27T21:00:00.000Z');
  });

  it('удаётся, когда тег создан', () => {
    const { run } = fakeGit({ 'push origin refs/tags': { stderr: ' * [new tag] claim-0031' } });
    expect(git(run).claim('0031-proba', when)).toMatchObject({ ok: true, outcome: 'ours' });
  });

  it('не удаётся, когда задачу заняли', () => {
    const { run } = fakeGit({
      'push origin refs/tags': { code: 1, stderr: '! [rejected] claim-0031 (already exists)' },
    });
    expect(git(run).claim('0031-proba', when)).toMatchObject({ ok: false, outcome: 'taken' });
  });

  it('снимает местный тег и при удаче, и при отказе', () => {
    const { run, calls } = fakeGit({
      'push origin refs/tags': { code: 1, stderr: '! [rejected] (already exists)' },
    });
    git(run).claim('0031-proba', when);

    const deletions = calls.filter((args) => args[0] === 'tag' && args[1] === '-d');
    // Один раз перед созданием — на случай хвоста прошлой попытки,
    // и один раз после: местный тег больше не нужен никому.
    expect(deletions).toHaveLength(2);
  });

  it('местный тег от прошлой попытки не мешает захвату', () => {
    const { run, calls } = fakeGit({
      'push origin refs/tags': { stderr: ' * [new tag] claim-0031' },
    });
    git(run).claim('0031-proba', when);

    const order = calls.map((args) => args.slice(0, 2).join(' '));
    expect(order.indexOf('tag -d')).toBeLessThan(order.indexOf('tag -a'));
  });
});

describe('отпускание захвата', () => {
  it('удаляет удалённый тег', () => {
    const { run, calls } = fakeGit();
    expect(git(run).releaseClaim('0031-proba').ok).toBe(true);
    expect(calls.at(-1)).toEqual(['push', 'origin', '--delete', 'refs/tags/claim-0031-proba']);
  });

  it('отсутствие тега бедой не считается: цель достигнута', () => {
    const { run } = fakeGit({
      '--delete': { code: 1, stderr: 'error: unable to delete: remote ref does not exist' },
    });
    expect(git(run).releaseClaim('0031-proba').ok).toBe(true);
  });
});

describe('перечень захваченных задач', () => {
  it('читается из удалённых тегов', () => {
    const { run } = fakeGit({
      'ls-remote': {
        stdout:
          'aaa\trefs/tags/claim-0031-proba\n' +
          'bbb\trefs/tags/claim-0031-proba^{}\n' +
          'ccc\trefs/tags/claim-0032-other\n',
      },
    });
    expect(git(run).claimedIds()).toEqual(['0031-proba', '0032-other']);
  });

  it('недоступность удалённого репозитория не выдаётся за пустой перечень', () => {
    // Пустой перечень означал бы «все задачи свободны» — и конвейер
    // захватил бы чужое.
    const { run } = fakeGit({ 'ls-remote': { code: 128, stderr: 'could not resolve host' } });
    expect(git(run).claimedIds()).toBeNull();
  });
});
