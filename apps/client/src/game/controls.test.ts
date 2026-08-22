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
  jumpTo: vi.fn(),
  recentre: vi.fn(),
  select: vi.fn(),
  menuChanged: vi.fn(),
  toggleStats: vi.fn(),
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

describe('движение продолжает работать как прежде', () => {
  it('отпускание клавиши останавливает генерала', () => {
    const { handlers } = setup();

    press('KeyW');
    release('KeyW');

    expect(handlers.setDirection).toHaveBeenLastCalledWith(DIRECTION_STOP);
  });
});
