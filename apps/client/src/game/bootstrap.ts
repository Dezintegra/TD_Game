import { TICKS_PER_SECOND } from '@td/shared';
import { createGameLoop } from './loop.js';
import { createNetClient } from './net.js';
import { createScene } from './scene.js';
import { hudActions } from './store.js';

/**
 * Сборка игры воедино: сцена, цикл, сеть.
 *
 * Живёт вне React намеренно. React-компоненты монтируются и
 * размонтируются по своим правилам, а игровой цикл должен пережить
 * любую перерисовку HUD, включая горячую перезагрузку при разработке.
 */
export interface Game {
  stop(): void;
}

const WS_URL = import.meta.env['VITE_WS_URL'] ?? 'ws://127.0.0.1:3001/game';

export const startGame = async (host: HTMLElement): Promise<Game> => {
  const scene = await createScene(host);
  const net = createNetClient(WS_URL);

  const loop = createGameLoop({
    seed: 1337,

    onTick: (world) => {
      hudActions.setTick(world.tick);

      // Пингуем раз в секунду: этого достаточно для оценки задержки
      // и не создаёт лишнего трафика.
      if (world.tick % TICKS_PER_SECOND === 0) {
        net.ping(world.tick);
      }
    },

    onRender: (world, alpha) => scene.render(world, alpha),
    onFps: (fps) => hudActions.setFps(fps),
  });

  const onResize = (): void => scene.resize();
  window.addEventListener('resize', onResize);

  net.connect();
  loop.start();

  return {
    stop() {
      window.removeEventListener('resize', onResize);
      loop.stop();
      net.disconnect();
      scene.destroy();
    },
  };
};
