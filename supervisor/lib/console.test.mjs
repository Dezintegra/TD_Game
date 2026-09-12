import { describe, expect, it } from 'vitest';
import {
  TAG,
  clip,
  clipPath,
  createConsole,
  describeEvent,
  humanDuration,
  toolDigest,
} from './console.mjs';

/**
 * Проверки рассказа супервизора.
 *
 * Проверять здесь есть что именно потому, что ошибка формата видна только
 * глазами и только тогда, когда смотреть уже поздно: живого супервизора
 * не запустишь ради одной строки, а на боевой машине она обнаружится
 * в ту минуту, когда за консолью следят по-настоящему.
 *
 * Часы и вывод приходят доводами, поэтому весь набор идёт за миллисекунды
 * и не пишет в терминал ни знака.
 */

const ESC = String.fromCharCode(27);

/** Рассказчик, пишущий в память, с остановленными часами. */
function recorder({ at = '2026-09-01T14:03:07', colour = false, quiet = false } = {}) {
  const written = [];
  let clockAt = new Date(at);
  const console_ = createConsole({
    write: (text) => written.push(text),
    now: () => clockAt,
    colour,
    quiet,
  });
  return {
    console: console_,
    // Полоса даты печатается сама и первой; строки берём без неё.
    lines: () => written.join('').split('\n').filter(Boolean),
    text: () => written.join(''),
    moveTo: (iso) => {
      clockAt = new Date(iso);
    },
  };
}

describe('строка с отметкой времени', () => {
  it('несёт время и тег', () => {
    const out = recorder();
    out.console.line(TAG.cycle, 'оборот начат');
    expect(out.lines().at(-1)).toBe('14:03:07 ЦИКЛ   оборот начат');
  });

  it('теги выровнены по ширине: столбец сообщений не пляшет', () => {
    const out = recorder();
    out.console.line(TAG.cycle, 'раз');
    out.console.line(TAG.task, 'два');
    const [, first, second] = out.lines();
    expect(first.indexOf('раз')).toBe(second.indexOf('два'));
  });

  it('перечень строк печатается по строке на каждую', () => {
    const out = recorder();
    out.console.line(TAG.stage, ['первая', 'вторая']);
    expect(out.lines().filter((line) => line.includes('ЭТАП'))).toHaveLength(2);
  });

  it('пустое не печатается вовсе: пустая строка в журнале — мусор', () => {
    const out = recorder();
    out.console.line(TAG.stage, ['', null, undefined]);
    expect(out.lines().filter((line) => line.includes('ЭТАП'))).toHaveLength(0);
  });
});

describe('дата', () => {
  it('печатается полосой один раз, а не в каждой строке', () => {
    const out = recorder();
    out.console.line(TAG.cycle, 'раз');
    out.console.line(TAG.cycle, 'два');
    expect(out.text().match(/1 сентября 2026/g)).toHaveLength(1);
  });

  it('печатается заново при смене суток: супервизор живёт днями', () => {
    const out = recorder();
    out.console.line(TAG.cycle, 'вечером');
    out.moveTo('2026-09-02T00:01:00');
    out.console.line(TAG.cycle, 'утром');
    expect(out.text()).toContain('2 сентября 2026');
  });
});

describe('цвет', () => {
  it('не выводится, когда его не просили: журнал сторожа не место для них', () => {
    const out = recorder({ colour: false });
    out.console.line(TAG.error, 'беда');
    expect(out.text()).not.toContain(ESC);
  });

  it('выводится, когда просили', () => {
    const out = recorder({ colour: true });
    out.console.line(TAG.error, 'беда');
    expect(out.text()).toContain(ESC);
  });
});

describe('немота', () => {
  it('приглушённый рассказчик не пишет ни знака', () => {
    const out = recorder({ quiet: true });
    out.console.line(TAG.cycle, 'оборот');
    out.console.block('ЗАГОЛОВОК', [['имя', 'значение']]);
    expect(out.text()).toBe('');
    expect(out.console.enabled).toBe(false);
  });
});

describe('блок запуска', () => {
  it('имена выровнены по самому длинному', () => {
    const out = recorder();
    out.console.block('СУПЕРВИЗОР', [
      ['процесс', '1234'],
      ['корень проекта', 'C:/repo'],
    ]);
    const rows = out.lines().filter((line) => line.startsWith('  '));
    expect(rows[0].indexOf('1234')).toBe(rows[1].indexOf('C:/repo'));
  });

  it('пропущенные строки не ломают выравнивание', () => {
    const out = recorder();
    expect(() => out.console.block('ЗАГОЛОВОК', [['имя', 'значение'], null, false])).not.toThrow();
  });
});

describe('длительность', () => {
  it('секунды', () => expect(humanDuration(42_000)).toBe('42 с'));
  it('минуты с секундами', () => expect(humanDuration(62_000)).toBe('1 мин 2 с'));
  it('ровные минуты без хвоста', () => expect(humanDuration(120_000)).toBe('2 мин'));
  it('часы с минутами', () => expect(humanDuration(4_500_000)).toBe('1 ч 15 мин'));
  it('отрицательное не даёт минуса', () => expect(humanDuration(-5)).toBe('0 с'));
});

describe('урезание', () => {
  it('длинный текст сворачивается в одну строку', () => {
    expect(clip('первая\n  вторая', 40)).toBe('первая вторая');
  });

  it('урез помечен, чтобы не принять обрывок за целое', () => {
    expect(clip('абвгдежзий', 5)).toBe('абвг…');
  });

  it('у пути режется голова, а не хвост: различает файлы именно хвост', () => {
    const short = clipPath('/очень/длинный/путь/до/файла/run-stage.mjs', 20);
    expect(short.startsWith('…')).toBe(true);
    expect(short.endsWith('run-stage.mjs')).toBe(true);
  });

  it('обратные косые приводятся к прямым: путь читают, а не исполняют', () => {
    expect(clipPath('C:\\repo\\lib\\a.mjs')).toBe('C:/repo/lib/a.mjs');
  });
});

describe('выжимка доводов средства', () => {
  it('у правки файла — путь, а не содержимое', () => {
    // Содержимое правки бывает в сотни строк, и одна такая строка вытеснит
    // из терминала всё остальное.
    const digest = toolDigest('Edit', {
      file_path: 'packages/sim/src/tesla.ts',
      new_string: 'очень длинное содержимое'.repeat(50),
    });
    expect(digest).toBe('packages/sim/src/tesla.ts');
  });

  it('у оболочки — команда', () => {
    expect(toolDigest('Bash', { command: 'git push origin main' })).toBe('git push origin main');
  });

  it('у незнакомого средства — первое строковое поле, а не пустота', () => {
    // Средства заводятся и переименовываются чаще, чем правится список.
    expect(toolDigest('НовоеСредство', { что: 'ищем в бэклоге' })).toBe('ищем в бэклоге');
  });

  it('у незнакомого средства без строк — пусто, а не «undefined»', () => {
    expect(toolDigest('НовоеСредство', { сколько: 3 })).toBe('');
  });
});

describe('пересказ события потока', () => {
  it('вызов средства называется именем и выжимкой', () => {
    const said = describeEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a/b.ts' } }] },
    });
    expect(said).toEqual(['· Read a/b.ts']);
  });

  it('текст и вызов из одного хода пересказываются оба', () => {
    const said = describeEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'читаю файл' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'a/b.ts' } },
        ],
      },
    });
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('читаю файл');
  });

  it('размышление не пересказывается: это не то, за чем следят', () => {
    const said = describeEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'а если так' }] },
    });
    expect(said).toEqual([]);
  });

  it('удачный результат средства молчит', () => {
    // Объём он даёт изрядный, а пользы никакой.
    const said = describeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'файл прочитан' }] },
    });
    expect(said).toEqual([]);
  });

  it('неудачный результат средства говорит: ради него и следят', () => {
    const said = describeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', is_error: true, content: 'нет такого файла' }] },
    });
    expect(said).toEqual(['✗ нет такого файла']);
  });

  it('результат кусками, а не строкой, тоже читается', () => {
    const said = describeEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'отказано' }] },
        ],
      },
    });
    expect(said).toEqual(['✗ отказано']);
  });

  it('начало сессии называет модель', () => {
    const said = describeEvent({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-5',
      tools: [1, 2, 3],
    });
    expect(said[0]).toContain('claude-opus-5');
    expect(said[0]).toContain('3');
  });

  it('счётчик размышления не пересказывается: он про объём, а не про дело', () => {
    expect(describeEvent({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
  });

  it('итог хода говорит, только когда требует внимания', () => {
    expect(
      describeEvent({ type: 'system', subtype: 'post_turn_summary', needs_action: false }),
    ).toEqual([]);
    expect(
      describeEvent({
        type: 'system',
        subtype: 'post_turn_summary',
        needs_action: true,
        status_detail: 'ждёт ответа',
      }),
    ).toEqual(['! ждёт ответа']);
  });

  it('мусор вместо события не роняет пересказ', () => {
    expect(describeEvent(null)).toEqual([]);
    expect(describeEvent('строка')).toEqual([]);
    expect(describeEvent({ type: 'assistant' })).toEqual([]);
  });
});
