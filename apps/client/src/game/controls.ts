import { AttackStance, DIRECTION_STOP, StructureKind, UnitType, directionTowards } from '@td/shared';
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
  /**
   * Включён режим строительства.
   *
   * Отдельно от выбранного вида, и это не дублирование. Режим включается
   * клавишей `Q` и сразу показывает круг радиуса — то есть отвечает
   * на вопрос «докуда я дотянусь» ДО того, как игрок решил, что ставить.
   * Вид выбирается уже внутри режима, цифрой.
   */
  readonly building: boolean;
  /** Что игрок собирается строить, либо null. */
  readonly buildKind: StructureKind | null;
  /** Игрок наводит ядерный удар. */
  readonly aimingNuke: boolean;
  /** Клетка под курсором, либо -1. */
  readonly hoverCell: number;
  /**
   * Клетка с выделенным объектом, либо -1.
   *
   * Выделение — состояние интерфейса одного игрока: по сети
   * не передаётся, в состояние мира не попадает, в контрольную сумму
   * не входит. Поэтому живёт здесь, рядом с выбранным видом постройки
   * и режимом наведения удара.
   */
  readonly selectedCell: number;
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
  /** Сменить режим атаки войска. */
  setStance(stance: number): void;
  nuke(cell: number): void;
  pan(dx: number, dy: number): void;
  /** Перенести камеру в клетку — по клику на миникарте. */
  jumpTo(cell: number): void;
  /** Вернуть камеру к генералу и включить слежение. */
  recentre(): void;
  /** Выделить объект в клетке, либо снять выделение при -1. */
  select(cell: number): void;
  /**
   * Меню матча открылось или закрылось.
   *
   * Управление владеет этим состоянием само, потому что от него зависит,
   * разбирать ли нажатия. Наружу оно только сообщается — HUD должен знать,
   * что рисовать.
   */
  menuChanged(open: boolean): void;
  /** Игрок свернул или развернул характеристики в тулбаре. */
  toggleStats(): void;
  cellAtScreen(x: number, y: number): number;
  minimapCellAtScreen(x: number, y: number): number;
}

export interface Controls {
  readonly state: ControlState;
  /**
   * Программная смена вида постройки — из плиток тулбара.
   *
   * Выбор вида включает и сам режим: игрок, нажавший плитку стены,
   * собирается строить, и требовать от него ещё и `Q` было бы придиркой.
   */
  setBuildKind(kind: StructureKind | null): void;
  setAimingNuke(aiming: boolean): void;
  /** Программное открытие и закрытие меню — из кнопок HUD. */
  setMenuOpen(open: boolean): void;
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

/**
 * Цифры. Что они значат — зависит от режима, и это единственное место,
 * где смысл клавиши меняется.
 *
 * Вне режима строительства цифра заказывает юнита, внутри — выбирает вид
 * постройки. Порядок в обоих списках совпадает с порядком плиток
 * в тулбаре: третья слева плитка и третья цифра — одно и то же.
 *
 * Почему режим заведён для стройки и НЕ заведён для юнитов. Режим меняет
 * смысл нажатия мышью: левая кнопка ставит постройку вместо того, чтобы
 * выделять объект. У заказа юнита нажатия по полю нет вовсе — размещать
 * нечего, — и режим не дал бы ничего, кроме лишнего нажатия на самом
 * частом действии матча.
 */
const SLOT_KEYS: readonly string[] = ['Digit1', 'Digit2', 'Digit3'];

const SLOT_UNITS: readonly UnitType[] = [UnitType.Assault, UnitType.Sniper, UnitType.Tesla];

const SLOT_STRUCTURES: readonly StructureKind[] = [
  StructureKind.Wall,
  StructureKind.TowerBasic,
  StructureKind.TowerSniper,
];

/**
 * Клавиши режима атаки.
 *
 * Z и X свободны, лежат подряд и сами по себе выглядят переключателем.
 */
const STANCE_KEYS: Readonly<Record<string, AttackStance>> = {
  KeyZ: AttackStance.Breakthrough,
  KeyX: AttackStance.Engage,
};

/** Войти в режим строительства и выйти из него. */
const BUILD_MODE_KEY = 'KeyQ';
const UNITS_MODE_KEY = 'KeyE';

/** Свернуть и развернуть характеристики в тулбаре. */
const STATS_KEY = 'KeyR';

const NUKE_KEY = 'KeyF';
const CANCEL_KEY = 'Escape';
const RECENTRE_KEY = 'Space';

export interface ControlHint {
  /** Как группа клавиш называется для игрока. */
  readonly keys: string;
  readonly what: string;
  /**
   * Коды клавиш, которые сюда попадают. Пусто у мыши и у модификаторов:
   * отдельными клавишами они не разбираются.
   */
  readonly codes: readonly string[];
}

/**
 * Раскладка управления — одной таблицей.
 *
 * Отсюда и разбираются нажатия, и строится перечень горячих клавиш
 * в меню матча. Две таблицы — одна для разбора, другая для показа —
 * разошлись бы при первой же правке, и игрок читал бы подсказку, которая
 * врёт. Заметить это трудно: врущая подсказка выглядит достоверной,
 * и сверять её нечем.
 *
 * Коды берутся из тех же констант, по которым идёт разбор, а не
 * переписываются сюда строками.
 */
export const CONTROL_LAYOUT: readonly ControlHint[] = [
  { keys: 'WASD', what: 'движение генерала', codes: Object.keys(MOVE_KEYS) },
  { keys: 'Стрелки', what: 'прокрутка карты', codes: Object.keys(ARROW_KEYS) },
  {
    keys: '1 2 3',
    what: 'заказать юнита; в режиме стройки — выбрать постройку',
    codes: SLOT_KEYS,
  },
  // Ctrl+цифра браузер оставляет себе — это переключение вкладок,
  // и перехватить его со страницы нельзя. Поэтому у пакета два
  // модификатора: Ctrl работает по кнопке панели, Shift — и по кнопке,
  // и с клавиатуры.
  { keys: 'Shift + цифра', what: 'заказать сразу десять', codes: [] },
  { keys: 'Q', what: 'режим строительства', codes: [BUILD_MODE_KEY] },
  { keys: 'E', what: 'выйти из режима строительства', codes: [UNITS_MODE_KEY] },
  { keys: 'R', what: 'свернуть характеристики', codes: [STATS_KEY] },
  { keys: 'F', what: 'ядерный удар', codes: [NUKE_KEY] },
  { keys: 'Z X', what: 'режим атаки: прорыв, бой', codes: Object.keys(STANCE_KEYS) },
  { keys: 'ЛКМ', what: 'поставить выбранное либо выделить', codes: [] },
  { keys: 'ПКМ', what: 'назначить цель атаки', codes: [] },
  { keys: 'Пробел', what: 'камера к генералу', codes: [RECENTRE_KEY] },
  { keys: 'Esc', what: 'отменить режим, иначе меню', codes: [CANCEL_KEY] },
];

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

  let building = false;
  let buildKind: StructureKind | null = null;
  let aimingNuke = false;
  let hoverCell = -1;
  let selectedCell = -1;

  let direction = DIRECTION_STOP;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let rafHandle = 0;
  let menuOpen = false;

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

  /**
   * Снять всё, что игрок мог «включить».
   *
   * Возвращает признак того, что снимать было что. От него зависит второе
   * значение Esc: меню открывается только тогда, когда отменять нечего.
   * Иначе меню перехватывало бы Esc всегда и отняло бы у игрока привычный
   * способ передумать — а передумывает он в разы чаще, чем открывает меню.
   */
  /**
   * Включить или выключить режим строительства.
   *
   * Выход из режима снимает и выбранный вид: круг исчез, значит строить
   * больше нечем, и оставленный вид сработал бы на следующем нажатии
   * мышью — то есть поставил бы постройку, которую игрок уже передумал
   * ставить.
   */
  const setBuilding = (on: boolean): void => {
    building = on;
    if (!on) buildKind = null;
    else aimingNuke = false;
  };

  const cancelModes = (): boolean => {
    const had = building || buildKind !== null || aimingNuke || selectedCell >= 0;

    setBuilding(false);
    aimingNuke = false;
    // Esc снимает и выделение: игрок нажимает его, чтобы «ничего
    // не было выбрано», и оставлять подсветку на поле было бы обманом.
    if (selectedCell >= 0) {
      selectedCell = -1;
      handlers.select(-1);
    }

    return had;
  };

  /**
   * Открыть или закрыть меню матча.
   *
   * При открытии набор нажатых клавиш очищается и направление
   * пересчитывается — тем же способом, что при потере фокуса окном.
   * Без этого генерал, шедший с зажатой W, продолжал бы идти, пока игрок
   * читает меню: браузер не пришлёт keyup за то время, что клавиши
   * не разбираются.
   */
  const setMenu = (open: boolean): void => {
    if (menuOpen === open) return;

    menuOpen = open;

    if (open) {
      pressed.clear();
      syncDirection();
    }

    handlers.menuChanged(open);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;

    // Пока меню открыто, из всей клавиатуры действует один Esc — он его
    // и закрывает. Разбирать остальное значило бы двигать генерала
    // и заказывать войска, пока игрок читает список горячих клавиш.
    if (menuOpen) {
      if (event.code === CANCEL_KEY) setMenu(false);
      return;
    }

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

    if (event.code === BUILD_MODE_KEY) {
      // Повторное нажатие выключает режим: это дешевле, чем тянуться
      // к Escape, и потому именно так и будут делать.
      setBuilding(!building);
      return;
    }

    if (event.code === UNITS_MODE_KEY) {
      // «Вернуться к юнитам». Отдельная клавиша, хотя `Q` делает то же
      // самое: у неё другой смысл в голове игрока — не «передумал»,
      // а «хочу заказывать войска», — и после серии построек рука тянется
      // именно к ней.
      setBuilding(false);
      return;
    }

    if (event.code === STATS_KEY) {
      handlers.toggleStats();
      return;
    }

    const slot = SLOT_KEYS.indexOf(event.code);
    if (slot >= 0) {
      if (building) {
        buildKind = SLOT_STRUCTURES[slot] ?? null;
        aimingNuke = false;
        return;
      }

      const unit = SLOT_UNITS[slot];
      if (unit === undefined) return;

      // Пакет — это десять обычных заказов, а не отдельная команда. Ядро
      // проверяет каждый по отдельности, поэтому «заказать десять, когда
      // хватает на четыре» само собой превращается в четыре заказа.
      //
      // Модификаторов два, и это вынужденно. Ctrl с цифрой браузер
      // оставляет себе — это переключение вкладок, и до страницы событие
      // просто не доходит. Shift ничем не занят и работает всегда.
      const batch = event.ctrlKey || event.shiftKey;
      handlers.train(unit, batch ? BATCH_ORDER_COUNT : 1);
      return;
    }

    const stance = STANCE_KEYS[event.code];
    if (stance !== undefined) {
      handlers.setStance(stance);
      return;
    }

    if (event.code === NUKE_KEY) {
      aimingNuke = !aimingNuke;
      if (aimingNuke) setBuilding(false);
      return;
    }

    if (event.code === CANCEL_KEY) {
      // Сначала отмена, и только если отменять нечего — меню.
      if (!cancelModes()) setMenu(true);
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
    // Меню накрывает поле собой, поэтому нажатие сюда и так не дойдёт.
    // Проверка стоит на случай, если меню когда-нибудь станет уже поля:
    // строить вслепую под открытым меню игрок не просил.
    if (menuOpen) return;

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

    // Левая кнопка БЕЗ выбранного вида постройки выделяет объект под
    // курсором. Свободного нажатия у нас нет, и придумывать третью кнопку
    // не хочется; зато в этом состоянии левая кнопка до сих пор не делала
    // ничего — новое поведение занимает пустоту, а не отбирает
    // существующее. Пока вид постройки выбран, левая кнопка строит,
    // как строила.
    const picked = handlers.cellAtScreen(point.x, point.y);
    if (picked >= 0) {
      // Повторный щелчок по выделенному снимает выделение: так же,
      // как повторное нажатие клавиши постройки выключает режим.
      selectedCell = selectedCell === picked ? -1 : picked;
      handlers.select(selectedCell);
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
      return { building, buildKind, aimingNuke, hoverCell, selectedCell };
    },

    setBuildKind(kind) {
      // Нажатие плитки в тулбаре включает и сам режим: игрок, выбравший
      // стену, собирается строить, и требовать от него ещё и `Q` было бы
      // придиркой.
      setBuilding(kind !== null);
      buildKind = kind;
    },

    setAimingNuke(aiming) {
      aimingNuke = aiming;
      if (aiming) setBuilding(false);
    },

    setMenuOpen(open) {
      setMenu(open);
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
