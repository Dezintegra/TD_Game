import { describe, expect, it } from 'vitest';
import { describeDenial, judgeDenials } from './denials.mjs';

/**
 * Проверки суда над отказами.
 *
 * Улики подставные, и в этом весь смысл: таблица следов проверяется без
 * единого настоящего репозитория, коммита и запуска. Живой прогон этапа
 * стоит доллары и минуты — проверять на нём девять случаев значило бы
 * не проверять их вовсе.
 */

/** След на месте: ветка у origin, хвоста нет, коммит свежее начала этапа. */
const clean = {
  branchOnRemote: true,
  unpushed: 0,
  lastCommitAt: '2026-09-01T12:30:00+03:00',
  stageStartedAt: '2026-09-01T12:00:00+03:00',
  previousRun: null,
};

const denial = (over = {}) => ({
  tool_name: 'PowerShell',
  tool_input: { command: 'Remove-Item -Recurse .matchlog/run-42' },
  ...over,
});

const report = (over = {}) => ({
  taskId: '0001-one',
  stage: 'design',
  outcome: 'done',
  links: {},
  ...over,
});

const judge = (over = {}) =>
  judgeDenials({
    denials: [denial()],
    report: report(),
    stage: 'design',
    evidence: clean,
    ...over,
  });

describe('отказов не было', () => {
  it('пустой перечень — попутный вердикт без разбирательства', () => {
    // Обычный случай. Ни улик, ни таблицы следов он не касается вовсе.
    expect(judge({ denials: [] })).toEqual({ verdict: 'passing', why: null });
  });
});

describe('обращение к человеку', () => {
  // Такой отказ подменяет не действие, а решение: сессия продолжит работу,
  // приняв за человека решение, которого тот не принимал. Следом это
  // не проверяется никак — работа-то будет сделана.
  const asking = denial({ tool_name: 'AskUserQuestion', tool_input: { question: 'какой цвет?' } });

  it('подрывает отчёт при целом следе', () => {
    const verdict = judge({ denials: [asking] });
    expect(verdict.verdict).toBe('undermining');
    expect(verdict.why).toContain('AskUserQuestion');
  });

  it('подрывает отчёт и при исходе, ничего не объявлявшем сделанным', () => {
    const verdict = judge({ denials: [asking], report: report({ outcome: 'failed' }) });
    expect(verdict.verdict).toBe('undermining');
  });

  it('подрывает отчёт даже там, где следа не бывает вовсе', () => {
    const verdict = judge({ denials: [asking], stage: 'interpret' });
    expect(verdict.verdict).toBe('undermining');
  });
});

describe('этап ничего не объявлял сделанным', () => {
  // Вопрос и замечания годны сами по себе, а `failed` и так ведёт в разбор,
  // где отказ становится уликой. Сверка с делом нужна только исходу `done`.
  for (const outcome of ['question', 'rejected', 'failed']) {
    it(`исход ${outcome} принимается при непустом перечне`, () => {
      const verdict = judge({ report: report({ outcome }), evidence: { branchOnRemote: false } });
      expect(verdict.verdict).toBe('passing');
    });
  }
});

describe('след коммитящих этапов', () => {
  it('проработка без ветки у origin — подрывающий отказ', () => {
    const verdict = judge({ evidence: { ...clean, branchOnRemote: false } });
    expect(verdict.verdict).toBe('undermining');
    expect(verdict.why).toContain('ветки задачи нет');
    // Причина называет и сам отказ: по нему видно, какое правило разрешений
    // не дописано.
    expect(verdict.why).toContain('Remove-Item');
  });

  it('имплементация с хвостом — подрывающий отказ', () => {
    const verdict = judgeDenials({
      denials: [denial()],
      report: report({ stage: 'implement' }),
      stage: 'implement',
      evidence: { ...clean, unpushed: 2 },
    });
    expect(verdict.verdict).toBe('undermining');
    expect(verdict.why).toContain('2 коммит');
  });

  it('коммит старше начала этапа следом не считается', () => {
    const verdict = judge({ evidence: { ...clean, lastCommitAt: '2026-09-01T11:00:00+03:00' } });
    expect(verdict.verdict).toBe('undermining');
  });

  it('свежий коммит при целой ветке — отказ попутный', () => {
    expect(judge().verdict).toBe('passing');
  });
});

describe('след проверяющих этапов', () => {
  it('аудит без свежего коммита, но и без хвоста, принимается', () => {
    // Аудит выносит вердикт чтением и коммитить не обязан. Требовать
    // от него коммита значило бы отправлять в разбор всякий чистый аудит.
    const verdict = judgeDenials({
      denials: [denial()],
      report: report({ stage: 'audit' }),
      stage: 'audit',
      evidence: { branchOnRemote: true, unpushed: 0, lastCommitAt: null, stageStartedAt: null },
    });
    expect(verdict.verdict).toBe('passing');
  });
});

describe('след прогона', () => {
  const benchmark = (links, previousRun) =>
    judgeDenials({
      denials: [denial()],
      report: report({ stage: 'benchmark', links }),
      stage: 'benchmark',
      evidence: { ...clean, previousRun },
    });

  it('тот же номер прогона следом не считается', () => {
    const verdict = benchmark({ run: '33428427058' }, '33428427058');
    expect(verdict.verdict).toBe('undermining');
    expect(verdict.why).toContain('тот же');
  });

  it('номера прогона нет вовсе — тоже подрывающий', () => {
    expect(benchmark({}, null).verdict).toBe('undermining');
  });

  it('новый номер — отказ попутный', () => {
    expect(benchmark({ run: '33483000169' }, '33428427058').verdict).toBe('passing');
  });
});

describe('сверять нечем', () => {
  it('толкованию и выкладке следа не положено', () => {
    for (const stage of ['interpret', 'deploy']) {
      const verdict = judge({ stage });
      expect(verdict.verdict).toBe('unverifiable');
      expect(verdict.why).toContain('нечем');
    }
  });

  it('незнакомый этап судить не берёмся', () => {
    expect(judge({ stage: 'нечто' }).verdict).toBe('unverifiable');
  });

  it('неотвечающий git даёт «нечем», а не отсутствие следа', () => {
    // Молчаливая поломка прибора не должна стоить работы этапа: это ровно
    // та беда, которую чинит само изменение.
    expect(judge({ evidence: { ...clean, branchOnRemote: null } }).verdict).toBe('unverifiable');
    expect(judge({ evidence: { ...clean, unpushed: null } }).verdict).toBe('unverifiable');
    expect(judge({ evidence: { ...clean, lastCommitAt: null } }).verdict).toBe('unverifiable');
  });

  it('отметки начала этапа нет — сверять не с чем', () => {
    // Так выглядит первый запуск после обновления: файл прежней раскладки
    // отметки не хранил вовсе.
    expect(judge({ evidence: { ...clean, stageStartedAt: null } }).verdict).toBe('unverifiable');
  });
});

describe('запись отказа строкой', () => {
  it('команда печатается как есть, а не объектом', () => {
    expect(describeDenial(denial())).toBe('PowerShell: Remove-Item -Recurse .matchlog/run-42');
  });

  it('прочие доводы печатаются целиком', () => {
    // Именно доводы показывают, какое правило разрешений не дописано.
    const glob = { tool_name: 'Glob', tool_input: { pattern: '~/Downloads/*.mp3' } };
    expect(describeDenial(glob)).toBe('Glob: {"pattern":"~/Downloads/*.mp3"}');
  });
});
