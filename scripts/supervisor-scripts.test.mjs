import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Короткая команда запуска супервизора разрешается к корневому описанию пакета.
 *
 * Сторож лежит в наборе тестов ПРОЕКТА, а не инструмента: он проверяет
 * корневой `package.json` этого репозитория. Уехав с каталогом инструмента
 * в чужой проект, он покраснел бы там на пустом месте — а инструмент обязан
 * переноситься копированием каталога.
 *
 * Супервизор здесь не поднимается и не снимается ни под каким видом.
 * `pnpm supervisor` в прогоне тестов поднял бы боевой конвейер, который сам
 * берёт задачи с доски и правит репозиторий, а `pnpm supervisor:stop` снял бы
 * работающий у того, кто гоняет тесты на своей машине. Поэтому вызов всюду
 * один — `pnpm run` БЕЗ имени сценария: он только печатает список команд
 * и не исполняет ничего.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Пускатель, к которому обязан вести каждый сценарий запуска. */
const LAUNCHER = 'supervisor/bin/launch.mjs';

/** Четыре способа обращения, которые понимает пускатель. */
const NAMES = ['supervisor', 'supervisor:shadow', 'supervisor:detached', 'supervisor:stop'];

// Управляющий символ собирается из кода, а не пишется в литерале: иначе
// правило no-control-regex справедливо ругается на управляющий символ внутри
// регулярного выражения.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/**
 * Список сценариев из вывода `pnpm run`.
 *
 * Разбираются обе мыслимые раскладки — «имя и команда в одной строке»
 * и «имя строкой, команда следующей с большим отступом». Держаться одной
 * значило бы покраснеть на смене версии менеджера там, где ничего
 * не сломалось.
 */
function scriptsFromListing(text) {
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  const found = new Map();
  lines.forEach((line, index) => {
    const inline = /^\s+(\S+)\s{2,}(\S.*)$/.exec(line);
    if (inline) {
      found.set(inline[1], inline[2].trim());
      return;
    }
    const alone = /^(\s+)(\S+)\s*$/.exec(line);
    if (!alone) return;
    const next = lines[index + 1] ?? '';
    const deeper = new RegExp(`^${alone[1]}\\s+\\S`).test(next);
    found.set(alone[2], deeper ? next.trim() : '');
  });
  return found;
}

/**
 * Вывод `pnpm run` из указанного каталога.
 *
 * Не найден `pnpm` — тест ПАДАЕТ с внятным сообщением, а не зеленеет
 * пропуском: проверка, тихо ничего не проверившая, хуже отсутствующей.
 */
function listScripts(cwd, extra = '') {
  // Команда строкой и через оболочку — потому что на Windows `pnpm` это
  // `pnpm.cmd`, а Node с апреля 2024 отказывается порождать батник напрямую
  // (EINVAL): дыру с подстановкой команды закрыли запретом. Подставлять сюда
  // нечего — вся команда написана здесь же и целиком.
  const command = `pnpm ${extra}run`.replace(/\s+/g, ' ');
  try {
    return execSync(command, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const reason = error.stderr || error.message;
    throw new Error(
      `Не удалось получить список сценариев командой «${command}» ` +
        `в каталоге ${cwd}. Без pnpm короткая команда запуска непроверяема, ` +
        `и молчаливый пропуск здесь запрещён.\n${reason}`,
    );
  }
}

describe('короткая команда запуска супервизора', () => {
  it('все четыре сценария видны из корня и ведут на пускатель', { timeout: 60000 }, () => {
    const listing = listScripts(root);
    const scripts = scriptsFromListing(listing);
    for (const name of NAMES) {
      expect(scripts.has(name), `Сценария «${name}» нет в выводе pnpm run:\n${listing}`).toBe(true);
      expect(scripts.get(name), `Сценарий «${name}» ведёт не на пускатель`).toContain(LAUNCHER);
    }
  });

  it(
    'из вложенного каталога пакета те же четыре видны по виду pnpm -w run',
    { timeout: 60000 },
    () => {
      // Закрепляется именно ВИД команды: правила поиска сценария у пакетных
      // менеджеров разнятся между версиями, и руководство обязано называть
      // проверенный вид, а не счёвшийся вероятным.
      const listing = listScripts(join(root, 'packages', 'sim'), '-w ');
      const scripts = scriptsFromListing(listing);
      for (const name of NAMES) {
        expect(
          scripts.has(name),
          `Из packages/sim вид «pnpm -w run» не показал сценария «${name}»:\n${listing}`,
        ).toBe(true);
        expect(scripts.get(name), `Сценарий «${name}» ведёт не на пускатель`).toContain(LAUNCHER);
      }
    },
  );
});
