import { describe, expect, it } from 'vitest';
import { CommandKind, RejectReason, TICKS_PER_SECOND, asPlayerId } from '@td/shared';
import type { PlayerId } from '@td/shared';
import type { Rejection } from '@td/sim';
import { createRejectionFeed } from './rejections.js';

/**
 * Гашение повторов — единственная нетривиальная часть ленты отказов,
 * и проверяется она здесь, а не глазами в браузере: воспроизвести
 * «зажал клавишу на секунду» руками и убедиться, что сообщение ровно
 * одно, куда труднее, чем прогнать тридцать тиков в тесте.
 */

const ME: PlayerId = asPlayerId(0);
const FOE: PlayerId = asPlayerId(1);

const reject = (
  player: PlayerId = ME,
  kind: CommandKind = CommandKind.Build,
  reason: RejectReason = RejectReason.NotEnoughEnergy,
  index = 0,
): Rejection => ({ player, kind, reason, index });

describe('лента отказов', () => {
  it('показывает первый отказ', () => {
    const feed = createRejectionFeed(ME);
    const notices = feed.accept(0, [reject()]);

    expect(notices).toHaveLength(1);
    expect(notices?.[0]?.reason).toBe(RejectReason.NotEnoughEnergy);
  });

  it('зажатая клавиша даёт одно сообщение, а не тридцать', () => {
    const feed = createRejectionFeed(ME);

    let shown = 0;
    for (let tick = 0; tick < TICKS_PER_SECOND; tick += 1) {
      const notices = feed.accept(tick, [reject()]);
      if (notices !== undefined) shown = notices.length;
    }

    expect(shown).toBe(1);
  });

  it('через секунду повтор снова слышен', () => {
    const feed = createRejectionFeed(ME);

    feed.accept(0, [reject()]);
    const later = feed.accept(TICKS_PER_SECOND, [reject()]);

    expect(later?.length).toBe(2);
  });

  it('разные причины гасятся независимо', () => {
    const feed = createRejectionFeed(ME);

    const notices = feed.accept(0, [
      reject(ME, CommandKind.Build, RejectReason.NotEnoughEnergy),
      reject(ME, CommandKind.Build, RejectReason.OutsideBuildRadius),
    ]);

    expect(notices).toHaveLength(2);
  });

  it('одна причина у разных команд гасится независимо', () => {
    const feed = createRejectionFeed(ME);

    const notices = feed.accept(0, [
      reject(ME, CommandKind.Build, RejectReason.NotEnoughEnergy),
      reject(ME, CommandKind.TrainUnit, RejectReason.NotEnoughEnergy),
    ]);

    expect(notices).toHaveLength(2);
  });

  it('чужие отказы не показываются', () => {
    const feed = createRejectionFeed(ME);

    expect(feed.accept(0, [reject(FOE)])).toBeUndefined();
  });

  it('молчит, когда ничего не изменилось', () => {
    const feed = createRejectionFeed(ME);

    // Тик без отказов и без просроченных сообщений не должен трогать
    // store: обработчик зовётся тридцать раз в секунду.
    expect(feed.accept(0, [])).toBeUndefined();
    expect(feed.accept(1, [])).toBeUndefined();
  });

  it('сообщение гаснет само', () => {
    const feed = createRejectionFeed(ME);

    feed.accept(0, [reject()]);

    let last: readonly { readonly id: number }[] | undefined;
    for (let tick = 1; tick <= TICKS_PER_SECOND * 3; tick += 1) {
      const notices = feed.accept(tick, []);
      if (notices !== undefined) last = notices;
    }

    expect(last).toHaveLength(0);
  });

  it('больше трёх сообщений разом не висит', () => {
    const feed = createRejectionFeed(ME);

    const reasons = [
      RejectReason.NotEnoughEnergy,
      RejectReason.OutsideBuildRadius,
      RejectReason.CellBlocked,
      RejectReason.CellOccupiedByLiving,
      RejectReason.InvalidTarget,
    ];

    const notices = feed.accept(
      0,
      reasons.map((reason) => reject(ME, CommandKind.Build, reason)),
    );

    expect(notices).toHaveLength(3);
    // Вытесняются старшие, остаются последние.
    expect(notices?.[2]?.reason).toBe(RejectReason.InvalidTarget);
  });

  it('новый матч начинается с чистого листа', () => {
    const feed = createRejectionFeed(ME);

    feed.accept(500, [reject()]);
    // Тик пошёл назад — это рестарт. Без сброса гашение сочло бы, что
    // отказ уже показан, и промолчало бы всю первую секунду нового матча.
    const afterRestart = feed.accept(0, [reject()]);

    expect(afterRestart).toHaveLength(1);
    expect(afterRestart?.[0]?.tick).toBe(0);
  });

  it('номера сообщений растут и после рестарта', () => {
    const feed = createRejectionFeed(ME);

    const before = feed.accept(500, [reject()])?.[0]?.id ?? 0;
    const after = feed.accept(0, [reject()])?.[0]?.id ?? 0;

    // Панели HUD отличают новый отказ от старого по возрастанию номера.
    // Повтор номера после рестарта они прочли бы как «ничего не изменилось».
    expect(after).toBeGreaterThan(before);
  });
});
