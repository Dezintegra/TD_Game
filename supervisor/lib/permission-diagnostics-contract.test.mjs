import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const texts = {
  protocol: read('../permission-diagnostics.md'),
  implement: read('../skills/implement.md'),
  revise: read('../skills/revise.md'),
  proposal: read('../../openspec/changes/verify-lease-push-permissions/proposal.md'),
  design: read('../../openspec/changes/verify-lease-push-permissions/design.md'),
  tasks: read('../../openspec/changes/verify-lease-push-permissions/tasks.md'),
};

// Каждое правило проверяется также удалением охраняемой фразы из копии текста.
// Это сторож договора, не доказательство поведения внешнего CLI.
const rules = [
  [
    'protocol',
    'source inventory',
    /stage-settings \/ project \/ local \/ user \/ managed \/ CLI override/,
  ],
  ['protocol', 'unknown source', /Непроверенный источник не считать отсутствующим/],
  [
    'protocol',
    'private source protection',
    /Не публиковать содержимое или хеш личных\/managed настроек/,
  ],
  ['protocol', 'no raw stream', /Не сохранять сырой поток в коммит/],
  ['protocol', 'whitelist', /События отбирать белым списком/],
  ['protocol', 'safe canary', /git -C <проба> rev-parse --show-prefix/],
  ['protocol', 'safe companion', /git -C <проба> rev-parse --is-inside-work-tree/],
  ['protocol', 'preserve deny', /Исходные allow\/deny сохраняются/],
  ['protocol', 'exact additive rule', /без wildcard и хвоста `:\*`/],
  ['protocol', 'comparable snapshots', /Сопоставимость доказывается единственным добавлением deny/],
  ['protocol', 'event binding', /через tool_use_id/],
  ['protocol', 'no bypass', /Не повторять отклонённый вызов\s+через child_process/],
  ['protocol', 'native only', /Отсутствующий инструмент\s+не эмулируется/],
  ['protocol', 'three sessions', /три новые сессии по пять минут/],
  ['protocol', 'no unchanged repeat', /Не повторять неизменный\s+эксперимент/],
  ['protocol', 'resume keeps limit', /новая дата или session id не обнуляют лимит/],
  [
    'protocol',
    'loading fix only',
    /одна проверка только после доказанного исправления способа загрузки/,
  ],
  ['protocol', 'no force rewrite', /Третья сессия не разрешает менять force-deny/],
  ['protocol', 'applied target failed', /applied\s+\|\s+not-enforced\s+\|\s+false/],
  ['protocol', 'not applied is not verified', /not-applied\s+\|\s+unknown\s+\|\s+false/],
  ['protocol', 'unknown is not verified', /unknown\s+\|\s+unknown\s+\|\s+false/],
  ['protocol', 'classifier integration', /`classifyPermissionEvidence`/],
  [
    'protocol',
    'done needs acceptance',
    /Done требует фактической приёмки всех задач текущей карточки/,
  ],
  ['protocol', 'external prerequisite', /blocked при конкретной внешней предпосылке/],
  ['protocol', 'owner choice', /question только при выборе владельца/],
  ['protocol', 'technical stop', /failed при подтверждённой\s+невозможности завершения/],
  ['design', 'keep original PR', /сохранив код, probe-results и PR 227/],
  ['design', 'force before Git', /отказом политики до Git/],
  ['design', 'force cannot rewrite', /локальная и удалённая головы равны/],
  ['design', 'real lease update', /обновить локальный bare origin/],
  [
    'design',
    'stale lease',
    /lease должен дойти до Git и быть отклонён с сохранением удалённого SHA/,
  ],
  ['design', 'deny remains conditional', /Если именно deny перекрывает lease/],
  ['tasks', 'open original task', /- \[ \] 1\.1/],
  [
    'tasks',
    'classifier used by probe',
    /Одноразовый сценарий использует\s+`classifyPermissionEvidence`/,
  ],
  ['tasks', 'no unknown success', /unknown и not-applied не считаются исправностью/],
  [
    'tasks',
    'allowed plan paths',
    /Для предварительного технического уточнения разрешены собственные/,
  ],
  ['proposal', 'preserve non-goals', /## Non-goals/],
  ['proposal', 'no duplicate delta', /Общую норму диагностики и продолжения вводит отдельное/],
];
for (const skill of ['implement', 'revise']) {
  rules.push(
    [
      skill,
      'protocol link',
      /\[протоколу диагностики разрешений\]\(\.\.\/permission-diagnostics\.md\)/,
    ],
    [skill, 'bounded permission', /Допустимо уточнить способ получения недостающего/],
    [
      skill,
      'acceptance unchanged',
      /Требования, приёмка, безопасность и внешние предусловия неизменны/,
    ],
    [skill, 'plan before probes', /До новых опытов записать в собственные design\/tasks/],
    [
      skill,
      'plan trace',
      /отдельным коммитом и немедленно отправить\. Исходную проверку оставить открытой/,
    ],
    [skill, 'no false done', /уточнение само по себе не даёт done/],
    [skill, 'explicit prohibition', /Явный запрет плана нельзя отменить/],
    [skill, 'no foreign edits', /менять чужие артефакты без прямого назначения нельзя/],
    [skill, 'audit new requirements', /Изменение требований требует согласования и аудита/],
    [skill, 'preserve work', /Сохранить change\/PR/],
  );
}

describe('permission diagnostic contract', () => {
  it.each(rules)('%s: %s survives in the real text and detects removal', (file, _name, rule) => {
    expect(texts[file]).toMatch(rule);
    const damaged = texts[file].replace(new RegExp(rule.source, 'g'), '');
    expect(damaged).not.toBe(texts[file]);
    expect(damaged).not.toMatch(rule);
  });

  it('keeps the same technical clarification in both stages', () => {
    const block = (text) =>
      text.match(/- \*\*Технически неполный план\.\*\*[\s\S]*?Сохранить change\/PR\./)?.[0];
    expect(block(texts.implement)).toBeTruthy();
    expect(block(texts.implement)).toBe(block(texts.revise));
  });
});
