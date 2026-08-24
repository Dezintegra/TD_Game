/**
 * Общее для замеров: где журнал, свободна ли машина, как печатать.
 *
 * Замеров два вида и они очень разные. Кадры в секунду меряются
 * в браузере и требуют живой видеокарты; стоимость тика считается ядром
 * симуляции и видеокарты не касается вовсе. Общего у них ровно три вещи,
 * и все три собраны здесь: обоим нужна незанятая машина, оба пишутся
 * в один журнал и оба разговаривают с человеком одинаково.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Управляющий символ собран из кода, а не записан в исходник байтом:
// байт теряется при копировании и его любят портить редакторы.
const ESC = String.fromCharCode(27);

export const step = (text) => console.log(`\n${ESC}[36m▸${ESC}[0m ${text}`);
export const note = (text) => console.log(`  ${text}`);
export const ok = (text) => console.log(`\n${ESC}[32m✓${ESC}[0m ${text}\n`);
export const warn = (text) => note(`${ESC}[33mвнимание:${ESC}[0m ${text}`);
export const die = (text) => {
  console.error(`\n${ESC}[31m✗${ESC}[0m ${text}\n`);
  process.exit(1);
};

export const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/**
 * То же самое, но молча возвращает null, если git недоступен.
 *
 * Это не перестраховка. Счётные замеры гоняются и в контейнере, а туда
 * ни `.git`, ни сам git не попадают: `.dockerignore` исключает историю
 * намеренно, чтобы не таскать её в контекст сборки. Замер обязан работать
 * и там, просто зная о себе меньше.
 */
const gitOrNull = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

export const repoRoot = gitOrNull('rev-parse', '--show-toplevel') ?? process.cwd();

// Основное рабочее дерево. `--git-common-dir` и в нём самом, и в любом
// дополнительном указывает на один и тот же каталог `.git`, поэтому его
// родитель — общий для всех деревьев корень.
const commonDir = gitOrNull('rev-parse', '--path-format=absolute', '--git-common-dir');
export const mainTree = commonDir === null ? repoRoot : dirname(commonDir);

// Журнал и замок общие на все деревья. Замок — потому что процессор один
// на всех и два замера одновременно портят оба. Журнал — потому что замеры
// сравнивают между собой, а не внутри одной ветки; толку от трёх журналов,
// каждый из которых помнит по два прогона, никакого.
//
// `PERF_LOG` переопределяет путь: в контейнере журнал лежит на смонтированном
// каталоге, иначе он исчез бы вместе с контейнером.
export const lockPath = join(mainTree, '.perf-lock');
export const logPath = process.env['PERF_LOG'] ?? join(mainTree, '.perf-log.jsonl');

// Доля занятости процессора, выше которой замер бессмыслен. Порог мягкий
// намеренно: он ловит «рядом идёт сборка или чужой прогон», а не «система
// чем-то дышит». Значение подобрано замером на этой машине: в тишине
// заметно ниже, при семи работающих сессиях 41–79%.
export const BUSY_LIMIT = 0.35;

// Через сколько замок считается брошенным. Замер идёт около минуты,
// так что четверть часа — это уже наверняка забытый файл после падения.
const LOCK_STALE_MS = 15 * 60 * 1000;

/** Жив ли процесс. EPERM означает «есть, но чужой», то есть жив. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Кто сейчас меряет, или null. Битый или брошенный замок — как будто нет. */
export const currentHolder = () => {
  if (!existsSync(lockPath)) return null;

  let held;
  try {
    held = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }

  const age = Date.now() - Date.parse(held.started);
  if (!Number.isFinite(age) || age > LOCK_STALE_MS) return null;
  if (!alive(held.pid)) return null;

  return { ...held, age };
};

/** Доля занятости процессора за окно в ms, от 0 до 1. */
export const busyShare = async (ms) => {
  const snapshot = () => {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus()) {
      const t = cpu.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  };

  const before = snapshot();
  await sleep(ms);
  const after = snapshot();

  const total = after.total - before.total;
  if (total <= 0) return 0;
  return 1 - (after.idle - before.idle) / total;
};

/**
 * Убедиться, что мерить можно: никто другой не меряет и машина свободна.
 * Возвращает измеренную занятость — её кладут в журнал вместе с цифрами,
 * чтобы потом было видно, при каких условиях снят каждый замер.
 */
export const requireQuietMachine = async ({ force = false } = {}) => {
  const holder = currentHolder();
  if (holder) {
    die(
      [
        'замер уже идёт в другом рабочем дереве:',
        `    дерево:  ${holder.worktree}`,
        `    процесс: ${holder.pid}, начат ${Math.round(holder.age / 60000)} мин. назад`,
        '',
        '  Два замера одновременно испортят оба. Дождитесь окончания',
        `  или, если тот прогон точно умер, удалите ${lockPath}`,
      ].join('\n'),
    );
  }

  const busy = await busyShare(1500);
  note(`занятость процессора: ${Math.round(busy * 100)}% (порог ${Math.round(BUSY_LIMIT * 100)}%)`);

  if (busy > BUSY_LIMIT && !force) {
    die(
      [
        'машина занята — замерять сейчас бессмысленно.',
        '',
        '  Цифра, снятая на загруженной машине, говорит о загрузке,',
        '  а не о коде: 22.08.2026 при пяти параллельных потоках здесь',
        '  выходило 45–51 кадра при пороге 55, а в одиночку — проходило;',
        '  23.08.2026 стоимость решения ИИ так же завысило вдесятеро.',
        '',
        '  Дождитесь тишины, или, если занятость к делу не относится,',
        '  повторите с ключом --force.',
      ].join('\n'),
    );
  }

  return busy;
};

/** Прошлые замеры, от старых к свежим. Битые строки пропускаются. */
export const readLog = () => {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((it) => it !== null);
};

/** Последний замер того же вида — с ним и сравнивают свежий. */
export const lastOfKind = (kind) =>
  readLog()
    .filter((entry) => entry.kind === kind)
    .at(-1);

/**
 * Дописать замер в журнал и показать, что изменилось с прошлого раза.
 *
 * Пишется и провалившийся замер: провал порога — тоже число, и когда он
 * случится, важнее всего будет увидеть, каким был предыдущий прогон.
 */
export const recordEntry = ({ kind, measurements, busy, passed, unit = '' }) => {
  const previous = lastOfKind(kind);

  appendFileSync(
    logPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      kind,
      // В контейнере git недоступен, поэтому ревизию туда передают снаружи
      // переменной `PERF_COMMIT`. Без неё замер всё равно состоится —
      // но сравнить его будет не с чем, о чём и говорит пометка.
      commit: gitOrNull('rev-parse', '--short', 'HEAD') ?? process.env['PERF_COMMIT'] ?? 'без git',
      branch: gitOrNull('rev-parse', '--abbrev-ref', 'HEAD') ?? '—',
      worktree: repoRoot,
      busy: Math.round(busy * 100) / 100,
      passed,
      measurements,
    })}\n`,
  );

  step('Записано в журнал');
  for (const [name, value] of Object.entries(measurements)) {
    const before = previous?.measurements?.[name];
    if (before === undefined) {
      note(`${name}: ${value}${unit}`);
      continue;
    }
    const delta = Math.round((value - before) * 10) / 10;
    note(`${name}: ${value}${unit} (было ${before}${unit}, ${delta > 0 ? '+' : ''}${delta})`);
  }
  note(`журнал: ${logPath}, вся история — ключ --history`);
};

/** Напечатать историю замеров. */
export const printHistory = (limit = 20) => {
  const entries = readLog();
  if (entries.length === 0) {
    console.log('\nЗамеров ещё не было.\n');
    return;
  }

  console.log(`\nЖурнал замеров — ${logPath}\n`);
  for (const entry of entries.slice(-limit)) {
    const when = new Date(entry.at).toLocaleString('ru-RU');
    const numbers = Object.entries(entry.measurements ?? {})
      .map(([name, value]) => `${name} ${value}`)
      .join(', ');
    const load = entry.busy === undefined ? '' : `  занятость ${Math.round(entry.busy * 100)}%`;
    const verdict = entry.passed === false ? '  [ПОРОГ НЕ ВЗЯТ]' : '';
    console.log(`  ${when}  ${entry.commit}  ${entry.kind ?? '?'}: ${numbers}${load}${verdict}`);
  }
  console.log('');
};
