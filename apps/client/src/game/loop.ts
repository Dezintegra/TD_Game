import { MS_PER_TICK } from '@td/shared';
import { createWorld, step } from '@td/sim';
import type { Command } from '@td/shared';
import type { WorldState } from '@td/sim';

/**
 * Игровой цикл с фиксированным шагом симуляции.
 *
 * Разберём главную идею, потому что она неочевидна и очень важна.
 *
 * Монитор обновляется с произвольной частотой: 60 Гц, 120 Гц, а при
 * просадке — вообще неравномерно. Если считать физику «на каждый кадр»,
 * то у игрока со 120-герцовым монитором мир будет жить вдвое быстрее.
 * В PvP это прямое преимущество за счёт железа, что недопустимо.
 *
 * Поэтому мир считается строго фиксированными шагами (у нас 30 раз
 * в секунду), а рендер идёт со скоростью монитора. Между двумя тиками
 * картинка интерполируется — отсюда параметр alpha в onRender.
 *
 * Накопитель (accumulator) хранит «недосчитанное» время: если между
 * кадрами прошло 50 мс, а тик длится 33 мс, то выполнится один тик,
 * а остаток 17 мс перенесётся на следующий кадр.
 */
export interface GameLoop {
  start(): void;
  stop(): void;
  /** Ставит команду в очередь на ближайший тик. */
  enqueue(command: Command): void;
  readonly world: WorldState;
}

export interface GameLoopOptions {
  readonly seed: number;
  /** Вызывается после каждого тика симуляции. */
  onTick?: (world: WorldState) => void;
  /**
   * Вызывается на каждом кадре отрисовки.
   * alpha — доля от 0 до 1, показывающая, насколько мы «между» тиками.
   */
  onRender?: (world: WorldState, alpha: number) => void;
  onFps?: (fps: number) => void;
}

/**
 * Предохранитель: если вкладка была свёрнута, между кадрами могут
 * пройти минуты. Без ограничения цикл попытается досчитать тысячи
 * тиков разом и подвесит браузер. Больше пяти тиков за кадр не считаем.
 */
const MAX_TICKS_PER_FRAME = 5;

export const createGameLoop = (options: GameLoopOptions): GameLoop => {
  let world = createWorld(options.seed);
  let pending: Command[] = [];
  let accumulator = 0;
  let lastTime = 0;
  let frameHandle = 0;
  let running = false;

  let framesInSecond = 0;
  let fpsWindowStart = 0;

  const frame = (now: number): void => {
    if (!running) return;

    const delta = now - lastTime;
    lastTime = now;
    accumulator += delta;

    let ticksThisFrame = 0;
    while (accumulator >= MS_PER_TICK && ticksThisFrame < MAX_TICKS_PER_FRAME) {
      const commands = pending;
      pending = [];

      world = step(world, commands);
      accumulator -= MS_PER_TICK;
      ticksThisFrame += 1;

      options.onTick?.(world);
    }

    // Вкладка была неактивна слишком долго — сбрасываем накопитель,
    // иначе он будет вечно тянуть за собой долг по тикам.
    if (accumulator > MS_PER_TICK * MAX_TICKS_PER_FRAME) {
      accumulator = 0;
    }

    options.onRender?.(world, accumulator / MS_PER_TICK);

    framesInSecond += 1;
    if (now - fpsWindowStart >= 1000) {
      options.onFps?.(framesInSecond);
      framesInSecond = 0;
      fpsWindowStart = now;
    }

    frameHandle = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastTime = performance.now();
      fpsWindowStart = lastTime;
      frameHandle = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(frameHandle);
    },
    enqueue(command) {
      pending.push(command);
    },
    get world() {
      return world;
    },
  };
};
