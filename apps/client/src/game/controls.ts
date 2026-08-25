import {
  AttackStance,
  DIRECTION_STOP,
  StructureKind,
  UnitType,
  directionTowards,
} from '@td/shared';
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

/**
 * Замирающий свайп: где палец опустился и где он сейчас.
 *
 * «Замирающий» — ключевое свойство, и оно про то, чего у мыши нет.
 * Свайп не кончается вместе с движением пальца: держать направление,
 * непрерывно водя пальцем, физически невозможно, а держать его
 * неподвижным пальцем — единственный способ идти долго.
 */
export interface TouchStick {
  /** Точка, где палец опустился. Здесь встаёт центр джойстика. */
  readonly originX: number;
  readonly originY: number;
  /** Где палец сейчас. */
  readonly x: number;
  readonly y: number;
  /** Сдвиг превысил порог: джойстик включён и ведёт генерала. */
  readonly engaged: boolean;
}

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
  /**
   * Игрок наводит цель атаки.
   *
   * Существует ради касания: цель ставит правая кнопка мыши, а у пальца
   * кнопок нет вовсе. Устроено как наведение удара — нажал, ткнул
   * клетку, режим снялся, — потому что грамматика у них одна.
   */
  readonly aimingTarget: boolean;
  /**
   * Джойстик замирающего свайпа, либо null.
   *
   * Координаты экранные, относительно контейнера сцены. Состояние
   * интерфейса одного игрока: по сети не уходит, в мир не попадает,
   * в контрольную сумму не входит — как выделение и режимы.
   *
   * Хранится здесь, а не в store, по той же причине, по какой там нет
   * позиций сущностей: палец двигается до шестидесяти раз в секунду,
   * и возить его через React значило бы перерисовывать дерево
   * с той же частотой. До сцены оно доезжает снимком намерения.
   */
  readonly touch: TouchStick | null;
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
  /**
   * Приблизить или отдалить относительно точки на экране.
   *
   * `factor` больше единицы приближает, меньше — отдаляет. Границы
   * диапазона держит сцена: управление сообщает жест, а не результат,
   * и о том, докуда можно приблизиться, знать не должно.
   */
  zoom(factor: number, anchorX: number, anchorY: number): void;
  /** Перенести камеру в клетку — по клику на миникарте. */
  jumpTo(cell: number): void;
  /** Вернуть камеру к генералу и включить слежение. */
  recentre(): void;
  /** Выключить или включить звук целиком. */
  toggleSound(): void;
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
  /** Игрок свернул или развернул прокачку. */
  toggleStats(): void;
  /**
   * Закрыть прокачку, если она сейчас панель поверх поля.
   *
   * Возвращает `true`, если панель действительно закрыли. Разбор нажатий
   * сам о панели не знает и знать не должен: вопрос «панель или столбцы»
   * решается размером экрана, а порог экрана записан один раз — в CSS.
   */
  closeUpgradePanel(): boolean;
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
  /** Программное наведение цели атаки — из плитки тулбара. */
  setAimingTarget(aiming: boolean): void;
  /** Программное открытие и закрытие меню — из кнопок HUD. */
  setMenuOpen(open: boolean): void;
  detach(): void;
}

/** Скорость прокрутки стрелками, экранных пикселей за кадр. */
const ARROW_PAN_SPEED = 18;

/**
 * Насколько одна «щёлка» колеса меняет масштаб.
 *
 * Колесо приходит в разных единицах: пиксели, строки, страницы. Единицы
 * приводятся к пикселям, а пиксели — к множителю через показательную
 * функцию, и это не украшение. Приближение по своей природе умножается:
 * шаг «плюс 0,1 к масштабу» на дефолте 0,611 даёт прибавку в шестнадцать
 * процентов, а на четырёхкратном — в четыре. Показательная функция даёт
 * одинаковый шаг ощущений на любом масштабе.
 *
 * 0,0015 подобрано так, чтобы обычная щёлка мыши (около 100 точек)
 * меняла масштаб примерно на шестую часть: заметно, но не прыжком.
 */
const WHEEL_ZOOM_RATE = 0.0015;

/** Строка колеса в пикселях, когда браузер меряет строками. */
const WHEEL_LINE_PX = 16;

/** Страница колеса в пикселях, когда браузер меряет страницами. */
const WHEEL_PAGE_PX = 400;

/**
 * Расстояние между пальцами, ниже которого щипок не считается.
 *
 * Сведённые вплотную пальцы дают расстояние около нуля, и деление
 * на него превращает любую дрожь в скачок масштаба во много раз.
 */
const PINCH_MIN_SPAN_PX = 16;

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

/**
 * Насколько палец должен уехать, чтобы это считалось свайпом, а не тапом.
 *
 * Шестнадцать точек — примерно половина подушечки пальца. Меньше — и
 * любой тап уводил бы генерала: палец при нажатии всегда чуть едет.
 * Больше — и свайп пришлось бы начинать с размаха.
 *
 * Порог служит сразу двум делам, и это не совпадение, а причина, по
 * которой он один: он же отделяет «палец что-то делает» от «палец
 * указал клетку». За порогом действие по отрыву уже не выполняется.
 */
const TOUCH_STICK_THRESHOLD_PX = 16;

const NUKE_KEY = 'KeyF';
const CANCEL_KEY = 'Escape';
const RECENTRE_KEY = 'Space';
const MUTE_KEY = 'KeyM';

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
  { keys: 'M', what: 'выключить звук', codes: [MUTE_KEY] },
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
  let aimingTarget = false;
  let hoverCell = -1;
  let selectedCell = -1;

  /** Замирающий свайп. Живёт только пока палец на экране. */
  let stick: TouchStick | null = null;

  /**
   * Пальцы, лежащие на поле прямо сейчас.
   *
   * Одного `stick` для щипка мало: он знает про один палец и про точку
   * отсчёта, а щипку нужны оба положения разом. Список ведётся только
   * для касаний — у мыши указатель всегда один, и заводить ей запись
   * значило бы держать состояние, которое некому менять.
   */
  const touches = new Map<number, { x: number; y: number }>();

  /**
   * Расстояние между пальцами на прошлом событии, либо null.
   *
   * Не «включён ли щипок», а именно расстояние: щипок ведёт масштаб
   * отношением нового расстояния к прошлому, и хранить надо то, с чем
   * сравнивают.
   */
  let pinchSpan: number | null = null;

  let direction = DIRECTION_STOP;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let rafHandle = 0;
  let menuOpen = false;

  /**
   * Захват указателя — удобство, а не условие.
   *
   * Он нужен затем, чтобы события продолжали приходить, когда палец
   * или курсор ушли за край элемента: без захвата свайп, доехавший
   * до края экрана, обрывается на полпути.
   *
   * Но если захвата нет — метода не оказалось, указатель уже отпущен,
   * браузер отказал, — жест обязан продолжать работать. Уронить весь
   * разбор нажатия из-за неудавшегося удобства значит потерять ввод
   * целиком там, где он лишь ухудшился бы.
   */
  const capture = (pointerId: number): void => {
    try {
      host.setPointerCapture?.(pointerId);
    } catch {
      // Захват не удался — жест идёт дальше без него.
    }
  };

  const releaseCapture = (pointerId: number): void => {
    try {
      if (host.hasPointerCapture?.(pointerId) === true) host.releasePointerCapture(pointerId);
    } catch {
      // Освобождать нечего.
    }
  };

  // Принимает любое событие указателя: колесу нужна та же арифметика,
  // что и пальцу, а общего предка у них только координаты окна.
  const localPoint = (event: {
    readonly clientX: number;
    readonly clientY: number;
  }): { x: number; y: number } => {
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
  /**
   * Снять выделение объекта.
   *
   * Одна функция на все случаи, и это условие работоспособности правила.
   * Разложи снятие по трём обработчикам порознь — четвёртый режим,
   * когда он появится, про выделение забудет, и заметит это не автор,
   * а игрок посреди боя.
   */
  const clearSelection = (): void => {
    if (selectedCell < 0) return;

    selectedCell = -1;
    handlers.select(-1);
  };

  const setBuilding = (on: boolean): void => {
    building = on;
    if (!on) buildKind = null;
    else {
      aimingNuke = false;
      // Игрок собрался строить, значит следующее нажатие по полю значит
      // не «выбери», а «поставь». Окно сведений в этот момент закрывает
      // ему клетки — на телефоне заметную их часть, — и закрывает ровно
      // тогда, когда он прицеливается.
      clearSelection();
    }
  };

  /**
   * Наведение ядерного удара.
   *
   * Единственный вход в режим: и клавиша, и плитка тулбара идут сюда.
   * Пока их было двое, каждая помнила свой набор того, что надо погасить,
   * и наборы разошлись.
   */
  const setNukeAiming = (on: boolean): void => {
    aimingNuke = on;
    if (!on) return;

    aimingTarget = false;
    setBuilding(false);
    clearSelection();
  };

  /** Наведение цели атаки. Единственный вход в режим — как у удара. */
  const setTargetAiming = (on: boolean): void => {
    aimingTarget = on;
    if (!on) return;

    aimingNuke = false;
    setBuilding(false);
    clearSelection();
  };

  const cancelModes = (): boolean => {
    const had = building || buildKind !== null || aimingNuke || aimingTarget || selectedCell >= 0;

    setBuilding(false);
    aimingNuke = false;
    aimingTarget = false;
    // Esc снимает и выделение: игрок нажимает его, чтобы «ничего
    // не было выбрано», и оставлять подсветку на поле было бы обманом.
    clearSelection();

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

      // Пальцы забываются вместе с клавишами, и по той же причине:
      // пока игрок читает меню, событий отрыва до поля не дойдёт,
      // и оставленные записи склеили бы прерванный жест со следующим.
      touches.clear();
      pinchSpan = null;
    }

    handlers.menuChanged(open);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;

    // Пока меню открыто, из всей клавиатуры действуют две клавиши.
    // Разбирать остальное значило бы двигать генерала и заказывать
    // войска, пока игрок читает список горячих клавиш.
    //
    // Esc закрывает меню. Звук пропущен намеренно: выключение звука —
    // не игровое действие, оно не двигает генерала и не тратит энергию,
    // а запрет на него в меню выглядел бы поломкой ровно там, где игрок
    // и разбирается с настройками.
    if (menuOpen) {
      if (event.code === CANCEL_KEY) setMenu(false);
      else if (event.code === MUTE_KEY) handlers.toggleSound();
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
      setNukeAiming(!aimingNuke);
      return;
    }

    if (event.code === CANCEL_KEY) {
      // Порядок идёт от верхнего слоя к нижнему.
      //
      // Панель прокачки лежит поверх поля и закрывает его: пока она
      // открыта, Esc не может значить ничего другого. Дальше отмена
      // режима — действие частое и совершается не глядя. И только если
      // отменять нечего — меню.
      if (handlers.closeUpgradePanel()) return;
      if (!cancelModes()) setMenu(true);
      return;
    }

    // Выключить звук — самое частое из того, что игрок делает
    // с настройками, и лезть за этим мышью в панель незачем.
    if (event.code === MUTE_KEY) {
      handlers.toggleSound();
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

    // То же и с пальцами: окно потеряло фокус, отрыва мы не увидим.
    touches.clear();
    pinchSpan = null;
  };

  /**
   * Действие указателя по клетке: удар, цель, постройка, выделение.
   *
   * Вынесено отдельно, потому что вызывается из двух мест и в разные
   * моменты: мышь делает это в нажатии, палец — в отрыве. Причина
   * у пальца та же, по которой он вообще ждёт: тот же палец водит
   * генерала, и действуй интерфейс сразу, первое же движение свайпа
   * успевало бы заложить постройку. Отменить отправленную команду
   * нельзя.
   */
  const actAt = (x: number, y: number): boolean => {
    const minimapCell = handlers.minimapCellAtScreen(x, y);
    if (minimapCell >= 0) {
      handlers.jumpTo(minimapCell);
      return true;
    }

    if (aimingNuke) {
      const cell = handlers.cellAtScreen(x, y);
      if (cell >= 0) handlers.nuke(cell);
      aimingNuke = false;
      return true;
    }

    // Наведение цели снимается указанием клетки — как у удара, а не как
    // у постройки. Постройку ставят подряд, цель назначают одну.
    if (aimingTarget) {
      const cell = handlers.cellAtScreen(x, y);
      if (cell >= 0) handlers.setTarget(cell);
      aimingTarget = false;
      return true;
    }

    if (buildKind !== null) {
      const cell = handlers.cellAtScreen(x, y);
      if (cell >= 0) handlers.build(cell, buildKind);
      return true;
    }

    // Нажатие БЕЗ выбранного вида постройки выделяет объект. Свободного
    // нажатия у нас нет, и придумывать третью кнопку не хочется; зато
    // в этом состоянии оно до сих пор не делало ничего — новое поведение
    // занимает пустоту, а не отбирает существующее.
    const picked = handlers.cellAtScreen(x, y);
    if (picked >= 0) {
      // Повторное указание выделенного снимает выделение: так же,
      // как повторное нажатие клавиши постройки выключает режим.
      selectedCell = selectedCell === picked ? -1 : picked;
      handlers.select(selectedCell);
      return true;
    }

    // Мимо всего: ни клетки, ни миникарты. Для мыши это значит
    // «тянуть карту», для пальца — не значит ничего.
    return false;
  };

  /**
   * Направление джойстика.
   *
   * Считается той же `worldDirection`, что и для клавиш движения.
   * Своей таблицы «вверх — это северо-запад» здесь нет намеренно:
   * она разошлась бы с клавиатурной при первой правке угла проекции,
   * а привязка выводится из самой проекции.
   */
  const syncStick = (): void => {
    let next = DIRECTION_STOP;

    if (stick !== null && stick.engaged) {
      next = worldDirection(stick.x - stick.originX, stick.y - stick.originY);
    }

    if (next === direction) return;

    direction = next;
    handlers.setDirection(next);
  };

  /**
   * Расстояние и середина между двумя первыми пальцами.
   *
   * Двумя ПЕРВЫМИ, а не любыми: третий палец на экране — это ладонь,
   * задевшая стекло, и пересчитывать из-за неё жест значило бы дёргать
   * масштаб от того, как игрок держит телефон.
   */
  const pinchOf = (): { span: number; x: number; y: number } | null => {
    const [first, second] = [...touches.values()];
    if (first === undefined || second === undefined) return null;

    const span = Math.hypot(second.x - first.x, second.y - first.y);
    if (span < PINCH_MIN_SPAN_PX) return null;

    return { span, x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  };

  /**
   * Отменить джойстик, не выполняя действия.
   *
   * Зовётся, когда на экран лёг второй палец. Сброс направления
   * обязателен: генерал, шедший на первом пальце, иначе продолжит идти
   * всё время, пока игрок двумя пальцами разглядывает карту, — а
   * разглядывает он обычно другой её конец. Об уходе генерала под огонь
   * он узнает тогда, когда возвращать будет уже некого.
   */
  const abandonStick = (): void => {
    if (stick === null) return;

    stick = null;
    syncStick();
  };

  const onPointerDown = (event: PointerEvent): void => {
    // Меню накрывает поле собой, поэтому нажатие сюда и так не дойдёт.
    // Проверка стоит на случай, если меню когда-нибудь станет уже поля:
    // строить вслепую под открытым меню игрок не просил.
    if (menuOpen) return;

    const point = localPoint(event);

    // Касание: нажатие само по себе не делает ничего, оно лишь ставит
    // точку отсчёта. Что это было — тап или свайп, — станет известно
    // только по тому, уедет ли палец за порог.
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: point.x, y: point.y });
      capture(event.pointerId);

      // Второй палец отбирает жест у джойстика: дальше это щипок.
      if (touches.size >= 2) {
        abandonStick();
        pinchSpan = pinchOf()?.span ?? null;
        return;
      }

      stick = { originX: point.x, originY: point.y, x: point.x, y: point.y, engaged: false };
      return;
    }

    if (event.button === 2) {
      const cell = handlers.cellAtScreen(point.x, point.y);
      if (cell >= 0) handlers.setTarget(cell);
      return;
    }

    if (event.button !== 0) return;

    // Мышь действует В МОМЕНТ НАЖАТИЯ, и ждать отпускания ей незачем:
    // у неё нет свайпа, спорить за кнопку не с кем, а главное
    // нефункциональное требование проекта — отклик в том же кадре.
    //
    // Тянуть карту можно только когда нажатие не сделало НИЧЕГО:
    // иначе щелчок по миникарте переносил бы камеру и тут же начинал
    // тащить её следом за курсором.
    if (actAt(point.x, point.y)) return;

    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    capture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    const point = localPoint(event);
    hoverCell = handlers.cellAtScreen(point.x, point.y);

    // Щипок ведёт масштаб отношением нового расстояния между пальцами
    // к прошлому. Отношением, а не разностью: развести пальцы с двух
    // сантиметров до четырёх и с десяти до двенадцати — разные жесты,
    // хотя прибавка одна.
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: point.x, y: point.y });

      if (touches.size >= 2) {
        const pinch = pinchOf();

        if (pinch !== null) {
          // Расстояние не изменилось — сцену не тревожим. Так себя ведёт
          // третий палец, задевший стекло: жест ведут двое первых,
          // и от ладони на краю экрана масштаб дёргаться не должен.
          if (pinchSpan !== null && pinch.span !== pinchSpan) {
            handlers.zoom(pinch.span / pinchSpan, pinch.x, pinch.y);
          }

          pinchSpan = pinch.span;
        }

        return;
      }
    }

    // Замирающий свайп. Палец ведёт джойстик, пока он на экране, —
    // и держит направление, даже когда сам остановился. Держать
    // направление, непрерывно водя пальцем, физически невозможно;
    // неподвижный палец — единственный способ идти долго.
    if (stick !== null) {
      const dx = point.x - stick.originX;
      const dy = point.y - stick.originY;

      // Включившись, джойстик уже не выключается сдвигом обратно
      // к центру: вернувшийся в центр палец означает «стоп», а не
      // «это был тап». Тапом он быть перестал в тот миг, когда уехал.
      const engaged = stick.engaged || Math.hypot(dx, dy) >= TOUCH_STICK_THRESHOLD_PX;

      stick = { ...stick, x: point.x, y: point.y, engaged };
      syncStick();
      return;
    }

    if (!dragging) return;

    const dx = lastX - event.clientX;
    const dy = lastY - event.clientY;

    // Тянем карту, а не камеру: курсор должен «держать» точку под собой,
    // поэтому знак смещения обратный.
    handlers.pan(dx, dy);
    lastX = event.clientX;
    lastY = event.clientY;
  };

  /**
   * Палец ушёл с экрана — отрывом или перехватом.
   *
   * Джойстик после щипка НЕ возобновляется, и это правило, а не
   * упущение. Оставшийся на экране палец лежит там по инерции жеста,
   * а не для того, чтобы вести генерала: возобновись джойстик — генерал
   * тронулся бы сам собой в сторону, которую игрок не выбирал. Следующее
   * касание начинает джойстик заново.
   */
  const forgetTouch = (pointerId: number): void => {
    if (!touches.delete(pointerId)) return;

    // Щипок кончается вместе со вторым пальцем, но расстояние забывается
    // и при возвращении третьего: пересчитать его заново дешевле, чем
    // сравнивать новое расстояние со старым, снятым с других пальцев.
    if (touches.size < 2) pinchSpan = null;
  };

  const onPointerUp = (event: PointerEvent): void => {
    forgetTouch(event.pointerId);

    // Отрыв пальца: генерал останавливается, а действие выполняется —
    // но только если палец так и не уехал за порог, то есть это был тап,
    // а не свайп.
    if (stick !== null) {
      const tapped = !stick.engaged;
      const point = localPoint(event);

      stick = null;
      syncStick();

      if (tapped) void actAt(point.x, point.y);
    }

    dragging = false;
    releaseCapture(event.pointerId);
  };

  /**
   * Палец, уведённый за край экрана или перехваченный системой.
   *
   * Отдельно от отрыва, и это не перестраховка: `pointercancel`
   * приходит вместо `pointerup`, а не вместе с ним. Не обработай его —
   * и генерал уйдёт навсегда, потому что остановить его будет уже нечем.
   * Та же беда, что с зажатой клавишей при потере фокуса окном, и лечится
   * тем же: состояние сбрасывается, направление пересчитывается.
   *
   * Действие при этом НЕ выполняется: жест не завершён, а прерван.
   */
  const onPointerCancel = (event: PointerEvent): void => {
    forgetTouch(event.pointerId);

    stick = null;
    syncStick();

    dragging = false;
    releaseCapture(event.pointerId);
  };

  /**
   * Колесо мыши приближает и отдаляет.
   *
   * `preventDefault` обязателен, а слушатель — неленивый
   * (`passive: false`). Без этого браузер прокручивает страницу поверх
   * жеста, и на ноутбуке с тачпадом карта уезжает вместе со всей
   * страницей.
   */
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();

    if (menuOpen) return;

    const pixels =
      event.deltaMode === 1
        ? event.deltaY * WHEEL_LINE_PX
        : event.deltaMode === 2
          ? event.deltaY * WHEEL_PAGE_PX
          : event.deltaY;

    // Колесо от себя (отрицательная дельта) приближает — так же, как
    // в любой карте, к которой игрок привык.
    const point = localPoint(event);
    handlers.zoom(Math.exp(-pixels * WHEEL_ZOOM_RATE), point.x, point.y);
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
  host.addEventListener('pointercancel', onPointerCancel);
  // Неленивый слушатель: ленивому браузер не даст отменить прокрутку,
  // и страница уедет вместе с картой.
  host.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  rafHandle = requestAnimationFrame(stepPan);

  return {
    get state(): ControlState {
      return {
        building,
        buildKind,
        aimingNuke,
        aimingTarget,
        touch: stick,
        hoverCell,
        selectedCell,
      };
    },

    setBuildKind(kind) {
      // Нажатие плитки в тулбаре включает и сам режим: игрок, выбравший
      // стену, собирается строить, и требовать от него ещё и `Q` было бы
      // придиркой.
      setBuilding(kind !== null);
      buildKind = kind;
      if (kind !== null) aimingTarget = false;
    },

    setAimingNuke(aiming) {
      setNukeAiming(aiming);
    },

    setAimingTarget(aiming) {
      setTargetAiming(aiming);
    },

    setMenuOpen(open) {
      setMenu(open);
    },

    detach() {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerCancel);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      cancelAnimationFrame(rafHandle);
    },
  };
};
