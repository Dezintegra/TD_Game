import { describe, expect, it } from 'vitest';
import { NEEDS_SESSION } from '../config/transitions.mjs';
import { applyExternal, applyReport } from './apply-report.mjs';

/**
 * Проверки разбора отчётов.
 *
 * Здесь решается, куда задача двинется, когда этап кончился, — то есть
 * ровно то место, где ошибка тихо уводит задачу не туда. Поэтому проверяется
 * не только счастливый путь, но и все три несчастливых исхода и отчёт
 * о чужом этапе.
 */

const task = (over = {}) => ({
  id: '0001-one',
  type: 'feature',
  status: 'design',
  returnTo: null,
  ...over,
});

const report = (over = {}) => ({ stage: 'design', outcome: 'done', ...over });

describe('успешный этап двигает задачу по маршруту', () => {
  it.each([
    ['design', 'audit'],
    ['audit', 'implement'],
    ['implement', 'pr'],
    ['review', 'deploy'],
    ['deploy', 'cleanup'],
    ['cleanup', 'closed'],
  ])('из «%s» в «%s»', (from, to) => {
    const verdict = applyReport(task({ status: from }), report({ stage: from }));
    expect(verdict.status).toBe(to);
    expect(verdict.problems).toEqual([]);
  });

  it('закрытая доработка возвращает задачу к проверкам, а не в ошибку', () => {
    // Дыра, найденная сверкой скиллов: маршрут revise → pr был объявлен
    // в таблице переходов и в скилле, но разбор отчёта о нём не знал —
    // и каждая успешная доработка гарантированно падала в failed.
    const verdict = applyReport(task({ status: 'revise' }), report({ stage: 'revise' }));
    expect(verdict.status).toBe('pr');
    expect(verdict.problems).toEqual([]);
  });

  it('у каждого этапа с сессией есть исход при успехе', () => {
    // Сторож против той же беды в будущем: состояние, требующее сессии,
    // обязано знать, куда двигаться при удачном исходе.
    // Тип берётся по этапу, а не один на всех: этап живёт лишь на том
    // маршруте, где объявлен. Толкование бывает только у задачи-прогона,
    // и подсунув ему `feature`, сторож поймал бы не дыру, а свою ошибку.
    const typeFor = { triage: 'note', interpret: 'run' };
    for (const status of NEEDS_SESSION) {
      const type = typeFor[status] ?? 'feature';
      const source = task({
        status,
        type,
        run:
          status === 'benchmark' || type === 'run'
            ? { kind: 'arena', expectation: 'ровно' }
            : undefined,
      });
      const verdict = applyReport(source, report({ stage: status }));
      expect(verdict.status, `этап ${status}`).not.toBe('failed');
    }
  });

  it('разбор замечания закрывает задачу', () => {
    const verdict = applyReport(
      task({ type: 'note', status: 'triage' }),
      report({ stage: 'triage' }),
    );
    expect(verdict.status).toBe('closed');
  });

  it('замер отдаёт задачу-прогон толкованию, а не закрывает', () => {
    // Прежде замер закрывал задачу сам: одна сессия считала, толковала
    // и закрывала. Толкование — работа суждения, и делать её походя, в том
    // же отчёте, где перечислены цифры, значит прятать её за ними.
    const verdict = applyReport(
      task({ type: 'run', status: 'benchmark', run: { kind: 'arena', expectation: 'ровно' } }),
      report({ stage: 'benchmark' }),
    );
    expect(verdict.status).toBe('interpret');
  });

  it('толкование закрывает задачу-прогон', () => {
    const verdict = applyReport(
      task({ type: 'run', status: 'interpret', run: { kind: 'arena', expectation: 'ровно' } }),
      report({ stage: 'interpret' }),
    );
    expect(verdict.status).toBe('closed');
    expect(verdict.problems).toEqual([]);
  });

  it('прогон внутри доработки ведёт к pull request', () => {
    const verdict = applyReport(
      task({ status: 'benchmark', run: { kind: 'perf', expectation: 'не ниже порога' } }),
      report({ stage: 'benchmark' }),
    );
    expect(verdict.status).toBe('pr');
  });

  it('заказанный прогон вклинивается между имплементацией и pull request', () => {
    const withRun = task({ status: 'implement', run: { kind: 'arena', expectation: 'ровно' } });
    expect(applyReport(withRun, report({ stage: 'implement' })).status).toBe('benchmark');
  });

  it('без заказанного прогона имплементация ведёт прямо в pull request', () => {
    expect(applyReport(task({ status: 'implement' }), report({ stage: 'implement' })).status).toBe(
      'pr',
    );
  });
});

describe('замечания — рабочий ход, а не ошибка', () => {
  it('аудит с замечаниями возвращает в проработку', () => {
    const verdict = applyReport(
      task({ status: 'audit' }),
      report({ stage: 'audit', outcome: 'rejected', summary: 'пересечение с другим изменением' }),
    );
    expect(verdict.status).toBe('design');
    expect(verdict.note).toContain('пересечение');
  });

  it('ревью с замечаниями отправляет в доработку', () => {
    const verdict = applyReport(
      task({ status: 'review' }),
      report({ stage: 'review', outcome: 'rejected' }),
    );
    expect(verdict.status).toBe('revise');
  });

  it('замечания там, где их быть не может, ведут в ошибку', () => {
    const verdict = applyReport(
      task({ status: 'implement' }),
      report({ stage: 'implement', outcome: 'rejected' }),
    );
    expect(verdict.status).toBe('failed');
    expect(verdict.problems.join()).toContain('никуда не ведёт');
  });
});

describe('спор, который не сходится', () => {
  const rejection = report({
    stage: 'audit',
    outcome: 'rejected',
    summary: 'шаг 3.4 меряет не то',
  });

  it('первые возвраты остаются рабочим ходом', () => {
    const first = applyReport(task({ status: 'audit' }), rejection, { maxRejections: 3 });
    expect(first.status).toBe('design');

    const second = applyReport(
      task({ status: 'audit', attempts: { continuations: 0, cycleFailures: 0, rejections: 1 } }),
      rejection,
      { maxRejections: 3 },
    );
    expect(second.status).toBe('design');
  });

  it('возврат за пределом отдаёт задачу человеку, а не крутит ещё круг', () => {
    // 31.08.2026 задача 0011 прошла четыре круга подряд на неизменной вершине:
    // проработка отвечала «всё закрыто», аудит честно отклонял снова. Круг
    // стоил около доллара и десяти минут, а остановиться было нечему.
    const verdict = applyReport(
      task({ status: 'audit', attempts: { continuations: 0, cycleFailures: 0, rejections: 2 } }),
      rejection,
      { maxRejections: 3 },
    );
    expect(verdict.status).toBe('failed');
    expect(verdict.note).toContain('нужен разбор человеком');
    // Человеку важно не «предел исчерпан», а из-за чего спорили.
    expect(verdict.note).toContain('шаг 3.4 меряет не то');
  });

  it('без названного предела счёт не ведётся вовсе', () => {
    // Предел приходит доводом от супервизора. Проект, не назвавший его,
    // получает прежнее поведение, а не молчаливую тройку.
    const verdict = applyReport(
      task({ status: 'audit', attempts: { continuations: 0, cycleFailures: 0, rejections: 9 } }),
      rejection,
    );
    expect(verdict.status).toBe('design');
  });

  it('успех проверки гасит счёт возвратов', () => {
    const done = applyReport(
      task({ status: 'audit', attempts: { continuations: 0, cycleFailures: 0, rejections: 2 } }),
      report({ stage: 'audit', outcome: 'done' }),
      { maxRejections: 3 },
    );
    expect(done.status).toBe('implement');
  });
});

describe('несчастливые исходы', () => {
  it('неуспех сохраняет состояние возврата', () => {
    const verdict = applyReport(
      task({ status: 'implement' }),
      report({ stage: 'implement', outcome: 'failed', summary: 'сборка не собралась' }),
    );
    expect(verdict).toMatchObject({ status: 'failed', returnTo: 'implement' });
    expect(verdict.note).toContain('сборка');
  });

  it('вопрос уводит в ожидание ответа с сохранением возврата', () => {
    const verdict = applyReport(
      task({ status: 'design' }),
      report({ stage: 'design', outcome: 'question', summary: 'два прочтения требования' }),
    );
    expect(verdict).toMatchObject({ status: 'awaiting-po', returnTo: 'design' });
  });

  it('неизвестный исход не применяется', () => {
    const verdict = applyReport(task(), report({ outcome: 'почти получилось' }));
    expect(verdict.status).toBe('failed');
    expect(verdict.problems.join()).toContain('неизвестный исход');
  });

  it('отчёт о чужом этапе не применяется', () => {
    const verdict = applyReport(task({ status: 'implement' }), report({ stage: 'design' }));
    expect(verdict.status).toBe('failed');
    expect(verdict.problems.join()).toContain('а задача в «implement»');
  });
});

describe('опрос внешнего состояния', () => {
  it('идущие проверки оставляют задачу на месте', () => {
    const verdict = applyExternal(task({ status: 'pr' }), { state: 'pending' });
    expect(verdict.status).toBe('pr');
  });

  it('зелёные проверки открывают ревью', () => {
    const verdict = applyExternal(task({ status: 'pr' }), { state: 'success' });
    expect(verdict.status).toBe('review');
  });

  it('красные проверки отправляют в доработку с именем упавшей', () => {
    const verdict = applyExternal(task({ status: 'pr' }), {
      state: 'failure',
      failed: 'матчевые тесты',
    });
    expect(verdict.status).toBe('revise');
    expect(verdict.note).toContain('матчевые тесты');
  });

  it('удавшийся прогон отдаёт задачу-прогон толкованию', () => {
    // Опрос узнаёт только «посчиталось или нет». Что означают полученные
    // числа, он не знает и знать не должен — на то есть отдельный этап.
    const verdict = applyExternal(task({ type: 'run', status: 'benchmark' }), {
      state: 'success',
    });
    expect(verdict.status).toBe('interpret');
  });

  it('неудавшийся прогон уводит в ошибку', () => {
    const verdict = applyExternal(task({ type: 'run', status: 'benchmark' }), {
      state: 'failure',
    });
    expect(verdict).toMatchObject({ status: 'failed', returnTo: 'benchmark' });
  });
});
