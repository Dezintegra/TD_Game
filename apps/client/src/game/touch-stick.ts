import type { Graphics } from 'pixi.js';
import type { TouchStick } from './controls.js';

/**
 * Отрисовка замирающего свайпа.
 *
 * Невидимый джойстик неотличим от неработающего экрана. Игрок, не понявший,
 * что палец уже что-то делает, решит, что игра его не слышит, — и это
 * худший исход из возможных, потому что чинить он пойдёт не то.
 *
 * Рисуется в ЭКРАННЫХ координатах, отдельно от мира: джойстик привязан
 * к пальцу, а не к клетке, и ездить с камерой не должен. Отсюда и место —
 * прямо на сцене, рядом с миникартой, а не в мировом контейнере.
 *
 * В React это не вынести: положение пальца меняется до шестидесяти раз
 * в секунду, и возить его через store значило бы перерисовывать дерево
 * с той же частотой. Правило проекта прямо говорит, что store возит
 * только то, что видно в HUD, и не возит позиции.
 */

export interface TouchStickColors {
  /** Цвет своей стороны: джойстик — это игрок. */
  readonly self: number;
  /** Приглушённый цвет для порога и мёртвой зоны. */
  readonly idle: number;
}

/** Радиус кольца мёртвой зоны. Совпадает с порогом включения. */
export const STICK_DEAD_ZONE_PX = 16;

/** Радиус метки под пальцем. */
const KNOB_RADIUS_PX = 22;

/** Радиус точки отсчёта. */
const ORIGIN_RADIUS_PX = 6;

/**
 * Дальше этого от центра метка не уходит.
 *
 * Палец может уехать через весь экран, а джойстик, растянувшийся следом,
 * перестал бы читаться и залез бы на тулбар. Направление от обрезки
 * не страдает: считается оно по настоящему вектору, а не по картинке.
 */
const MAX_REACH_PX = 72;

export const drawTouchStick = (
  graphics: Graphics,
  stick: TouchStick | null,
  colors: TouchStickColors,
): void => {
  graphics.clear();

  if (stick === null) return;

  // До порога джойстик не рисуется: тап начинал бы рисовать метку,
  // которая тут же исчезает, и это мельтешение под пальцем читалось бы
  // дрожанием интерфейса, а не откликом.
  if (!stick.engaged) return;

  // Кольцо мёртвой зоны: за ним джойстик включился, внутри — стоял бы.
  graphics
    .circle(stick.originX, stick.originY, STICK_DEAD_ZONE_PX)
    .stroke({ width: 1, color: colors.idle, alpha: 0.6 });

  graphics
    .circle(stick.originX, stick.originY, ORIGIN_RADIUS_PX)
    .fill({ color: colors.idle, alpha: 0.5 });

  const dx = stick.x - stick.originX;
  const dy = stick.y - stick.originY;
  const distance = Math.hypot(dx, dy);

  // Обрезка по длине, а не по координатам: обрезав по осям, мы поменяли бы
  // направление, а его игрок и задаёт.
  const reach = distance === 0 ? 0 : Math.min(distance, MAX_REACH_PX) / distance;
  const knobX = stick.originX + dx * reach;
  const knobY = stick.originY + dy * reach;

  graphics
    .moveTo(stick.originX, stick.originY)
    .lineTo(knobX, knobY)
    .stroke({ width: 2, color: colors.self, alpha: 0.7 });

  graphics
    .circle(knobX, knobY, KNOB_RADIUS_PX)
    .fill({ color: colors.self, alpha: 0.18 })
    .stroke({ width: 2, color: colors.self, alpha: 0.9 });
};
