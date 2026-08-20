import { DIRECTION_STOP, StructureKind, UnitType, directionTowards } from '@td/shared';
import { screenToWorld } from './iso.js';

/**
 * Управление.
 *
 * Главное требование проекта — отзывчивость: любое действие игрока даёт
 * отклик в том же кадре. Поэтому здесь нет ни задержек, ни подтверждений:
 * нажатие сразу превращается в команду, команда сразу попадает в очередь
 * ближайшего тика.
 *
 * Клавиши читаются по `event.code`, а не по `event.key`. Разница
 * принципиальная: `key` зависит от раскладки, и на русской раскладке
 * WASD превращается в ЦФЫВ. `code` описывает физическую клавишу и
 * одинаков в любой раскладке.
 */

export interface ControlState {
  /** Что игрок собирается строить, либо null. */
  readonly buildKind: StructureKind | null;
  /** Игрок наводит ядерный удар. */
  readonly aimingNuke: boolean;
  /** Клетка под курсором, либо -1. */
  readonly hoverCell: number;
}

/**
 * Сколько юнитов заказывает одно нажатие с зажатым Ctrl.
 *
 * Десять, а не двадцать: очередь вмещает двадцать заказов, и одно нажатие
 * не должно забивать её целиком.
 */
export const BATCH_ORDER_COUNT = 10;

export interface ControlHandlers {
  setDirection(direction: number): void;
  build(cell: number, kind: StructureKind): void;
  /** Заказ юнита. `count` больше единицы — это пакет по Ctrl. */
  train(unitType: UnitType, count: number): void;
  setTarget(cell: number): void;
  nuke(cell: number): void;
  pan(dx: number, dy: number): void;
  /** Перенести камеру в клетку — по клику на миникарте. */
  jumpTo(cell: number): void;
  /** Вернуть камеру к генералу и включить слежение. */
  recentre(): void;
  cellAtScreen(x: number, y: number): number;
  minimapCellAtScreen(x: number, y: number): number;
}

export interface Controls {
  readonly state: ControlState;
  /** Программная смена режима — из кнопок HUD. */
  setBuildKind(kind: StructureKind | null): void;
  setAimingNuke(aiming: boolean): void;
  detach(): void;
}

/** Скорость прокрутки стрелками, экранных пикселей за кадр. */
const ARROW_PAN_SPEED = 18;

const ARROW_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Клавиши движения в ЭКРАННЫХ направлениях.
 *
 * Направления привязаны к экрану, а не к осям мира, и это требование
 * игрового замысла: в аксонометрии оси мира повёрнуты на сорок градусов,
 * и привязка к ним ощущается как рассинхрон руки и глаза. `W` должна
 * уводить генерала вверх по экрану, что бы это ни означало в координатах
 * мира.
 */
const MOVE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};

const BUILD_KEYS: Readonly<Record<string, StructureKind>> = {
  KeyQ: StructureKind.Wall,
  KeyE: StructureKind.TowerBasic,
  KeyR: StructureKind.TowerSniper,
};

const TRAIN_KEYS: Readonly<Record<string, UnitType>> = {
  Digit1: UnitType.Assault,
  Digit2: UnitType.Sniper,
  Digit3: UnitType.Grenadier,
};

const NUKE_KEY = 'KeyF';
const CANCEL_KEY = 'Escape';
const RECENTRE_KEY = 'Space';

/**
 * Экранное направление в направление мира.
 *
 * Проекция линейна, поэтому обратное преобразование, применённое
 * к смещению, даёт смещение в мире. Благодаря этому мы не заводим таблицу
 * «W — это северо-запад» и не переписываем её при смене угла проекции:
 * привязка выводится из самой проекции.
 */
const worldDirection = (screenX: number, screenY: number): number => {
  if (screenX === 0 && screenY === 0) return DIRECTION_STOP;

  const world = screenToWorld(screenX, screenY);
  return directionTowards(world.x, world.y);
};

export const attachControls = (host: HTMLElement, handlers: ControlHandlers): Controls => {
  const pressed = new Set<string>();

  let buildKind: StructureKind | null = null;
  let aimingNuke = false;
  let hoverCell = -1;

  let direction = DIRECTION_STOP;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let rafHandle = 0;

  const localPoint = (event: PointerEvent): { x: number; y: number } => {
    const box = host.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const syncDirection = (): void => {
    let screenX = 0;
    let screenY = 0;

    for (const code of pressed) {
      const offset = MOVE_KEYS[code];
      if (offset === undefined) continue;
      screenX += offset[0];
      screenY += offset[1];
    }

    const next = worldDirection(screenX, screenY);
    if (next === direction) return;

    direction = next;
    handlers.setDirection(next);
  };

  const cancelModes = (): void => {
    buildKind = null;
    aimingNuke = false;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;

    if (event.code in ARROW_KEYS) {
      pressed.add(event.code);
      event.preventDefault();
      return;
    }

    if (event.code in MOVE_KEYS) {
      pressed.add(event.code);
      syncDirection();
      return;
    }

    const build = BUILD_KEYS[event.code];
    if (build !== undefined) {
      // Повторное нажатие той же клавиши выключает режим: это дешевле,
      // чем тянуться к Escape, и потому именно так и будут делать.
      buildKind = buildKind === build ? null : build;
      aimingNuke = false;
      return;
    }

    const train = TRAIN_KEYS[event.code];
    if (train !== undefined) {
      // Пакет — это десять обычных заказов, а не отдельная команда. Ядро
      // проверяет каждый по отдельности, поэтому «заказать десять, когда
      // хватает на четыре» само собой превращается в четыре заказа.
      //
      // Модификаторов два, и это вынужденно. Ctrl с цифрой браузер
      // оставляет себе — это переключение вкладок, и до страницы событие
      // просто не доходит. Shift ничем не занят и работает всегда.
      const batch = event.ctrlKey || event.shiftKey;
      handlers.train(train, batch ? BATCH_ORDER_COUNT : 1);
      return;
    }

    if (event.code === NUKE_KEY) {
      aimingNuke = !aimingNuke;
      buildKind = null;
      return;
    }

    if (event.code === CANCEL_KEY) {
      cancelModes();
      return;
    }

    if (event.code === RECENTRE_KEY) {
      handlers.recentre();
      event.preventDefault();
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    pressed.delete(event.code);
    if (event.code in MOVE_KEYS) syncDirection();
  };

  /**
   * Потеря фокуса окном.
   *
   * Без этого зажатая клавиша остаётся «нажатой» навсегда: браузер
   * не пришлёт keyup, если фокус ушёл на другую вкладку, и генерал
   * будет бесконечно идти в стену.
   */
  const onBlur = (): void => {
    pressed.clear();
    syncDirection();
  };

  const onPointerDown = (event: PointerEvent): void => {
    const point = localPoint(event);

    if (event.button === 2) {
      const cell = handlers.cellAtScreen(point.x, point.y);
      if (cell >= 0) handlers.setTarget(cell);
      return;
    }

    if (event.button !== 0) return;

    const minimapCell = handlers.minimapCellAtScreen(point.x, point.y);
    if (minimapCell >= 0) {
      handlers.jumpTo(minimapCell);
      return;
    }

    if (aimingNuke) {
      const cell = handlers.cellAtScreen(point.x, point.y);
      if (cell >= 0) handlers.nuke(cell);
      aimingNuke = false;
      return;
    }

    if (buildKind !== null) {
      const cell = handlers.cellAtScreen(point.x, point.y);
      if (cell >= 0) handlers.build(cell, buildKind);
      return;
    }

    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    host.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    const point = localPoint(event);
    hoverCell = handlers.cellAtScreen(point.x, point.y);

    if (!dragging) return;

    const dx = lastX - event.clientX;
    const dy = lastY - event.clientY;

    // Тянем карту, а не камеру: курсор должен «держать» точку под собой,
    // поэтому знак смещения обратный.
    handlers.pan(dx, dy);
    lastX = event.clientX;
    lastY = event.clientY;
  };

  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    if (host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
  };

  const onContextMenu = (event: MouseEvent): void => {
    // Правая кнопка занята выбором цели, и системное меню поверх поля
    // в игре реального времени — чистая помеха.
    event.preventDefault();
  };

  // Стрелки обрабатываются в отдельном цикле, а не в обработчике нажатия:
  // автоповтор клавиатуры срабатывает с паузой и неравномерно, из-за чего
  // прокрутка дёргалась бы.
  const stepPan = (): void => {
    let dx = 0;
    let dy = 0;

    for (const code of pressed) {
      const offset = ARROW_KEYS[code];
      if (offset === undefined) continue;
      dx += offset[0] * ARROW_PAN_SPEED;
      dy += offset[1] * ARROW_PAN_SPEED;
    }

    if (dx !== 0 || dy !== 0) handlers.pan(dx, dy);

    rafHandle = requestAnimationFrame(stepPan);
  };

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerUp);
  host.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  rafHandle = requestAnimationFrame(stepPan);

  return {
    get state(): ControlState {
      return { buildKind, aimingNuke, hoverCell };
    },

    setBuildKind(kind) {
      buildKind = kind;
      if (kind !== null) aimingNuke = false;
    },

    setAimingNuke(aiming) {
      aimingNuke = aiming;
      if (aiming) buildKind = null;
    },

    detach() {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      cancelAnimationFrame(rafHandle);
    },
  };
};
