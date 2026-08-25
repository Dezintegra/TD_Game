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
// Таймеры импортируются явно, а не берутся из глобальных. Глобальные
// имена Node в обычном `.mjs` линт перечисляет вручную (`eslint.config.js`,
// блок `scripts/**/*.mjs`), и растить тот список ради двух функций
// незачем — импорт называет их источник прямо.
import { clearInterval, setInterval } from 'node:timers';
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

// Ход мира: тридцать тиков в секунду. Число держит сервер, и оно
// не зависит ни от машины, ни от видеокарты, ни от нагрузки — отсюда
// вся сила этой величины как свидетеля. За шестисекундное окно замера
// тик обязан вырасти примерно на сто восемьдесят; когда он вырастает
// на пятьсот, замер описывает догон истории, а не отрисовку.
//
// Значение продублировано из `TICKS_PER_SECOND` (`packages/shared`)
// намеренно: сюда пакет не импортируется — `--history` обязан работать
// и до сборки, а импорт из `dist` этого бы лишил. Совпадение
// сторожит тест `perf-common.test.mjs`.
export const WORLD_TICKS_PER_SECOND = 30;

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

/** Счётчики процессора с начала загрузки системы: всего и из них простоя. */
const cpuTimes = () => {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
};

/** Доля занятости процессора за окно в ms, от 0 до 1. */
export const busyShare = async (ms) => {
  const before = cpuTimes();
  await sleep(ms);
  const after = cpuTimes();

  const total = after.total - before.total;
  if (total <= 0) return 0;
  return 1 - (after.idle - before.idle) / total;
};

/**
 * Доля процентами — или прямое «неизвестно».
 *
 * Отсутствующее поле называется отсутствующим, а не печатается нулём.
 * `String(undefined)` даёт «undefined», а `Math.round(undefined * 100)`
 * даёт `NaN`, и оба попали бы на экран как настоящие числа.
 */
export const percent = (share) =>
  typeof share === 'number' && Number.isFinite(share)
    ? `${Math.round(share * 100)}%`
    : 'неизвестно';

/** Медиана и максимум по набору проб, или null — пробовать было нечего. */
export const summariseBusy = (seen) => {
  if (seen.length === 0) return null;

  const round = (value) => Math.round(value * 100) / 100;
  const sorted = [...seen].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);

  return { median: round(median), max: round(sorted.at(-1) ?? 0), samples: seen.length };
};

/**
 * Наблюдение за занятостью НА ПРОТЯЖЕНИИ прогона.
 *
 * Занятость, снятая до прогона, отвечает на вопрос «стоит ли начинать».
 * Записанная как обстановка всего замера, она отвечает не на тот вопрос,
 * на который её потом читают. В журнале есть запись с занятостью 24 %
 * при пороге 35 % — то есть с тихим началом — и с результатом 50 и 25
 * к/с. Объяснить её нечем, кроме нагрузки, пришедшей уже во время
 * прогона, и проверить это сегодня нечем тоже.
 *
 * Медиана и максимум, а не одно число: максимум ловит пришедшую сборку,
 * медиана говорит, была ли она случайным всплеском или всей обстановкой.
 *
 * Чтение счётчиков подставляется извне ради проверки: иначе «нагрузка
 * пришла в середине» пришлось бы устраивать по-настоящему, занимая
 * машину ровно тем, от чего замер и страхует.
 */
export const busySamples = (read = cpuTimes) => {
  let previous = read();
  const seen = [];

  return {
    /** Взять пробу за время, прошедшее с прошлой. */
    take: () => {
      const now = read();
      const total = now.total - previous.total;
      const idle = now.idle - previous.idle;
      previous = now;
      // Счётчики не сдвинулись — пробы не было. Ноль здесь читался бы
      // как «машина простаивала», а это утверждение из воздуха.
      if (total > 0) seen.push(1 - idle / total);
    },
    summary: () => summariseBusy(seen),
  };
};

/**
 * То же самое, но пробы берёт само, раз в секунду.
 *
 * Секунда выбрана против цены: проба — это две суммы по массиву ядер,
 * то есть дешевле любой из измеряемых величин, а замер идёт около
 * минуты, и шестидесяти проб хватает и на медиану, и на максимум.
 */
export const startBusySampling = ({ everyMs = 1000 } = {}) => {
  const samples = busySamples();
  const timer = setInterval(() => samples.take(), everyMs);
  // Наблюдение не должно удерживать процесс живым: замер кончился —
  // значит кончился, даже если очередная проба не подошла.
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      // Последняя проба — за хвост между предпоследним срабатыванием
      // таймера и концом прогона. Без неё нагрузка, пришедшая
      // в последние секунды, в наблюдение не попадала бы вовсе.
      samples.take();
      return samples.summary();
    },
  };
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

/**
 * Занятость, по которой судят о прогоне.
 *
 * Медиана за прогон, когда она есть; у записи старого образца —
 * единственное, что в ней вообще записано. Максимум сюда не годится:
 * по нему негодным объявлялся бы всякий прогон, где секунду поработал
 * антивирус.
 */
const judgedBusy = (entry) => entry?.busyMedian ?? entry?.busy;

/**
 * Сколько тиков в секунду шёл мир за окно замера, или null.
 *
 * Скорость не хранится, а выводится: в записи лежат тик в начале окна
 * и тик в конце. Хранить производную вместо слагаемых было бы дешевле
 * на одно поле и хуже — по двум тикам видно и скорость, и то, где
 * именно шёл замер, а по одной скорости только скорость.
 *
 * null означает «судить не о чем»: запись старого образца или окно
 * нулевой длины. Ноль на этом месте читался бы как «мир стоял».
 */
export const tickRate = (scene) => {
  if (scene === undefined || scene === null) return null;
  const { tickFrom, tickTo, windowMs } = scene;
  if (typeof tickFrom !== 'number' || typeof tickTo !== 'number') return null;
  if (typeof windowMs !== 'number' || windowMs <= 0) return null;
  return Math.round(((tickTo - tickFrom) / (windowMs / 1000)) * 10) / 10;
};

/**
 * Обстановка одной сцены человеческой строкой.
 *
 * Каждое число проходит через `figure`, и это не перестраховка ради
 * красоты. `String(undefined)` даёт «undefined», и на экране это
 * выглядит как настоящее показание — то есть ровно та беда, от которой
 * изменение и заводится: величина, которой не мерили, выдаёт себя
 * за измеренную.
 */
export const describeContext = (scene) => {
  if (scene === undefined || scene === null) return 'обстановка не снята';

  const figure = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : '—');
  const rate = tickRate(scene);

  return [
    rate === null ? 'ход мира неизвестен' : `мир ${rate} тик/с (норма ${WORLD_TICKS_PER_SECOND})`,
    `сверка ${figure(scene.syncFrom)}→${figure(scene.syncTo)}, отстаёт на ${figure(scene.syncBehind)}`,
    `связь ${figure(scene.latencyMs)} мс, ввод ${figure(scene.inputDelayTicks)} тик.`,
    `длинных кадров ${figure(scene.frameLong)}, p95 ${figure(scene.frameP95)} мс,` +
      ` макс ${figure(scene.frameMax)} мс`,
  ].join('; ');
};

// Во сколько раз ход мира вправе разойтись с проектным, прежде чем
// запись перестаёт описывать отрисовку. Полтора — с большим запасом:
// подмена, ради которой всё затевалось, шла втрое быстрее хода матча,
// а обычное окно укладывается в 30 ± 1 тик в секунду.
const TICK_RATE_TOLERANCE = 1.5;

/** Три состояния записи. «Годен» и «негоден» — выводы, третье — их отсутствие. */
export const COMPARABLE = 'годен';
export const INCOMPARABLE = 'негоден';
export const NO_CONTEXT = 'старого образца';

/**
 * Годна ли запись для сравнения — и если нет, то почему.
 *
 * Это утверждение о САМОМ ЗАМЕРЕ, а не о коде. «Упал» решает порог
 * 55 к/с и только он; «негоден» говорит, что мерилось не то. Смешав
 * их, проект получил бы красный прогон там, где померить попросту
 * не вышло, и через неделю привык бы к красному.
 *
 * Третье состояние — «старого образца». Запись без обстановки годной
 * не считается, но и негодной не объявляется: «негоден» — это вывод
 * из данных, а данных в ней нет вовсе. Проставить их задним числом
 * неоткуда, и любое проставленное значение было бы выдумкой,
 * неотличимой от измерения.
 */
export const comparability = (entry) => {
  const scenes = Object.entries(entry?.context ?? {});
  if (scenes.length === 0) {
    return { state: NO_CONTEXT, reason: 'обстановка прогона не снималась' };
  }

  const reasons = [];

  // Занятость ЗА прогон, а не до него: до прогона — это «начинать можно»,
  // и порогом допуска остаётся именно она, а здесь вопрос другой.
  const load = entry?.busyMedian;
  if (typeof load === 'number' && load > BUSY_LIMIT) {
    reasons.push(`занятость за прогон ${percent(load)} выше порога ${percent(BUSY_LIMIT)}`);
  }

  for (const [name, scene] of scenes) {
    const rate = tickRate(scene);
    if (rate === null) {
      reasons.push(`«${name}»: ход мира не измерен`);
    } else if (rate > WORLD_TICKS_PER_SECOND * TICK_RATE_TOLERANCE) {
      reasons.push(
        `«${name}»: мир шёл ${rate} тик/с вместо ${WORLD_TICKS_PER_SECOND}` +
          ' — мерился догон истории, а не отрисовка',
      );
    } else if (rate < WORLD_TICKS_PER_SECOND / TICK_RATE_TOLERANCE) {
      reasons.push(
        `«${name}»: мир шёл ${rate} тик/с вместо ${WORLD_TICKS_PER_SECOND}` +
          ' — мир почти стоял, мерить было нечего',
      );
    }

    if (
      typeof scene?.syncFrom === 'number' &&
      typeof scene?.syncTo === 'number' &&
      scene.syncTo <= scene.syncFrom
    ) {
      reasons.push(`«${name}»: сверка стояла на тике ${scene.syncTo}`);
    }
  }

  return reasons.length === 0
    ? { state: COMPARABLE, reason: null }
    : { state: INCOMPARABLE, reason: reasons.join('; ') };
};

/**
 * С чем сравнивать свежий замер — последняя СОПОСТАВИМАЯ запись
 * того же вида.
 *
 * Раньше бралась просто последняя, какой бы та ни была. Пример, почему
 * так нельзя, лежит прямо в журнале: 25.08.2026 в него легли четыре
 * прогона под искусственной нагрузкой — их снимали нарочно, ключом
 * `--force`, чтобы проверить, можно ли подстроить просадку средой.
 * Записи честные и помечены занятостью 0,65–1,00, результат до 37 и 20
 * к/с. Но следующий обычный замер взял бы «прошлый раз» именно из них,
 * и настоящая просадка на их фоне выглядела бы улучшением.
 *
 * Сопоставимой считается запись, снятая при занятости не выше того же
 * порога, при котором замер вообще допускается, и не помеченная
 * негодной. Второго порога с тем же смыслом и другим значением
 * не заводится: `BUSY_LIMIT` подобран замером на этой машине
 * и означает ровно нужное — «рядом ничего не идёт».
 *
 * Ключ `--force` в правило не входит. Он говорит о намерении
 * меряющего, а не о том, что вышло: форсировать можно и на тихой
 * машине, просто чтобы не ждать проверки.
 *
 * Возвращается ещё и число пропущенных записей — чтобы сказать вслух,
 * сколько прогонов подряд оказались несопоставимыми, а не молча
 * промолчать про сравнение.
 */
export const lastComparable = (kind, entries = readLog()) => {
  const same = entries.filter((entry) => entry.kind === kind);

  for (let index = same.length - 1; index >= 0; index -= 1) {
    const candidate = same[index];
    if (comparability(candidate).state === INCOMPARABLE) continue;

    // Проверка занятости повторяется здесь ради записей старого
    // образца: годность их не судит вовсе, а занятость в них записана
    // и говорит ровно то, что нужно.
    const load = judgedBusy(candidate);
    if (typeof load === 'number' && load > BUSY_LIMIT) continue;

    return { entry: candidate, skipped: same.length - 1 - index };
  }

  return { entry: undefined, skipped: same.length };
};

/**
 * Дописать замер в журнал и показать, что изменилось с прошлого раза.
 *
 * Пишется и провалившийся замер: провал порога — тоже число, и когда он
 * случится, важнее всего будет увидеть, каким был предыдущий прогон.
 */
export const recordEntry = ({
  kind,
  measurements,
  context,
  busy,
  load,
  forced = false,
  passed,
  unit = '',
}) => {
  const entry = {
    at: new Date().toISOString(),
    kind,
    // В контейнере git недоступен, поэтому ревизию туда передают снаружи
    // переменной `PERF_COMMIT`. Без неё замер всё равно состоится —
    // но сравнить его будет не с чем, о чём и говорит пометка.
    commit: gitOrNull('rev-parse', '--short', 'HEAD') ?? process.env['PERF_COMMIT'] ?? 'без git',
    branch: gitOrNull('rev-parse', '--abbrev-ref', 'HEAD') ?? '—',
    worktree: repoRoot,
    // Занятость ДО прогона. Поле не переименовывается и смысла
    // не меняет: сорок с лишним прежних записей означают этим именем
    // именно её, и переназначить его задним числом значило бы
    // переписать свидетельство.
    busy: Math.round(busy * 100) / 100,
    passed,
    measurements,
    // Пустой обстановки в записи не бывает: либо она есть, либо поля
    // нет вовсе. Пустой объект читался бы как «мерили и ничего
    // не намеряли», а на деле означал бы «замер про обстановку
    // не знает» — как у стоимости тика, где матча не бывает.
    ...(context !== undefined && Object.keys(context).length > 0 ? { context } : {}),
    // Занятость ЗА прогон — та, по которой замеры сравнивают
    // между собой.
    ...(load === undefined || load === null
      ? {}
      : { busyMedian: load.median, busyMax: load.max, busySamples: load.samples }),
    // Ключ `--force` говорит о намерении меряющего, а не о том,
    // что вышло: форсировать можно и на тихой машине, просто чтобы
    // не ждать проверки. Решения по нему не принимаются — он стоит
    // здесь затем, чтобы, читая журнал, не гадать, почему замер
    // состоялся при занятости 86 %.
    ...(forced ? { forced: true } : {}),
  };

  // Годность считается по обстановке и кладётся в запись вместе
  // с причиной. Считать её заново при каждом чтении журнала можно —
  // и читатели так и делают, — но человеку, открывшему файл глазами,
  // причина нужна тут же, рядом с числом.
  const verdict = comparability(entry);
  if (verdict.state !== NO_CONTEXT) {
    entry.comparable = verdict.state === COMPARABLE;
    if (verdict.reason !== null) entry.incomparable = verdict.reason;
  }

  const { entry: previous, skipped } = lastComparable(kind);
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);

  step('Записано в журнал');
  for (const [name, value] of Object.entries(measurements)) {
    const before = previous?.measurements?.[name];
    if (before === undefined) {
      note(`${name}: ${value}${unit}`);
    } else {
      const delta = Math.round((value - before) * 10) / 10;
      note(`${name}: ${value}${unit} (было ${before}${unit}, ${delta > 0 ? '+' : ''}${delta})`);
    }
    const scene = context?.[name];
    if (scene !== undefined) note(`   ${describeContext(scene)}`);
  }

  // Про сравнение говорится вслух всегда. Молчаливое сравнение
  // с несопоставимым и есть та беда, от которой всё это заводилось:
  // замер под нагрузкой даёт вдвое меньшее число, и настоящая просадка
  // на его фоне выглядит улучшением.
  if (previous === undefined) {
    note(
      skipped === 0
        ? 'сравнивать не с чем: это первый замер этого вида'
        : `сравнивать не с чем: последние ${skipped} записей сняты под нагрузкой` +
            ' или помечены негодными — число показано одиноко',
    );
  } else {
    const when = new Date(previous.at).toLocaleString('ru-RU');
    const basis = `«было» — ${previous.commit} от ${when}, занятость ${percent(judgedBusy(previous))}`;
    note(skipped === 0 ? basis : `${basis}; пропущено несопоставимых записей: ${skipped}`);
    if (comparability(previous).state === NO_CONTEXT) {
      note('   основание старого образца: кадры в нём есть, а чем занимался мир — неизвестно');
    }
  }
  if (load !== undefined && load !== null) {
    note(
      `нагрузка за прогон: медиана ${percent(load.median)}, максимум ${percent(load.max)}` +
        ` (${load.samples} проб; до прогона было ${percent(busy)})`,
    );
  }
  // Исхода прогона это не меняет: упал он или прошёл, решает всё тот же
  // порог. Пометка говорит лишь, годится ли запись как «было».
  if (verdict.state === INCOMPARABLE) {
    warn(`замер негоден для сравнения: ${verdict.reason}`);
    note('исход прогона это не меняет — но основанием для следующего замера запись не станет');
  }
  note(`журнал: ${logPath}, вся история — ключ --history`);
};

/**
 * Строка истории для одной записи журнала.
 *
 * Отдельной функцией ради проверки: печать в консоль проверять нечем,
 * а строку — можно. И проверять её надо: сорок с лишним записей
 * старого образца новых полей не имеют вовсе, а `String(undefined)`
 * и `Math.round(undefined * 100)` дают «undefined» и «NaN», которые
 * на экране неотличимы от настоящих чисел.
 */
export const historyLines = (entry) => {
  const when = new Date(entry.at).toLocaleString('ru-RU');
  const numbers = Object.entries(entry.measurements ?? {})
    .map(([name, value]) => `${name} ${value}`)
    .join(', ');

  // Занятость ДО прогона печаталась и раньше; занятость ЗА прогон
  // приписывается только там, где она снималась.
  const before = entry.busy === undefined ? '' : `  занятость ${percent(entry.busy)}`;
  const during =
    entry.busyMedian === undefined
      ? ''
      : ` (за прогон ${percent(entry.busyMedian)}, макс ${percent(entry.busyMax)})`;
  const forced = entry.forced === true ? '  [--force]' : '';
  const failed = entry.passed === false ? '  [ПОРОГ НЕ ВЗЯТ]' : '';

  // `commit` и `kind` подстрахованы прочерком по той же причине, что
  // и всё остальное: запись могла прийти из контейнера, где git
  // недоступен, и «undefined» на месте ревизии читалось бы как имя.
  const head = `  ${when}  ${entry.commit ?? '—'}  ${entry.kind ?? '?'}`;
  const lines = [`${head}: ${numbers}${before}${during}${forced}${failed}`];

  const verdict = comparability(entry);
  if (verdict.state === INCOMPARABLE) {
    lines.push(`      [НЕГОДЕН ДЛЯ СРАВНЕНИЯ] ${verdict.reason}`);
  }
  for (const [name, scene] of Object.entries(entry.context ?? {})) {
    lines.push(`      ${name}: ${describeContext(scene)}`);
  }

  return lines;
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
    for (const line of historyLines(entry)) console.log(line);
  }
  console.log('');
};
