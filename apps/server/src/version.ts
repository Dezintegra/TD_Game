import { execFileSync } from 'node:child_process';

/**
 * Версия кода, которой сыгран матч.
 *
 * Без неё сравнение «до правки / после правки» превращается в гадание,
 * какой половиной матчей какая версия сыграна. Признак грязного дерева
 * не менее важен: прогон на незакоммиченном коде воспроизвести нельзя,
 * и знать об этом надо в момент разбора, а не через месяц.
 *
 * Копия такого же файла в `apps/arena/src/version.ts`, и это осознанно.
 * Общего дома у них нет: приложения друг друга не импортируют, а
 * `@td/shared` обязан оставаться изоморфным — он попадает в браузер,
 * и `node:child_process` в нём быть не может. Пятнадцать строк дешевле
 * пакета, заведённого ради пятнадцати строк.
 */
export interface CodeVersion {
  readonly sha: string;
  readonly dirty: boolean;
}

const git = (args: readonly string[]): string =>
  execFileSync('git', [...args], { encoding: 'utf8' }).trim();

export const codeVersion = (): CodeVersion => {
  try {
    return {
      sha: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain']).length > 0,
    };
  } catch {
    // Не репозиторий или нет git. Не повод останавливать сервер, но повод
    // сказать об этом честно: пустая версия в записи видна сразу,
    // а выдуманная — нет.
    return { sha: '', dirty: true };
  }
};
