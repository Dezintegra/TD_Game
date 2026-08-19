import { TICKS_PER_SECOND } from '@td/shared';
import { rockPercent } from '@td/sim';
import { createGameLoop } from './loop.js';
import { createNetClient } from './net.js';
import { createScene } from './scene.js';
import { visibleMapPercent } from './iso.js';
import { hudActions } from './store.js';
import { attachCameraControls } from './controls.js';

/**
 * Сборка игры воедино: сцена, цикл, сеть, управление.
 *
 * Живёт вне React намеренно. React-компоненты монтируются и размонтируются
 * по своим правилам, а игровой цикл должен пережить любую перерисовку HUD,
 * включая горячую перезагрузку при разработке.
 */
export interface Game {
  stop(): void;
}

const WS_URL = import.meta.env['VITE_WS_URL'] ?? 'ws://127.0.0.1:3001/game';

/** Стартовый seed. Пока матчей нет, берём фиксированный — так карта воспроизводима. */
const INITIAL_SEED = 1337;

export const startGame = async (host: HTMLElement): Promise<Game> => {
  const scene = await createScene(host);
  const net = createNetClient(WS_URL);

  let seed = INITIAL_SEED;

  const loop = createGameLoop({
    seed,

    onTick: (world) => {
      hudActions.setTick(world.tick);

      // Пингуем раз в секунду: этого достаточно для оценки задержки
      // и не создаёт лишнего трафика.
      if (world.tick % TICKS_PER_SECOND === 0) {
        net.ping(world.tick);
      }
    },

    onRender: (world) => {
      // setMap перестраивает геометрию только при смене карты, поэтому
      // безопасно вызывать его каждый кадр.
      scene.setMap(world.map);
    },

    onFps: (fps) => hudActions.setFps(fps),
  });

  const publishMapInfo = (): void => {
    const { width, height } = scene.viewportSize;
    hudActions.setMapInfo(seed, visibleMapPercent(width, height), rockPercent(loop.world.map));
  };

  const onResize = (): void => {
    scene.resize();
    publishMapInfo();
  };
  window.addEventListener('resize', onResize);

  const detachControls = attachCameraControls(host, {
    pan: (dx, dy) => scene.panBy(dx, dy),
    regenerate: () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      loop.reset(seed);
      publishMapInfo();
    },
  });

  net.connect();
  loop.start();
  publishMapInfo();

  return {
    stop() {
      window.removeEventListener('resize', onResize);
      detachControls();
      loop.stop();
      net.disconnect();
      scene.destroy();
    },
  };
};
