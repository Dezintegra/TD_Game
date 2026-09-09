import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STAGE_COMMANDS, uncoveredForStage } from '../config/permissions.mjs';

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const review = read('supervisor/skills/review.md');
const spec = read(
  'openspec/changes/keep-ci-waiting-out-of-tasks/specs/dev-pipeline-worker/spec.md',
);
const proposal = read('openspec/changes/keep-ci-waiting-out-of-tasks/proposal.md');
const settings = JSON.parse(read('supervisor/config/stage-settings.json'));
const command = 'node supervisor/bin/review-ci.mjs --pr <pr> --head <sha>';
const actual = command.replace('<pr>', '1').replace('<sha>', 'a'.repeat(40));
const between = (text, start, end) => {
  const at = text.indexOf(start);
  if (at < 0) return '';
  const stop = text.indexOf(end, at + start.length);
  return text.slice(at, stop < 0 ? undefined : stop);
};

// Проверяем блоки правил: упоминание в другом разделе не заменяет обязанность.
function violations(
  text = review,
  delta = spec,
  permissions = settings.permissions,
  commands = STAGE_COMMANDS,
) {
  const errors = [];
  const need = (block, values, label) => {
    for (const value of values) if (!block.includes(value)) errors.push(`${label}: ${value}`);
  };
  const entry = between(text, '3. **', '\n4. **');
  const merge = between(text, '8. **', '\n9. **');
  const exception = between(text, '   **Открытый пункт', '   **По правилам проекта');
  const waiting = between(
    delta,
    '#### Scenario: Ревью встречает открытый пункт ожидания проверок',
    '\n#### Scenario:',
  );
  const work = between(
    delta,
    '#### Scenario: Ревью встречает открытый пункт содержательной работы',
    '\n#### Scenario:',
  );
  need(
    entry,
    [
      command,
      'git -C <дерево> rev-parse HEAD',
      'переходи к шагу 4',
      'Прежний успех супервизора не заменяет',
      'pending не отменяет подтверждённый success',
      '`failed`',
      '`rejected`',
      '`--watch` здесь не применяют',
    ],
    'вход',
  );
  need(
    merge,
    [
      command,
      'git -C <дерево> rev-parse HEAD',
      'тот же сохранённый SHA',
      'Изменился локальный',
      'HEAD — `rejected`',
      'прежний ответ не годится',
      'gh pr merge <pr> --merge --match-head-commit <sha>',
      'Watch запрещён',
    ],
    'вливание',
  );
  if (merge.indexOf(command) < 0 || merge.indexOf(command) > merge.indexOf('gh pr ready <pr>'))
    errors.push('повторное подтверждение должно предшествовать ready');
  need(
    exception,
    [
      'недоделкой не считается',
      'Ожидание проверок ведёт супервизор',
      'review заново подтверждает CI общим способом для проверяемого SHA',
      'перед рассмотрением diff и непосредственно перед вливанием',
      'success запрещает допуск, ожидание через watch запрещено',
      'Всякий иной открытый пункт работы проверяемой\n   карточки остаётся замечанием',
    ],
    'исключение',
  );
  need(
    waiting,
    [
      'написанный до введения запрета',
      'неотмеченный пункт ожидания зелёного CI',
      'ожидание проверок и переход из `pr` ведёт супервизор',
      'исполнитель review заново подтверждает CI общим способом для проверяемого SHA',
      'перед рассмотрением diff и непосредственно перед вливанием',
      'Прежний успех супервизора не заменяет эти вызовы',
      'отсутствие свежего success запрещает допуск, ожидание через watch запрещено',
    ],
    'сценарий',
  );
  need(
    work,
    [
      'не в ожидании проверок, а в работе проверяемой карточки',
      'исключение на него не распространяется',
      'замечанием',
    ],
    'содержательная работа',
  );
  if (!(commands.review ?? []).includes(actual))
    errors.push('команда отсутствует в перечне review');
  errors.push(...uncoveredForStage(permissions, 'review', commands));
  return errors;
}

describe('контракт инструкции review и источника CI', () => {
  it('покрывает настоящую форму и сохраняет узость исключения соседней дельты', () => {
    expect(violations()).toEqual([]);
    expect(proposal).toContain(
      'ожидание проверок ведёт супервизор, а review заново подтверждает CI общим способом для проверяемого SHA перед рассмотрением diff и перед вливанием',
    );
  });
  it.each([
    [
      'старый источник',
      (text) =>
        text.replace(
          /- \*\*THEN\*\* замечания об этом пункте[^\n]+/,
          '- **THEN** зелень проверок ревью берёт от супервизора',
        ),
    ],
    [
      'нет свежего подтверждения',
      (text) =>
        text.replace('исполнитель review заново подтверждает CI', 'исполнитель review помнит CI'),
    ],
    [
      'watch разрешён',
      (text) => text.replace('ожидание через watch запрещено', 'ожидание через watch разрешено'),
    ],
    [
      'содержательная работа прощается',
      (text) =>
        text.replace(
          'исключение на него не распространяется',
          'исключение на него распространяется',
        ),
    ],
  ])('обнаруживает порчу соседнего сценария: %s', (_name, mutate) => {
    expect(mutate(spec)).not.toBe(spec);
    expect(violations(review, mutate(spec)).length).toBeGreaterThan(0);
  });
  it.each([
    ['свежий вызов', (text) => text.replace(command, '')],
    [
      'watch',
      (text) =>
        text.replace(
          'success запрещает допуск, ожидание через watch запрещено',
          'success разрешает допуск, ожидание через watch разрешено',
        ),
    ],
    [
      'узость',
      (text) => text.replace('карточки остаётся замечанием', 'карточки не считается замечанием'),
    ],
  ])('обнаруживает порчу инструкции: %s', (_name, mutate) => {
    expect(mutate(review)).not.toBe(review);
    expect(violations(mutate(review)).length).toBeGreaterThan(0);
  });
});
