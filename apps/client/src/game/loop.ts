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
  /**
   * Длительность промежутка между кадрами, миллисекунды.
   *
   * Вызывается на каждом кадре, кроме самого первого: у него нет
   * предыдущего, и промежуток мерить не от чего.
   *
   * Существует потому, что **число кадров в секунду мерой плавности
   * не является**. Оно усредняет ровно так же, как минутные графики
   * виртуальной машины: один кадр длиной в двести миллисекунд опускает
   * шестьдесят кадров до пятидесяти пяти, и рывок, ради которого всё
   * затевалось, в это число не попадает. Рывок живёт в хвосте
   * распределения, и увидеть его можно только распределением.
   */
  readonly onFrameGap?: (ms: number) => void;
}

export const createRenderLoop = (options: RenderLoopOptions): RenderLoop => {
  let handle = 0;
  let running = false;
  let framesInSecond = 0;
  let windowStart = 0;
  let previousFrameMs = Number.NaN;

  const frame = (now: number): void => {
    if (!running) return;

    // Промежуток берётся из `now`, который браузер и так передаёт
    // аргументом: нового обращения к часам не появляется вовсе.
    if (!Number.isNaN(previousFrameMs)) options.onFrameGap?.(now - previousFrameMs);
    previousFrameMs = now;

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
      // Промежуток после паузы измерялся бы от кадра до остановки —
      // то есть показал бы длительность паузы, а не рывок отрисовки.
      previousFrameMs = Number.NaN;
      handle = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(handle);
    },
  };
};
