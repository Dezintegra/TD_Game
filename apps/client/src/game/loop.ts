/**
 * Цикл отрисовки.
 *
 * Раньше здесь жил и счёт мира: цикл держал состояние, копил время
 * в накопителе и вызывал `step` фиксированными шагами. Теперь мир считает
 * сервер, а сюда он приезжает кадрами команд, поэтому от прежнего цикла
 * осталась ровно одна обязанность — рисовать со скоростью монитора.
 *
 * Почему разделение важно. Мир обязан идти в одном темпе у всех: игрок
 * со стодвадцатигерцовым монитором не должен жить вдвое быстрее соперника.
 * Пока темп задавал браузер, это держалось на дисциплине накопителя;
 * теперь оно верно по построению, потому что тик считает не браузер.
 *
 * Частота кадров при этом остаётся частотой монитора: рендер ни на что
 * не ждёт и вызывается каждый раз, когда браузер готов показать кадр.
 */
export interface RenderLoop {
  start(): void;
  stop(): void;
}

export interface RenderLoopOptions {
  /** Вызывается на каждом кадре отрисовки. */
  readonly onFrame: () => void;
  readonly onFps?: (fps: number) => void;
}

export const createRenderLoop = (options: RenderLoopOptions): RenderLoop => {
  let handle = 0;
  let running = false;
  let framesInSecond = 0;
  let windowStart = 0;

  const frame = (now: number): void => {
    if (!running) return;

    options.onFrame();

    framesInSecond += 1;
    if (now - windowStart >= 1000) {
      options.onFps?.(framesInSecond);
      framesInSecond = 0;
      windowStart = now;
    }

    handle = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) return;
      running = true;
      windowStart = performance.now();
      handle = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(handle);
    },
  };
};
