// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIRECTION_STOP, StructureKind, UnitType } from '@td/shared';
import { CONTROL_LAYOUT, attachControls } from './controls.js';
import type { ControlHandlers, Controls } from './controls.js';

/**
 * Проверяется одно свойство, и оно про Esc.
 *
 * У Esc теперь два значения — «отменить режим» и «открыть меню», — и порядок
 * между ними не украшение. Отменяют режим в разы чаще, чем открывают меню,
 * и делают это не глядя. Меню, перехватывающее Esc всегда, отняло бы у игрока
 * привычный способ передумать, а заметил бы он это посреди боя.
 *
 * Окружение здесь браузерное, а не общее для клиента: управление живёт
 * на событиях окна, и подменять их заглушками значило бы проверять заглушки.
 */

const handlersOf = (): ControlHandlers => ({
  setDirection: vi.fn(),
  build: vi.fn(),
  train: vi.fn(),
  setTarget: vi.fn(),
  setStance: vi.fn(),
  nuke: vi.fn(),
  pan: vi.fn(),
  zoom: vi.fn(),
  jumpTo: vi.fn(),
  recentre: vi.fn(),
  select: vi.fn(),
  menuChanged: vi.fn(),
  toggleStats: vi.fn(),
  // По умолчанию панели нет — то есть прокачка показана столбцами,
  // и Esc должен вести себя ровно как прежде: отменить режим, потом меню.
  closeUpgradePanel: vi.fn(() => false),
  toggleSound: vi.fn(),
  cellAtScreen: vi.fn(() => -1),
  minimapCellAtScreen: vi.fn(() => -1),
});

let attached: Controls | undefined;

const setup = (): { controls: Controls; handlers: ControlHandlers } => {
  const handlers = handlersOf();
  const host = document.createElement('div');
  document.body.appendChild(host);

  const controls = attachControls(host, handlers);
  attached = controls;

  return { controls, handlers };
};

const press = (code: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
};

const release = (code: string): void => {
  window.dispatchEvent(new KeyboardEvent('keyup', { code }));
};

/**
 * Касание: pointer-событие с типом `touch`.
 *
 * Номер указателя вынесен в необязательный последний довод: щипку нужны
 * два разных пальца, а всем прежним проверкам — один и тот же.
 */
const touch = (
  host: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  pointerId = 1,
): void => {
  const event = new Event(type, { bubbles: true }) as PointerEvent & Record<string, unknown>;
  Object.assign(event, { pointerType: 'touch', pointerId, clientX: x, clientY: y, button: 0 });
  host.dispatchEvent(event);
};

/** Колесо мыши. `deltaMode` по умолчанию пиксельный, как у обычной мыши. */
const wheel = (host: HTMLElement, deltaY: number, x = 100, y = 100, deltaMode = 0): Event => {
  const event = new Event('wheel', { bubbles: true, cancelable: true }) as WheelEvent &
    Record<string, unknown>;
  Object.assign(event, { deltaY, deltaMode, clientX: x, clientY: y });
  host.dispatchEvent(event);
  return event;
};

/** Нажатие мышью — для сравнения с касанием. */
const mouseDown = (host: HTMLElement, x: number, y: number): void => {
  const event = new Event('pointerdown', { bubbles: true }) as PointerEvent &
    Record<string, unknown>;
  Object.assign(event, { pointerType: 'mouse', pointerId: 1, clientX: x, clientY: y, button: 0 });
  host.dispatchEvent(event);
};

afterEach(() => {
  attached?.detach();
  attached = undefined;
  document.body.innerHTML = '';
});

describe('режим строительства', () => {
  it('Q включает режим, и круг радиуса появляется до выбора вида', () => {
    // Игрок включает режим прежде, чем решил, что ставить, и вопрос
    // «докуда я дотянусь» у него возникает именно в этот момент —
    // от ответа зависит, стену класть или башню.
    const { controls } = setup();

    press('KeyQ');

    expect(controls.state.building).toBe(true);
    expect(controls.state.buildKind).toBeNull();
  });

  it('в режиме цифра выбирает постройку, а не заказывает юнита', () => {
    const { controls, handlers } = setup();

    press('KeyQ');
    press('Digit1');

    expect(controls.state.buildKind).toBe(StructureKind.Wall);
    expect(handlers.train).not.toHaveBeenCalled();
  });

  it('цифры в режиме идут в том же порядке, что плитки', () => {
    const { controls } = setup();

    press('KeyQ');

    press('Digit2');
    expect(controls.state.buildKind).toBe(StructureKind.TowerBasic);

    press('Digit3');
    expect(controls.state.buildKind).toBe(StructureKind.TowerSniper);
  });

  it('повторное Q выключает режим и снимает выбранный вид', () => {
    // Круг исчез — значит строить нечем. Оставленный вид сработал бы
    // на следующем нажатии мышью, то есть поставил бы постройку,
    // которую игрок уже передумал ставить.
    const { controls } = setup();

    press('KeyQ');
    press('Digit1');
    press('KeyQ');

    expect(controls.state.building).toBe(false);
    expect(controls.state.buildKind).toBeNull();
  });

  it('E возвращает к юнитам', () => {
    const { controls, handlers } = setup();

    press('KeyQ');
    press('KeyE');
    expect(controls.state.building).toBe(false);

    press('Digit1');
    expect(handlers.train).toHaveBeenCalledWith(UnitType.Assault, 1);
  });

  it('вне режима цифра заказывает юнита одним нажатием', () => {
    const { controls, handlers } = setup();

    press('Digit3');

    expect(handlers.train).toHaveBeenCalledWith(UnitType.Tesla, 1);
    expect(controls.state.buildKind).toBeNull();
  });

  it('Shift с цифрой заказывает пакет', () => {
    const { handlers } = setup();

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', shiftKey: true }));

    expect(handlers.train).toHaveBeenCalledWith(UnitType.Assault, 10);
  });

  it('R больше не выбирает постройку, а переключает характеристики', () => {
    const { controls, handlers } = setup();

    press('KeyR');

    expect(controls.state.buildKind).toBeNull();
    expect(handlers.toggleStats).toHaveBeenCalledTimes(1);
  });
});

describe('Esc: сначала отмена, потом меню', () => {
  it('с включённым режимом стройки выключает его и меню не открывает', () => {
    const { controls, handlers } = setup();

    press('KeyQ');
    press('Digit1');
    expect(controls.state.buildKind).toBe(StructureKind.Wall);

    press('Escape');

    expect(controls.state.building).toBe(false);
    expect(controls.state.buildKind).toBeNull();
    expect(handlers.menuChanged).not.toHaveBeenCalled();
  });

  it('режим без выбранного вида тоже считается отменяемым', () => {
    // Иначе Esc сразу после Q открывал бы меню, оставив круг на поле.
    const { controls, handlers } = setup();

    press('KeyQ');
    press('Escape');

    expect(controls.state.building).toBe(false);
    expect(handlers.menuChanged).not.toHaveBeenCalled();
  });

  it('с наведённым ударом выключает наведение и меню не открывает', () => {
    const { controls, handlers } = setup();

    press('KeyF');
    expect(controls.state.aimingNuke).toBe(true);

    press('Escape');

    expect(controls.state.aimingNuke).toBe(false);
    expect(handlers.menuChanged).not.toHaveBeenCalled();
  });

  it('без активных режимов открывает меню', () => {
    const { handlers } = setup();

    press('Escape');

    expect(handlers.menuChanged).toHaveBeenCalledWith(true);
  });

  it('открытую панель прокачки закрывает раньше всего остального', () => {
    // Панель лежит поверх поля и закрывает его: пока она открыта, Esc
    // не может значить ничего другого. Иначе игрок получил бы меню
    // ПОВЕРХ панели — два слоя разом на экране, где и одного много.
    const { controls, handlers } = setup();
    vi.mocked(handlers.closeUpgradePanel).mockReturnValueOnce(true);

    press('KeyQ');
    press('Escape');

    expect(handlers.closeUpgradePanel).toHaveBeenCalledTimes(1);
    // Ни режим не отменён, ни меню не открыто: сработал верхний слой.
    expect(controls.state.building).toBe(true);
    expect(handlers.menuChanged).not.toHaveBeenCalled();
  });

  it('при открытом меню закрывает его', () => {
    const { handlers } = setup();

    press('Escape');
    press('Escape');

    expect(handlers.menuChanged).toHaveBeenNthCalledWith(1, true);
    expect(handlers.menuChanged).toHaveBeenNthCalledWith(2, false);
  });

  it('второе нажатие подряд не открывает меню дважды', () => {
    const { handlers } = setup();

    press('Escape');
    press('Escape');
    press('Escape');

    // Открыто, закрыто, открыто — три смены состояния, а не четыре.
    expect(handlers.menuChanged).toHaveBeenCalledTimes(3);
  });
});

describe('открытое меню глушит управление', () => {
  it('генерал останавливается, даже если клавиша осталась зажатой', () => {
    const { handlers } = setup();

    press('KeyW');
    const moving = vi.mocked(handlers.setDirection).mock.calls.at(-1)?.[0];
    expect(moving).not.toBe(DIRECTION_STOP);

    // Клавиша НЕ отпускается: браузер не пришлёт keyup за то время, что
    // нажатия не разбираются, и генерал ушёл бы под открытым меню.
    press('Escape');

    expect(handlers.setDirection).toHaveBeenLastCalledWith(DIRECTION_STOP);
  });

  it('звук выключается и при открытом меню', () => {
    // Звук — не игровое действие: он не двигает генерала и не тратит
    // энергию. Запрет на него ровно там, где игрок разбирается
    // с настройками, выглядел бы поломкой.
    const { handlers } = setup();

    press('Escape');
    press('KeyM');

    expect(handlers.toggleSound).toHaveBeenCalledTimes(1);
  });

  it('цифры не заказывают юнитов', () => {
    const { handlers } = setup();

    press('Escape');
    press('Digit1');

    expect(handlers.train).not.toHaveBeenCalled();
  });

  it('после закрытия меню управление возвращается', () => {
    const { handlers } = setup();

    press('Escape');
    press('Escape');
    press('Digit1');

    expect(handlers.train).toHaveBeenCalledWith(UnitType.Assault, 1);
  });

  it('меню, открытое кнопкой HUD, глушит клавиатуру так же', () => {
    const { controls, handlers } = setup();

    controls.setMenuOpen(true);
    press('KeyQ');

    expect(controls.state.building).toBe(false);
    expect(handlers.menuChanged).toHaveBeenCalledWith(true);
  });
});

describe('замирающий свайп', () => {
  const withHost = (): { controls: Controls; handlers: ControlHandlers; host: HTMLElement } => {
    const handlers = handlersOf();
    const host = document.createElement('div');
    document.body.appendChild(host);

    const controls = attachControls(host, handlers);
    attached = controls;

    return { controls, handlers, host };
  };

  it('свайп за порог трогает генерала с места', () => {
    const { controls, handlers, host } = withHost();

    touch(host, 'pointerdown', 100, 100);
    expect(controls.state.touch?.engaged).toBe(false);
    expect(handlers.setDirection).not.toHaveBeenCalled();

    touch(host, 'pointermove', 160, 100);

    expect(controls.state.touch?.engaged).toBe(true);
    expect(vi.mocked(handlers.setDirection).mock.calls.at(-1)?.[0]).not.toBe(DIRECTION_STOP);
  });

  it('замерший палец держит направление', () => {
    // Ключевое свойство. Держать направление, непрерывно водя пальцем,
    // физически невозможно; неподвижный палец — единственный способ
    // идти долго. Проверяется тем, что после свайпа команд больше нет,
    // а последняя из них — не «стоп».
    const { handlers, host } = withHost();

    touch(host, 'pointerdown', 100, 100);
    touch(host, 'pointermove', 160, 100);

    const afterSwipe = vi.mocked(handlers.setDirection).mock.calls.length;

    // Палец лежит и не двигается: событий больше не приходит вовсе.
    expect(vi.mocked(handlers.setDirection).mock.calls.length).toBe(afterSwipe);
    expect(vi.mocked(handlers.setDirection).mock.calls.at(-1)?.[0]).not.toBe(DIRECTION_STOP);
  });

  it('малый сдвиг генерала не трогает', () => {
    const { controls, handlers, host } = withHost();

    touch(host, 'pointerdown', 100, 100);
    touch(host, 'pointermove', 105, 103);

    expect(controls.state.touch?.engaged).toBe(false);
    expect(handlers.setDirection).not.toHaveBeenCalled();
  });

  it('отрыв останавливает генерала', () => {
    const { controls, handlers, host } = withHost();

    touch(host, 'pointerdown', 100, 100);
    touch(host, 'pointermove', 160, 100);
    touch(host, 'pointerup', 160, 100);

    expect(controls.state.touch).toBeNull();
    expect(handlers.setDirection).toHaveBeenLastCalledWith(DIRECTION_STOP);
  });

  it('перехваченный палец останавливает так же, как отрыв', () => {
    // `pointercancel` приходит ВМЕСТО `pointerup`, а не вместе с ним.
    // Не обработай его — и генерал уйдёт навсегда: останавливать будет
    // уже нечем.
    const { controls, handlers, host } = withHost();

    touch(host, 'pointerdown', 100, 100);
    touch(host, 'pointermove', 160, 100);
    touch(host, 'pointercancel', 160, 100);

    expect(controls.state.touch).toBeNull();
    expect(handlers.setDirection).toHaveBeenLastCalledWith(DIRECTION_STOP);
  });

  it('направление свайпа совпадает с клавиатурным', () => {
    // Своей таблицы соответствий нет: и клавиши, и свайп идут через одно
    // преобразование экранного смещения в направление мира. Разойдись
    // они — рука и глаз разошлись бы вместе с ними.
    const byKey = handlersOf();
    const keyHost = document.createElement('div');
    document.body.appendChild(keyHost);
    const keyControls = attachControls(keyHost, byKey);

    press('KeyW');
    const keyDirection = vi.mocked(byKey.setDirection).mock.calls.at(-1)?.[0];
    keyControls.detach();

    const { handlers, host } = withHost();
    touch(host, 'pointerdown', 200, 200);
    // Вверх по экрану — тот же вектор, что даёт `W`.
    touch(host, 'pointermove', 200, 120);

    expect(vi.mocked(handlers.setDirection).mock.calls.at(-1)?.[0]).toBe(keyDirection);
  });
});

describe('щипок двумя пальцами', () => {
  const withHost = (): { controls: Controls; handlers: ControlHandlers; host: HTMLElement } => {
    const handlers = handlersOf();
    const host = document.createElement('div');
    document.body.appendChild(host);

    const controls = attachControls(host, handlers);
    attached = controls;

    return { controls, handlers, host };
  };

  /** Опустить два пальца на расстоянии `span` по горизонтали. */
  const putTwoFingers = (host: HTMLElement, span = 100): void => {
    touch(host, 'pointerdown', 200, 200, 1);
    touch(host, 'pointerdown', 200 + span, 200, 2);
  };

  it('второй палец останавливает генерала', () => {
    // Главное свойство. Генерал, шедший на первом пальце, иначе
    // продолжил бы идти всё время, пока игрок двумя пальцами
    // разглядывает другой конец карты.
    const { controls, handlers, host } = withHost();

    touch(host, 'pointerdown', 200, 200, 1);
    touch(host, 'pointermove', 260, 200, 1);
    expect(controls.state.touch?.engaged).toBe(true);

    touch(host, 'pointerdown', 400, 200, 2);

    expect(controls.state.touch).toBeNull();
    expect(handlers.setDirection).toHaveBeenLastCalledWith(DIRECTION_STOP);
  });

  it('разведённые пальцы приближают, сведённые отдаляют', () => {
    const { handlers, host } = withHost();

    putTwoFingers(host, 100);

    touch(host, 'pointermove', 400, 200, 2);
    expect(vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0]).toBeGreaterThan(1);

    touch(host, 'pointermove', 250, 200, 2);
    expect(vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0]).toBeLessThan(1);
  });

  it('масштаб ведётся отношением расстояний, а не разностью', () => {
    // Развести пальцы с двух сантиметров до четырёх и с десяти
    // до двенадцати — разные жесты, хотя прибавка одна.
    const { handlers, host } = withHost();

    putTwoFingers(host, 100);
    touch(host, 'pointermove', 400, 200, 2);

    expect(vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0]).toBeCloseTo(2, 6);
  });

  it('точкой отсчёта служит середина между пальцами', () => {
    const { handlers, host } = withHost();

    putTwoFingers(host, 100);
    touch(host, 'pointermove', 400, 200, 2);

    expect(vi.mocked(handlers.zoom).mock.calls.at(-1)?.slice(1)).toEqual([300, 200]);
  });

  it('сведённые вплотную пальцы масштаб не трогают', () => {
    // Расстояние около нуля превращает любую дрожь в скачок во много раз:
    // масштаб ведётся делением на него.
    const { handlers, host } = withHost();

    putTwoFingers(host, 4);
    touch(host, 'pointermove', 206, 200, 2);

    expect(handlers.zoom).not.toHaveBeenCalled();
  });

  it('отрыв одного пальца не возвращает джойстик', () => {
    // Оставшийся палец лежит по инерции жеста, а не для того, чтобы
    // вести генерала. Возобновись джойстик — генерал тронулся бы сам
    // собой в сторону, которую игрок не выбирал.
    const { controls, handlers, host } = withHost();

    putTwoFingers(host);
    touch(host, 'pointerup', 300, 200, 2);
    touch(host, 'pointermove', 400, 200, 1);

    expect(controls.state.touch).toBeNull();
    expect(vi.mocked(handlers.setDirection).mock.calls.at(-1)?.[0] ?? DIRECTION_STOP).toBe(
      DIRECTION_STOP,
    );
  });

  it('следующее касание снова водит генерала', () => {
    const { controls, host } = withHost();

    putTwoFingers(host);
    touch(host, 'pointerup', 300, 200, 2);
    touch(host, 'pointerup', 200, 200, 1);

    touch(host, 'pointerdown', 100, 100, 3);
    touch(host, 'pointermove', 160, 100, 3);

    expect(controls.state.touch?.engaged).toBe(true);
  });

  it('щипок не заказывает и не строит по отрыву', () => {
    // Отрыв после щипка — это конец жеста масштабирования, а не тап.
    // Сработай здесь действие — игрок ставил бы постройку каждый раз,
    // когда разглядывал карту.
    const handlers = handlersOf();
    handlers.cellAtScreen = vi.fn(() => 42);
    const host = document.createElement('div');
    document.body.appendChild(host);
    attached = attachControls(host, handlers);

    putTwoFingers(host);
    touch(host, 'pointerup', 300, 200, 2);
    touch(host, 'pointerup', 200, 200, 1);

    expect(handlers.select).not.toHaveBeenCalled();
    expect(handlers.build).not.toHaveBeenCalled();
  });

  it('третий палец жест не пересчитывает', () => {
    // Третий палец на экране — это ладонь, задевшая стекло. Пересчитай
    // жест из-за неё, и масштаб дёргался бы от того, как игрок держит
    // телефон.
    const { handlers, host } = withHost();

    putTwoFingers(host, 100);
    touch(host, 'pointerdown', 700, 600, 3);

    const afterThird = vi.mocked(handlers.zoom).mock.calls.length;
    touch(host, 'pointermove', 701, 601, 3);

    expect(vi.mocked(handlers.zoom).mock.calls.length).toBe(afterThird);
  });

  it('открытое меню забывает пальцы', () => {
    // Пока игрок читает меню, событий отрыва до поля не дойдёт.
    // Оставленные записи склеили бы прерванный жест со следующим.
    const { controls, handlers, host } = withHost();

    putTwoFingers(host);
    controls.setMenuOpen(true);
    controls.setMenuOpen(false);

    touch(host, 'pointerdown', 100, 100, 5);
    touch(host, 'pointermove', 160, 100, 5);

    expect(controls.state.touch?.engaged).toBe(true);
    expect(vi.mocked(handlers.setDirection).mock.calls.at(-1)?.[0]).not.toBe(DIRECTION_STOP);
  });
});

describe('колесо мыши приближает', () => {
  const withHost = (): { handlers: ControlHandlers; host: HTMLElement } => {
    const handlers = handlersOf();
    const host = document.createElement('div');
    document.body.appendChild(host);

    attached = attachControls(host, handlers);

    return { handlers, host };
  };

  it('колесо от себя приближает, к себе — отдаляет', () => {
    // Направление взято от любой карты, к которой игрок привык:
    // отрицательная дельта означает «от себя», то есть ближе.
    const { handlers, host } = withHost();

    wheel(host, -100);
    const closer = vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0] ?? 0;

    wheel(host, 100);
    const farther = vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0] ?? 0;

    expect(closer).toBeGreaterThan(1);
    expect(farther).toBeLessThan(1);
  });

  it('точкой отсчёта служит курсор, а не центр экрана', () => {
    const { handlers, host } = withHost();

    wheel(host, -100, 640, 90);

    expect(vi.mocked(handlers.zoom).mock.calls.at(-1)?.slice(1)).toEqual([640, 90]);
  });

  it('прокрутку страницы браузеру не отдаёт', () => {
    // Иначе на ноутбуке с тачпадом карта уезжает вместе со всей
    // страницей: браузер прокручивает поверх жеста.
    const { host } = withHost();

    expect(wheel(host, -100).defaultPrevented).toBe(true);
  });

  it('строки и страницы приводятся к пикселям', () => {
    // Колесо приходит в разных единицах, и одна «щёлка» в строках
    // означает куда больший шаг, чем одна в пикселях. Не приведи их —
    // и на одной мыши масштаб полз бы, а на другой прыгал.
    const { handlers, host } = withHost();

    wheel(host, -1, 100, 100, 0);
    const byPixel = vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0] ?? 0;

    wheel(host, -1, 100, 100, 1);
    const byLine = vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0] ?? 0;

    expect(byLine).toBeGreaterThan(byPixel);
  });

  it('шаг умножается, а не прибавляется', () => {
    // Приближение по своей природе умножается: прибавка «плюс 0,1»
    // на дефолте 0,611 даёт шестнадцать процентов, а на четырёхкратном —
    // четыре. Одинаковая дельта обязана давать одинаковый множитель.
    const { handlers, host } = withHost();

    wheel(host, -100);
    const first = vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0] ?? 0;

    wheel(host, -200);
    const double = vi.mocked(handlers.zoom).mock.calls.at(-1)?.[0] ?? 0;

    expect(double).toBeCloseTo(first * first, 6);
  });

  it('при открытом меню молчит', () => {
    const { handlers, host } = withHost();

    attached?.setMenuOpen(true);
    wheel(host, -100);

    expect(handlers.zoom).not.toHaveBeenCalled();
  });
});

describe('касание действует по отрыву', () => {
  const setupCells = (): { controls: Controls; handlers: ControlHandlers; host: HTMLElement } => {
    const handlers = handlersOf();
    handlers.cellAtScreen = vi.fn(() => 42);

    const host = document.createElement('div');
    document.body.appendChild(host);

    const controls = attachControls(host, handlers);
    attached = controls;

    return { controls, handlers, host };
  };

  it('нажатие пальцем само по себе ничего не выделяет', () => {
    const { controls, handlers, host } = setupCells();

    touch(host, 'pointerdown', 100, 100);

    expect(controls.state.selectedCell).toBe(-1);
    expect(handlers.select).not.toHaveBeenCalled();
  });

  it('тап выделяет по отрыву', () => {
    const { controls, host } = setupCells();

    touch(host, 'pointerdown', 100, 100);
    touch(host, 'pointerup', 100, 100);

    expect(controls.state.selectedCell).toBe(42);
  });

  it('свайп не выделяет и не строит', () => {
    // Иначе первое же движение свайпа успевало бы заложить постройку,
    // а отменить отправленную команду нельзя.
    const { controls, handlers, host } = setupCells();

    touch(host, 'pointerdown', 100, 100);
    touch(host, 'pointermove', 200, 100);
    touch(host, 'pointerup', 200, 100);

    expect(controls.state.selectedCell).toBe(-1);
    expect(handlers.select).not.toHaveBeenCalled();
    expect(handlers.build).not.toHaveBeenCalled();
  });

  it('мышь по-прежнему отвечает в момент нажатия', () => {
    // У мыши свайпа нет, спорить за кнопку не с кем, и ждать отпускания
    // означало бы платить задержкой ни за что.
    const { controls, host } = setupCells();

    mouseDown(host, 100, 100);

    expect(controls.state.selectedCell).toBe(42);
  });
});

describe('цель атаки кнопкой-режимом', () => {
  it('режим цели гасит режим стройки и наоборот', () => {
    const { controls } = setup();

    press('KeyQ');
    controls.setAimingTarget(true);
    expect(controls.state.building).toBe(false);
    expect(controls.state.aimingTarget).toBe(true);

    controls.setBuildKind(StructureKind.Wall);
    expect(controls.state.aimingTarget).toBe(false);
  });

  it('Esc снимает режим цели и меню не открывает', () => {
    const { controls, handlers } = setup();

    controls.setAimingTarget(true);
    press('Escape');

    expect(controls.state.aimingTarget).toBe(false);
    expect(handlers.menuChanged).not.toHaveBeenCalled();
  });

  it('наведение удара и наведение цели не совмещаются', () => {
    const { controls } = setup();

    controls.setAimingTarget(true);
    controls.setAimingNuke(true);

    expect(controls.state.aimingTarget).toBe(false);
    expect(controls.state.aimingNuke).toBe(true);
  });
});

describe('раскладка описана одной таблицей', () => {
  it('перечень горячих клавиш перечисляет те же клавиши, что разбираются', () => {
    // Две таблицы — одна для разбора, другая для показа — разошлись бы
    // при первой же правке, и игрок читал бы подсказку, которая врёт.
    const listed = new Set(CONTROL_LAYOUT.flatMap((hint) => hint.codes));

    for (const code of [
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Digit1',
      'Digit2',
      'Digit3',
      'KeyQ',
      'KeyE',
      'KeyR',
      'KeyF',
      'KeyZ',
      'KeyX',
      'Space',
      'Escape',
      'KeyM',
    ]) {
      expect(listed.has(code)).toBe(true);
    }
  });

  it('у каждой подписи есть и клавиша, и объяснение', () => {
    for (const hint of CONTROL_LAYOUT) {
      expect(hint.keys.length).toBeGreaterThan(0);
      expect(hint.what.length).toBeGreaterThan(0);
    }
  });
});

describe('выделение снимается тем же Esc', () => {
  it('снятие выделения считается отменой и меню не открывает', () => {
    const handlers = handlersOf();
    const host = document.createElement('div');
    document.body.appendChild(host);

    // Клетка под курсором есть — значит нажатие выделит объект.
    handlers.cellAtScreen = vi.fn(() => 42);
    const controls = attachControls(host, handlers);
    attached = controls;

    host.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    expect(controls.state.selectedCell).toBe(42);

    press('Escape');

    expect(controls.state.selectedCell).toBe(-1);
    expect(handlers.menuChanged).not.toHaveBeenCalled();
  });
});

describe('включение режима снимает выделение', () => {
  /** Выделить объект в клетке 42 и вернуть управление с обработчиками. */
  const withSelection = (): { controls: Controls; handlers: ControlHandlers } => {
    const handlers = handlersOf();
    handlers.cellAtScreen = vi.fn(() => 42);

    const host = document.createElement('div');
    document.body.appendChild(host);

    const controls = attachControls(host, handlers);
    attached = controls;

    host.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    expect(controls.state.selectedCell).toBe(42);
    vi.mocked(handlers.select).mockClear();

    return { controls, handlers };
  };

  it('выбор вида постройки из тулбара', () => {
    // Окно сведений иначе висит поверх поля ровно тогда, когда игрок
    // собрался это поле застраивать, — то есть закрывает ему клетки
    // в момент прицеливания.
    const { controls, handlers } = withSelection();

    controls.setBuildKind(StructureKind.Wall);

    expect(controls.state.selectedCell).toBe(-1);
    expect(handlers.select).toHaveBeenCalledWith(-1);
  });

  it('режим строительства клавишей', () => {
    const { controls, handlers } = withSelection();

    press('KeyQ');

    expect(controls.state.selectedCell).toBe(-1);
    expect(handlers.select).toHaveBeenCalledWith(-1);
  });

  it('наведение ядерки из тулбара', () => {
    const { controls, handlers } = withSelection();

    controls.setAimingNuke(true);

    expect(controls.state.selectedCell).toBe(-1);
    expect(handlers.select).toHaveBeenCalledWith(-1);
  });

  it('наведение ядерки клавишей', () => {
    const { controls, handlers } = withSelection();

    press('KeyF');

    expect(controls.state.aimingNuke).toBe(true);
    expect(controls.state.selectedCell).toBe(-1);
    expect(handlers.select).toHaveBeenCalledWith(-1);
  });

  it('наведение цели атаки', () => {
    const { controls, handlers } = withSelection();

    controls.setAimingTarget(true);

    expect(controls.state.selectedCell).toBe(-1);
    expect(handlers.select).toHaveBeenCalledWith(-1);
  });

  it('выход из режима выделение не трогает', () => {
    // Снимает выделение ВХОД в режим, а не выход из него: выйдя из
    // строительства, игрок вернулся к разглядыванию поля, и гасить ему
    // нечего.
    const { controls, handlers } = withSelection();

    controls.setBuildKind(null);
    controls.setAimingNuke(false);
    controls.setAimingTarget(false);

    expect(handlers.select).not.toHaveBeenCalled();
  });

  it('без выделения обработчик не тревожится', () => {
    // Пустое снятие не должно доходить до HUD: оно перерисовало бы окно
    // сведений на каждое нажатие плитки.
    const handlers = handlersOf();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const controls = attachControls(host, handlers);
    attached = controls;

    controls.setBuildKind(StructureKind.Wall);

    expect(handlers.select).not.toHaveBeenCalled();
  });
});

describe('движение продолжает работать как прежде', () => {
  it('отпускание клавиши останавливает генерала', () => {
    const { handlers } = setup();

    press('KeyW');
    release('KeyW');

    expect(handlers.setDirection).toHaveBeenLastCalledWith(DIRECTION_STOP);
  });
});
