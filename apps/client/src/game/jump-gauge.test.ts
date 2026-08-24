import { cellsToUnits } from '@td/shared';
import { describe, expect, it } from 'vitest';
import { createJumpGauge } from './jump-gauge.js';

/**
 * Прибор обязан молчать на движении и говорить на поправке. Оба
 * свойства проверяются порознь, потому что ошибиться можно в обе
 * стороны: прибор, кричащий на каждом шаге, так же бесполезен, как
 * прибор, молчащий на телепорте.
 */

/** Скорость генерала для проверок: половина клетки за такт. */
const SPEED = cellsToUnits(0.5);

describe('прибор скачков', () => {
  it('обычное движение телепортом не считается', () => {
    const gauge = createJumpGauge();

    gauge.observe(10, 0, 0, SPEED, 0);
    for (let step = 1; step <= 5; step += 1) {
      gauge.observe(10 + step, SPEED * step, 0, SPEED, 0);
    }

    expect(gauge.jumps().count).toBe(0);
    expect(gauge.pending().count).toBe(0);
  });

  it('движение по диагонали телепортом не считается', () => {
    // Порог по осям, а не по прямой: по диагонали прямое расстояние
    // доходит до скорости, умноженной на корень из двух, и порог
    // по прямой пришлось бы задирать, теряя чувствительность.
    const gauge = createJumpGauge();

    gauge.observe(10, 0, 0, SPEED, 0);
    gauge.observe(11, SPEED, SPEED, SPEED, 0);

    expect(gauge.jumps().count).toBe(0);
  });

  it('пропуск тактов не превращается в скачок', () => {
    // За три такта генерал вправе пройти втрое больше. Прибор, считающий
    // допуск от одного такта, объявил бы телепортом обычную отрисовку
    // на просевшей частоте кадров.
    const gauge = createJumpGauge();

    gauge.observe(10, 0, 0, SPEED, 0);
    gauge.observe(13, SPEED * 3, 0, SPEED, 0);

    expect(gauge.jumps().count).toBe(0);
  });

  it('поправка после опоздавшей команды видна и меряется в клетках', () => {
    const gauge = createJumpGauge();

    gauge.observe(10, 0, 0, SPEED, 0);
    // За такт можно пройти половину клетки, а прошли две с половиной:
    // две клетки сверх допустимого.
    gauge.observe(11, cellsOfUnits(3), 0, SPEED, 4);

    const jumps = gauge.jumps();
    expect(jumps.count).toBe(1);
    expect(jumps.max).toBeCloseTo(2.5, 6);
    expect(jumps.overBudget).toBe(1);
  });

  it('откат назад считается наравне с прыжком вперёд', () => {
    // Поправка чаще всего отбрасывает генерала НАЗАД: клиент показал
    // движение, которого сервер ещё не исполнил. Прибор, смотрящий
    // только вперёд, пропустил бы главный случай.
    const gauge = createJumpGauge();

    gauge.observe(10, cellsOfUnits(5), 0, SPEED, 0);
    gauge.observe(11, cellsOfUnits(3), 0, SPEED, 2);

    expect(gauge.jumps().count).toBe(1);
    expect(gauge.jumps().max).toBeCloseTo(1.5, 6);
  });

  it('очередь снимается ровно в момент скачка', () => {
    // Вопрос игрока был «совпадает ли рост очереди со скачками».
    // Очередь, снятая равномерно, на него не отвечает.
    const gauge = createJumpGauge();

    gauge.observe(10, 0, 0, SPEED, 7);
    gauge.observe(11, SPEED, 0, SPEED, 9);
    gauge.observe(12, cellsOfUnits(4), 0, SPEED, 3);

    const pending = gauge.pending();
    expect(pending.count).toBe(1);
    expect(pending.max).toBe(3);
  });

  it('пересборка показа без смены тика не считается скачком', () => {
    // Нажал клавишу — генерал поехал в том же кадре. Это разрыв
    // в положении, но разрыв желанный: ровно за него игра и держится.
    const gauge = createJumpGauge();

    gauge.observe(10, 0, 0, SPEED, 0);
    gauge.observe(10, cellsOfUnits(2), 0, SPEED, 1);

    expect(gauge.jumps().count).toBe(0);
  });

  it('прокачанная скорость не даёт ложных скачков', () => {
    // Скорость берётся с учётом прокачки. Постоянная из баланса дала бы
    // телепорт на каждом шаге прокачанного генерала.
    const gauge = createJumpGauge();
    const quick = SPEED * 2;

    gauge.observe(10, 0, 0, quick, 0);
    gauge.observe(11, quick, 0, quick, 0);

    expect(gauge.jumps().count).toBe(0);
  });
  it('пересборка на том же тике не отдаёт разницу следующему такту', () => {
    // Точка отсчёта обязана обновиться и тогда, когда тик не сдвинулся.
    // Иначе законная разница — генерал поехал от своего же нажатия —
    // достанется следующему такту и превратится в скачок из ниоткуда.
    const gauge = createJumpGauge();

    gauge.observe(10, 0, 0, SPEED, 0);
    gauge.mine();
    gauge.observe(10, cellsOfUnits(2), 0, SPEED, 0);
    gauge.observe(11, cellsOfUnits(2) + SPEED, 0, SPEED, 0);

    expect(gauge.jumps().count).toBe(0);
  });

  it('своё нажатие скачком не считается даже со сменой тика', () => {
    // Собственное нажатие двигает генерала задним числом по всему
    // горизонту: команда назначается на такт «подтверждённый плюс
    // задержка», а показывается такт выше, и путь между ними
    // пересчитывается с новым направлением. Разрыв настоящий — и ровно
    // тот, ради которого игра держится за отклик в том же кадре.
    //
    // Проверено на стенде: без этой отметки за тридцать секунд манёвра
    // на РОВНОМ канале выходило десять «скачков» — по числу поворотов,
    // и ни один не был поправкой от сервера.
    const gauge = createJumpGauge();

    gauge.observe(10, 0, 0, SPEED, 0);
    gauge.mine();
    gauge.observe(11, cellsOfUnits(3), 0, SPEED, 1);

    expect(gauge.jumps().count).toBe(0);

    // А следующее обновление уже обычное, и отметка на него не действует.
    gauge.observe(12, cellsOfUnits(6), 0, SPEED, 1);
    expect(gauge.jumps().count).toBe(1);
  });
});

/** Клетки во внутренних единицах — читается легче, чем умножение. */
function cellsOfUnits(cells: number): number {
  return cellsToUnits(cells);
}
