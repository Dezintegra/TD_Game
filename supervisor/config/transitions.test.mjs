import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NEEDS_SESSION,
  NEEDS_WORKTREE,
  ROUTES,
  STATES,
  canTransition,
  isExclusive,
  isResource,
  isWaiting,
  stateClass,
} from './transitions.mjs';

/**
 * Проверки автомата состояний.
 *
 * Здесь ловится ровно то, что дороже всего заметить в живом конвейере:
 * переход, которого не должно быть, и цена состояния, посчитанная неверно.
 * Первое пустило бы задачу мимо проверки, второе заняло бы машину замером
 * посреди чужой работы.
 */

const task = (over = {}) => ({
  id: '0001-example',
  type: 'feature',
  status: 'new',
  returnTo: null,
  ...over,
});

describe('маршруты', () => {
  it('доработка идёт полным путём', () => {
    const path = [
      ['new', 'design'],
      ['design', 'audit'],
      ['audit', 'implement'],
      ['implement', 'pr'],
      ['pr', 'review'],
      ['review', 'deploy'],
      ['deploy', 'cleanup'],
      ['cleanup', 'closed'],
    ];
    for (const [from, to] of path) {
      expect(canTransition(task({ status: from }), to).ok, `${from} → ${to}`).toBe(true);
    }
  });

  it('кандидат одобряется переходом в очередь', () => {
    // Переход объявлен, хотя выполняет его человек мышью. Не объяви его —
    // карточка, перетащенная в «Заведено», вернулась бы обратно: конвейер
    // возвращает всё, чего нет в таблице. Шлюз не просто не работал бы,
    // а отменял бы одобрение.
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'new').ok).toBe(true);
    expect(canTransition(task({ type: 'note', status: 'candidate' }), 'new').ok).toBe(true);
  });

  it('кандидата нельзя протащить мимо очереди', () => {
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'design').ok).toBe(false);
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'implement').ok).toBe(
      false,
    );
  });

  it('прогон кандидатом не бывает', () => {
    expect(canTransition(task({ type: 'run', status: 'candidate' }), 'new').ok).toBe(false);
  });

  it('прогон не заходит в проработку', () => {
    expect(canTransition(task({ type: 'run', status: 'new' }), 'design').ok).toBe(false);
    expect(canTransition(task({ type: 'run', status: 'new' }), 'benchmark').ok).toBe(true);
  });

  it('замер отдаёт прогон толкованию, а закрыть его сам не вправе', () => {
    const measured = task({ type: 'run', status: 'benchmark' });
    expect(canTransition(measured, 'interpret').ok).toBe(true);
    expect(canTransition(measured, 'closed').ok).toBe(false);
  });

  it('толкование закрывает прогон', () => {
    expect(canTransition(task({ type: 'run', status: 'interpret' }), 'closed').ok).toBe(true);
  });

  it('доработка толкования не знает: её замер ведёт к проверкам', () => {
    // Толкование объявлено только на маршруте прогона. У доработки замер —
    // одна из проверок перед ревью, и читает её ревьюер.
    const measured = task({ type: 'feature', status: 'benchmark' });
    expect(canTransition(measured, 'interpret').ok).toBe(false);
    expect(canTransition(measured, 'pr').ok).toBe(true);
  });

  it('замечание разбирается и закрывается', () => {
    expect(canTransition(task({ type: 'note', status: 'new' }), 'triage').ok).toBe(true);
    expect(canTransition(task({ type: 'note', status: 'triage' }), 'closed').ok).toBe(true);
  });

  it('через ступень перепрыгнуть нельзя', () => {
    const verdict = canTransition(task({ status: 'design' }), 'pr');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('«audit»');
  });

  it('аудит с замечаниями возвращает в проработку', () => {
    expect(canTransition(task({ status: 'audit' }), 'design').ok).toBe(true);
  });

  it('доработка ведёт в ожидание проверок, а не сразу в ревью', () => {
    expect(canTransition(task({ status: 'revise' }), 'pr').ok).toBe(true);
    expect(canTransition(task({ status: 'revise' }), 'review').ok).toBe(false);
  });

  it('несуществующее состояние отвергается', () => {
    expect(canTransition(task(), 'почти-готово').ok).toBe(false);
  });
});

describe('сквозные состояния', () => {
  it('ошибка достижима из любого рабочего состояния', () => {
    for (const status of ['design', 'implement', 'benchmark', 'review', 'deploy']) {
      expect(canTransition(task({ status }), 'failed').ok, status).toBe(true);
    }
  });

  it('ожидание ответа достижимо из любого рабочего состояния', () => {
    for (const status of ['triage', 'design', 'implement']) {
      expect(canTransition(task({ status }), 'awaiting-po').ok, status).toBe(true);
    }
  });

  it('возврат из ожидания ведёт в сохранённое состояние', () => {
    const waiting = task({ status: 'awaiting-po', returnTo: 'design' });
    expect(canTransition(waiting, 'design').ok).toBe(true);
    expect(canTransition(waiting, 'implement').ok).toBe(false);
  });

  it('из ошибки конвейер сам не поднимает, кроме сохранённого состояния', () => {
    const failed = task({ status: 'failed', returnTo: 'implement' });
    expect(canTransition(failed, 'implement').ok).toBe(true);
    expect(canTransition(failed, 'review').ok).toBe(false);
  });

  it('разбор ошибки достижим из любого рабочего состояния', () => {
    for (const status of ['triage', 'design', 'implement', 'benchmark', 'review', 'cleanup']) {
      expect(canTransition(task({ status }), 'postmortem').ok, status).toBe(true);
    }
  });

  it('из разбора ошибки выход только в ошибку', () => {
    // Вход в разбор открыт отовсюду, а выход держится тем, что `postmortem`
    // не объявлен ни в одном маршруте: разрешённым остаётся лишь сквозной
    // переход в `failed`. Поднимает задачу человек, и делает это из ошибки.
    const analysed = task({ status: 'postmortem', returnTo: 'implement' });
    expect(canTransition(analysed, 'failed').ok).toBe(true);
    expect(canTransition(analysed, 'implement').ok).toBe(false);
    expect(canTransition(analysed, 'closed').ok).toBe(false);
  });

  it('разбор разбора не назначается', () => {
    expect(canTransition(task({ status: 'postmortem' }), 'postmortem').ok).toBe(false);
  });

  it('закрытая задача не оживает', () => {
    expect(canTransition(task({ status: 'closed' }), 'design').ok).toBe(false);
  });
});

describe('цена состояния', () => {
  it('проработка и имплементация занимают квоту', () => {
    expect(isResource(task({ status: 'design' }))).toBe(true);
    expect(isResource(task({ status: 'implement' }))).toBe(true);
  });

  it('ожидание проверок квоту не занимает', () => {
    expect(isWaiting(task({ status: 'pr' }))).toBe(true);
    expect(isResource(task({ status: 'pr' }))).toBe(false);
  });

  it('ревью считается отдельной квотой', () => {
    expect(stateClass(task({ status: 'review' }))).toBe('review');
    expect(isResource(task({ status: 'review' }))).toBe(false);
  });

  it('арена считается на чужом железе и машину не занимает', () => {
    const arena = task({ type: 'run', status: 'benchmark', run: { kind: 'arena' } });
    expect(isWaiting(arena)).toBe(true);
    expect(isExclusive(arena)).toBe(false);
  });

  it('замер кадров требует тишины на машине', () => {
    const perf = task({ type: 'run', status: 'benchmark', run: { kind: 'perf' } });
    expect(isExclusive(perf)).toBe(true);
  });

  it('выкладка требует тишины на машине', () => {
    expect(isExclusive(task({ status: 'deploy' }))).toBe(true);
  });
});

describe('этапы и скиллы', () => {
  it('у каждого этапа с сессией есть скилл', () => {
    // Сессия-исполнитель читает указания своего этапа из
    // `skills/<этап>.md` и без них не знает, что делать. Расхождение
    // скиллов с кодом — самая частая беда этого конвейера: этап,
    // объявленный в таблице, но не описанный, обнаружится только тогда,
    // когда задача до него дойдёт, — то есть в проде и молча.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const missing = NEEDS_SESSION.filter((stage) => !existsSync(`${dir}${stage}.md`));
    expect(missing).toEqual([]);
  });

  it('ни один скилл не посылает исполнителя за слотом или отчётом на диск', () => {
    // Слоты и каталог отчётов удалены вместе с прежним устройством: работа
    // приходит промптом, отчёт возвращается сообщением. Забытое упоминание
    // страшнее мёртвой ссылки — сессия честно пойдёт искать файл, не найдёт
    // и решит, что назначения нет. Такое уже было с выпиской задачи после
    // переезда бэклога на доску: файл остался на месте, но устарел, и сессия
    // читала позавчерашнюю картину молча.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      const text = readFileSync(`${dir}${stage}.md`, 'utf8');
      for (const banned of ['.pipeline/slots', '.pipeline/reports', 'set_session_title']) {
        if (text.includes(banned)) guilty.push(`${stage}.md: ${banned}`);
      }
    }
    expect(guilty).toEqual([]);
  });

  it('ни один скилл не показывает коммит многострочной строкой', () => {
    // Переводы строк внутри команды разбор разрешений видит как несколько
    // команд: приставке `git commit` отвечает только первая, остальные —
    // строки самого сообщения — отказываются. Коммит при этом не ложится,
    // а без коммита у коммитящего этапа нет следа — и отчёт не применяется.
    //
    // Пример в скилле здесь опаснее умолчания: 31.08.2026 задача 0011
    // дважды сделала работу и дважды лишилась отчёта, набирая тело коммита
    // через `@'` … `'@` — форму, которую предписывают общие указания
    // по PowerShell. Скилл этапа обязан её перебить.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      const text = readFileSync(`${dir}${stage}.md`, 'utf8');
      if (/git\s[^\n]*commit[^\n]*-m\s+@'/.test(text)) guilty.push(`${stage}.md`);
    }
    expect(guilty).toEqual([]);
  });

  it('правила разрешений не пишутся в форме, которая молча не работает', () => {
    // Хвост правила — `путь/*`, а не `путь/:*`. Форма с двоеточием внутри
    // пути не совпадает ни с чем, и правило просто не срабатывает: задача
    // 0016 получила четыре отказа подряд при стоявшем `Bash(node .matchlog/:*)`
    // и прошла без единого, едва форму заменили. Двоеточие остаётся верным
    // там, где отделяет команду от любых аргументов (`gh pr:*`).
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    const rules = [...settings.permissions.allow, ...settings.permissions.deny];
    expect(rules.filter((rule) => /\/:\*\)/.test(rule))).toEqual([]);
  });

  it('служебный каталог конвейера открыт чтением, и не мнимой формой', () => {
    // Этап живёт в своём дереве, а реестр деревьев — в `.pipeline` основного,
    // то есть вне его рабочего каталога. Список `allow` этой границы не двигает:
    // проба 01.09.2026 показала, что с `Read(.pipeline/**)` отказ повторяется
    // слово в слово, а с `additionalDirectories` его нет вовсе. Цена вопроса
    // измерена — четыре этапа аудита подряд встали на одном и том же файле.
    //
    // Путей два, и оба нужны: относительный считается от рабочего каталога,
    // а он у этапов разный — корень у безместных, дерево тремя уровнями ниже
    // у прочих.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    expect(settings.permissions.additionalDirectories).toContain('.pipeline');
    expect(settings.permissions.additionalDirectories).toContain('../../../.pipeline');

    const rules = [...settings.permissions.allow, ...settings.permissions.deny];
    expect(rules.filter((rule) => /^Read\(\.pipeline/.test(rule))).toEqual([]);
  });

  it('удаление файлов правилами не выписывается: оно всё равно не пройдёт', () => {
    // Проверено 31.08.2026 тремя пробами: с шаблоном, без перекрывающего
    // запрета и с точным совпадением команды — отказ во всех трёх. Правило
    // на удаление создаёт вид надёжности, а запрет вида `.matchlog/*` вдобавок
    // перекрывает собственные разрешения и отнимает у этапа отчёт.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    const rules = [...settings.permissions.allow, ...settings.permissions.deny];
    expect(rules.filter((rule) => /Remove-Item|rm -rf/.test(rule))).toEqual([]);
  });

  it('этапы, подающие заявки, знают признак причины в конвейере', () => {
    // Заявка с `area: "pipeline"` минует кандидатов с любого этапа. Скилл,
    // не знающий признака, заведёт починку конвейера кандидатом — и она
    // будет ждать человека, пока та же причина роняет следующие задачи;
    // 02.09.2026 так простояли четыре починки.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const requesting = [
      'design',
      'audit',
      'implement',
      'revise',
      'review',
      'interpret',
      'triage',
      'postmortem',
    ];
    const silent = requesting.filter(
      (stage) => !readFileSync(`${dir}${stage}.md`, 'utf8').includes('`area: "pipeline"`'),
    );
    expect(silent).toEqual([]);
  });

  it('скилл прогона называет разрешённое ожидание и не показывает циклов', () => {
    // Ждать чужой прогон этапу надо всегда, а разрешённая форма ровно одна —
    // `gh run watch <id> --exit-status`. Не назови её скилл — сессия придумает
    // своё: за вечер 31.08.2026 придумались цикл на `while`, цикл на `for`
    // с `seq` и фоновая задача с чтением файла вывода. Все три получили отказ,
    // и все три оставили этап без ответа о прогоне — то есть без его номера,
    // а номер и есть след замера. Отчёт без следа не применяется, и замер
    // по пять долларов и четыре минуты чужого железа пропадает целиком.
    //
    // Пример опаснее умолчания: показанный в скилле цикл сессия перепишет
    // буквально. Поэтому запрет здесь сформулирован без образцов кода,
    // а сторож ловит именно образцы.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const text = readFileSync(`${dir}benchmark.md`, 'utf8');
    expect(text).toContain('gh run watch <id> --exit-status');
    expect(text.match(/while \(|for i in/g) ?? []).toEqual([]);
  });

  it('этапы, которые коммитят, называют повторный -m прямо', () => {
    // Запрет без замены не работает: тело коммита требуется правилами
    // проекта, и, лишившись одного способа, сессия придумает свой.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const silent = ['design', 'implement', 'revise'].filter((stage) => {
      const text = readFileSync(`${dir}${stage}.md`, 'utf8');
      return !text.includes('повторными `-m`');
    });
    expect(silent).toEqual([]);
  });
});

describe('связность таблицы', () => {
  it('у каждого состояния объявлена цена', () => {
    const priced = STATES.filter((status) => stateClass({ status, run: { kind: 'arena' } }));
    expect(priced).toHaveLength(STATES.length);
  });

  it('все состояния маршрутов существуют', () => {
    for (const [type, route] of Object.entries(ROUTES)) {
      for (const [from, targets] of Object.entries(route)) {
        expect(STATES, `${type}: ${from}`).toContain(from);
        for (const to of targets) expect(STATES, `${type}: ${from} → ${to}`).toContain(to);
      }
    }
  });

  it('дерево нужно только тем состояниям, что правят код', () => {
    expect(NEEDS_WORKTREE).not.toContain('benchmark');
    expect(NEEDS_WORKTREE).not.toContain('triage');
    // Разбор читает журнал, лог и правила конвейера — писать ему некуда
    // и незачем. Дерево упавшей задачи он тоже не трогает: оно сохранено
    // для человека.
    expect(NEEDS_WORKTREE).not.toContain('postmortem');
    expect(NEEDS_WORKTREE).toContain('implement');
  });
});
