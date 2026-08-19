import { Application, Container, Graphics } from 'pixi.js';
import { FIELD_HEIGHT_CELLS, FIELD_WIDTH_CELLS, unitsToCells } from '@td/shared';
import type { WorldState } from '@td/sim';

/**
 * Сцена PixiJS: всё, что рисуется на игровом поле.
 *
 * React сюда не заглядывает. Это принципиально: поле обновляется
 * каждый кадр, и прогон таких обновлений через виртуальный DOM
 * съел бы весь бюджет времени. PixiJS рисует через WebGL, батчит
 * спрайты и держит тысячи объектов на стабильных 60 кадрах.
 *
 * Цвета берём из тех же дизайн-токенов, что и HUD, — читаем их
 * из CSS. Так палитра остаётся в одном месте, а не расползается
 * по двум рендерерам.
 */
export interface Scene {
  /** Перерисовывает мир. alpha — доля между тиками для интерполяции. */
  render(world: WorldState, alpha: number): void;
  resize(): void;
  destroy(): void;
}

const readToken = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
};

/** Переводит цвет из CSS в число, понятное PixiJS. */
const toPixiColor = (cssColor: string, fallback: number): number => {
  const match = /^#([0-9a-f]{6})$/i.exec(cssColor);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 16) : fallback;
};

export const createScene = async (host: HTMLElement): Promise<Scene> => {
  const app = new Application();

  await app.init({
    background: toPixiColor(readToken('--td-bg-page', '#191919'), 0x191919),
    antialias: true,
    // Учитываем плотность пикселей монитора, иначе на ретине картинка мылит.
    resolution: window.devicePixelRatio,
    autoDensity: true,
    resizeTo: host,
  });

  host.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);

  const grid = new Graphics();
  const entities = new Graphics();
  world.addChild(grid, entities);

  const accentColor = toPixiColor(readToken('--td-accent', '#00ff29'), 0x00ff29);

  /** Сколько экранных пикселей приходится на одну клетку поля. */
  let cellSize = 32;

  const layout = (): void => {
    // Вписываем поле в окно целиком, сохраняя пропорции.
    cellSize = Math.floor(
      Math.min(app.screen.width / FIELD_WIDTH_CELLS, app.screen.height / FIELD_HEIGHT_CELLS),
    );

    world.x = Math.floor((app.screen.width - cellSize * FIELD_WIDTH_CELLS) / 2);
    world.y = Math.floor((app.screen.height - cellSize * FIELD_HEIGHT_CELLS) / 2);

    drawGrid();
  };

  const drawGrid = (): void => {
    grid.clear();

    for (let x = 0; x <= FIELD_WIDTH_CELLS; x += 1) {
      grid
        .moveTo(x * cellSize, 0)
        .lineTo(x * cellSize, FIELD_HEIGHT_CELLS * cellSize)
        // Каждая четвёртая линия ярче: так глаз считывает расстояния
        // без линейки, что важно при выборе места под башню.
        .stroke({ width: 1, color: 0xffffff, alpha: x % 4 === 0 ? 0.09 : 0.05 });
    }

    for (let y = 0; y <= FIELD_HEIGHT_CELLS; y += 1) {
      grid
        .moveTo(0, y * cellSize)
        .lineTo(FIELD_WIDTH_CELLS * cellSize, y * cellSize)
        .stroke({ width: 1, color: 0xffffff, alpha: y % 4 === 0 ? 0.09 : 0.05 });
    }
  };

  layout();

  return {
    render(state) {
      entities.clear();

      for (const tower of state.towers) {
        const x = unitsToCells(tower.position.x) * cellSize + cellSize / 2;
        const y = unitsToCells(tower.position.y) * cellSize + cellSize / 2;

        entities
          .circle(x, y, cellSize * 0.32)
          .fill({ color: accentColor, alpha: 0.18 })
          .stroke({ width: 2, color: accentColor, alpha: 0.9 });
      }

      for (const creep of state.creeps) {
        const x = unitsToCells(creep.position.x) * cellSize;
        const y = unitsToCells(creep.position.y) * cellSize;

        entities.circle(x, y, cellSize * 0.2).fill({ color: 0xff5c5c, alpha: 0.85 });
      }
    },

    resize() {
      layout();
    },

    destroy() {
      app.destroy(true, { children: true });
    },
  };
};
