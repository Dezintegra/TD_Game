/**
 * Управление камерой.
 *
 * Временная мера на период, пока на карте нет генерала: когда он появится,
 * камера начнёт следовать за ним, а прямое управление останется только
 * как вспомогательное.
 *
 * Обработчики вешаются на элемент сцены и снимаются при остановке игры —
 * иначе после горячей перезагрузки на странице накопился бы десяток
 * параллельных подписок, и карта поехала бы вдесятеро быстрее.
 */
export interface CameraControlHandlers {
  pan(dx: number, dy: number): void;
  regenerate(): void;
}

/** Скорость прокрутки стрелками, экранных пикселей за кадр. */
const ARROW_PAN_SPEED = 18;

const ARROW_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export const attachCameraControls = (
  host: HTMLElement,
  handlers: CameraControlHandlers,
): (() => void) => {
  const pressed = new Set<string>();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let rafHandle = 0;

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    host.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;

    // Тянем карту, а не камеру: курсор должен «держать» точку под собой,
    // поэтому знак смещения обратный.
    handlers.pan(lastX - event.clientX, lastY - event.clientY);
    lastX = event.clientX;
    lastY = event.clientY;
  };

  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    if (host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key in ARROW_KEYS) {
      pressed.add(event.key);
      event.preventDefault();
      return;
    }

    if (event.key === 'r' || event.key === 'R' || event.key === 'к' || event.key === 'К') {
      handlers.regenerate();
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    pressed.delete(event.key);
  };

  // Стрелки обрабатываются в отдельном цикле, а не в обработчике нажатия:
  // автоповтор клавиатуры срабатывает с паузой и неравномерно, из-за чего
  // прокрутка дёргалась бы.
  const step = (): void => {
    if (pressed.size > 0) {
      let dx = 0;
      let dy = 0;

      for (const key of pressed) {
        const offset = ARROW_KEYS[key];
        if (offset === undefined) continue;
        dx += offset[0] * ARROW_PAN_SPEED;
        dy += offset[1] * ARROW_PAN_SPEED;
      }

      handlers.pan(dx, dy);
    }

    rafHandle = requestAnimationFrame(step);
  };

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  rafHandle = requestAnimationFrame(step);

  return () => {
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', onPointerUp);
    host.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    cancelAnimationFrame(rafHandle);
  };
};
