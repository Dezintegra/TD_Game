import { describe, expect, it } from 'vitest';
import { applyReport } from './apply-report.mjs';
import { closureReasonFor, recoverClosureReason } from './closure.mjs';
import { joinDescription, metaOf, parseCard } from './card.mjs';
import { journalBody } from './journal.mjs';

describe('объяснение закрытия', () => {
  it.each([
    ['design', 'feature', 'moot'],
    ['triage', 'note', 'moot'],
    ['triage', 'note', 'done'],
    ['decompose', 'feature', 'split'],
  ])('%s/%s/%s требует содержательный summary', (stage, type, outcome) => {
    for (const summary of [undefined, '', '  ', 42]) {
      const result = applyReport(
        { status: stage, type },
        {
          stage,
          outcome,
          summary,
          evidence: 'PR 166 влит',
          requests: [{}, {}],
        },
      );
      expect(result.status).toBe('postmortem');
      expect(result.note).toContain('причина закрытия');
    }
  });

  it('причина с доказательством переживает запись и чтение карточки', () => {
    const closureReason = closureReasonFor({
      outcome: 'moot',
      summary: 'Проверка уже исправлена.',
      evidence: 'PR 166 влит.',
    });
    const metadata = metaOf({ id: '0031-proba', closureReason });
    const { task } = parseCard(
      {
        id: '6a9a30657ee6fbcc699138bc',
        name: '0031-proba · Проверка',
        desc: joinDescription('Текст владельца', metadata),
        idLabels: [],
        idList: 'cleanup',
      },
      { stateByList: new Map([['cleanup', 'cleanup']]), labelKeyById: new Map() },
    );
    expect(recoverClosureReason(task)).toBe(closureReason);
    const comment = journalBody({
      closureReason: recoverClosureReason(task),
      what: 'Убрано: дерева нет.',
    });
    expect(comment).toContain('**Причина закрытия**');
    expect(comment).toContain('Проверка уже исправлена.');
    expect(comment).toContain('PR 166 влит.');
  });

  it('старая уборка восстанавливает решение, но не использует технический итог', () => {
    const reason = 'Предмет снят: merge разрешён. Проверено: stage-settings.json:67.';
    expect(
      recoverClosureReason(
        {},
        `🤖 [agent] **design → cleanup**\n\n${reason}\n\n**Решения:**\n\n- убрать дерево`,
      ),
    ).toBe(reason);
    expect(recoverClosureReason({ history: [{ note: reason }] })).toBe(reason);
    expect(recoverClosureReason({}, 'Убрано: дерева нет.')).toBeNull();
  });
});
