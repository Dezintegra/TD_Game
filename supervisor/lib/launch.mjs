import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { decideLaunch } from './worktree-guard.mjs';
import { readSupervisorState, watchLogs } from './watch.mjs';

const FLAGS = ['shadow', 'dry-run', 'watch', 'foreground', 'detached', 'quiet', 'stop', 'help'];
const VALUES = ['root', 'config', 'provider'];

export function parseLaunchArgs(args) {
  const options = {};
  for (const arg of args) {
    const equal = arg.indexOf('=');
    const name = arg.startsWith('--') ? arg.slice(2, equal < 0 ? undefined : equal) : '';
    if (equal < 0 && FLAGS.includes(name)) options[name] = true;
    else if (equal >= 0 && VALUES.includes(name) && arg.slice(equal + 1))
      options[name] = arg.slice(equal + 1);
    else
      throw new Error(
        `Непонятный довод: ${arg}. Ничего не запущено — незнакомый ключ не повод поднимать конвейер.`,
      );
  }
  if (options.provider && !['claude', 'codex'].includes(options.provider))
    throw new Error(`Неизвестный provider: ${options.provider}. Ничего не запущено.`);
  const modes = ['watch', 'foreground', 'detached', 'stop'].filter((key) => options[key]);
  const launching = ['shadow', 'dry-run', 'quiet', 'provider', 'config'].filter(
    (key) => options[key],
  );
  if (modes.length > 1 || ((options.watch || options.stop) && launching.length)) {
    throw new Error(
      `Несовместимые доводы: ${[...modes, ...launching].map((key) => `--${key}`).join(', ')}. Ничего не запущено и не остановлено.`,
    );
  }
  options.mode = modes[0] ?? (options.shadow || options['dry-run'] ? 'foreground' : 'start-watch');
  return options;
}

export function launchUsage() {
  return [
    'Запуск супервизора конвейера.',
    '',
    '  (без доводов)     запустить в фоне и смотреть; Ctrl+C закрывает только наблюдение',
    '  --watch           только наблюдать, без запуска; окно закрывается свободно',
    '  --foreground      передний план; Ctrl+C даёт идущим этапам доработать и останавливает супервизор',
    '  --provider=claude|codex  исполнитель (по умолчанию из настройки, иначе claude)',
    '  --shadow          тень: считать и печатать, мира не трогать (передний план)',
    '  --detached        в фон без наблюдения, вывод в .pipeline/supervisor.out.log',
    '  --stop            снять вместе с поддеревом процессов',
    '  --quiet           молчать в консоль; журналы пишутся по-прежнему',
    '  --root=<путь>     корень проекта, если он не находится сам',
    '  --config=<путь>   настройка не из каталога инструмента',
  ].join('\n');
}

// Фабрика общая для пускателя и безопасной проверки жизни процессов.
// Родитель закрывает свои копии файлов даже при частично неудачном открытии.
export function spawnSupervisor(
  { root, argv, detached, onExit = () => {}, onError = () => {} },
  effects = {},
) {
  const io = { spawn, mkdir: mkdirSync, open: openSync, close: closeSync, ...effects };
  const descriptors = [];
  let child;
  try {
    let stdio = 'inherit';
    if (detached) {
      const localDir = join(root, '.pipeline');
      io.mkdir(localDir, { recursive: true });
      for (const name of ['out', 'err'])
        descriptors.push(io.open(join(localDir, `supervisor.${name}.log`), 'a'));
      stdio = ['ignore', ...descriptors];
    }
    child = io.spawn(
      process.execPath,
      argv,
      detached ? { cwd: root, detached: true, stdio, windowsHide: true } : { cwd: root, stdio },
    );
  } finally {
    for (const fd of descriptors) io.close(fd);
  }
  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      onError(error);
      reject(error);
    });
    child.once('exit', (code, signal) => onExit({ code, signal }));
    child.once('spawn', () => {
      if (detached) child.unref();
      resolve(child);
    });
  });
}

export async function runLaunch(
  { options, root, entry, gitFile = null, explicitRoot = null, signal },
  effects = {},
) {
  const io = {
    log: console.log,
    error: console.error,
    exists: existsSync,
    remove: rmSync,
    state: readSupervisorState,
    spawn: spawnSupervisor,
    watch: watchLogs,
    sleep,
    now: Date.now,
    ...effects,
  };
  const decision = decideLaunch({ root, gitFile, explicitRoot });
  if (!decision.launch) {
    io.error(decision.message);
    return 1;
  }
  // Даже watch проходит тот же ранний сторож, но не требует supervise на диске.
  if (options.mode !== 'watch' && !io.exists(entry)) {
    io.error(`Не найден сам супервизор: ${entry}`);
    io.error('Пускатель обязан лежать в каталоге инструмента, рядом с ним.');
    return 1;
  }
  const localDir = join(root, '.pipeline');
  const lockPath = join(localDir, 'supervisor.lock');
  const state = await io.state(lockPath);
  if (state.kind === 'unknown' && options.mode !== 'watch') {
    io.error(
      `Не удалось установить владельца замка: ${state.reason}. Повторите запуск после устранения причины.`,
    );
    return 1;
  }
  const live = state.kind === 'live' ? state.pid : null;
  if (options.mode === 'stop') {
    if (!live) {
      io.log('Супервизор не работает.');
      if (io.exists(lockPath)) {
        io.remove(lockPath);
        io.log('Брошенный замок убран.');
      }
      return 0;
    }
    const beforeStop = await io.state(lockPath);
    if (beforeStop.kind !== 'live' || beforeStop.pid !== live) {
      io.error('Владелец замка изменился или недоступен; остановка отменена.');
      return 1;
    }
    io.log(`Снимаю супервизор (процесс ${live}) вместе с поддеревом...`);
    io.killTree(live);
    await io.sleep(500);
    if ((await io.state(lockPath)).kind === 'live') {
      io.error(`Процесс ${live} не снялся.`);
      return 1;
    }
    if (io.exists(lockPath)) io.remove(lockPath);
    io.log('Снят.');
    io.log('');
    io.log('Если этап шёл, он снят на полуслове. Задача не потеряна:');
    io.log('следующий запуск выдаст ей продолжение той же сессией.');
    io.log('');
    io.log('Останавливать лучше через Ctrl+C в окне --foreground: сигнал он');
    io.log('ловит и даёт идущему этапу доработать, прежде чем снять.');
    return 0;
  }
  const watching = options.mode === 'watch' || options.mode === 'start-watch';
  if (live && options.mode !== 'watch') {
    io.log(`СУПЕРВИЗОР УЖЕ РАБОТАЕТ: процесс ${live}.`);
    io.log('Двойного запуска не будет — замок отсёк бы второй экземпляр и сам.');
    io.log('Снять: start --stop');
    if (!watching) return 0;
    io.log('Параметры запуска существующий процесс не меняют. Подключаю наблюдение.');
  }
  if (watching) {
    io.log(`НАБЛЮДЕНИЕ. Корень проекта: ${root}`);
    io.log(
      'Закрытие окна и Ctrl+C закрывают только наблюдение; супервизор и этапы продолжают работу.',
    );
    io.log(
      'Показаны файловые журналы. Старый foreground не записывал сюда stdout; для него нужен штатный перезапуск владельцем.',
    );
    if (options.quiet)
      io.log('--quiet: подробный stdout приглушён; статус и доступный stderr остаются видны.');
  }
  let confirmed = live !== null || options.mode === 'watch';
  let earlyExit;
  let spawnError;
  let child;
  if (!live && options.mode !== 'watch') {
    const argv = [entry];
    if (options.provider) argv.push(`--provider=${options.provider}`);
    if (options.shadow || options['dry-run']) argv.push('--dry-run');
    if (options.quiet) argv.push('--quiet');
    if (options.config) argv.push(`--config=${options.config}`);
    argv.push(root);
    if (options.mode === 'foreground')
      io.log('ПЕРЕДНИЙ ПЛАН: Ctrl+C даёт идущим этапам доработать и останавливает супервизор.');
    else if (watching) io.log('Ожидание запуска: живой PID должен появиться в замке.');
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    try {
      child = await io.spawn({
        root,
        argv,
        detached: options.mode !== 'foreground',
        onExit: (result) => {
          earlyExit = result;
          resolveExit(result.code ?? 0);
        },
        onError: (error) => {
          spawnError = error;
          resolveExit(1);
        },
      });
    } catch (error) {
      io.error(`Запуск не удался: ${error.message}`);
      return 1;
    }
    if (options.mode === 'foreground') return exited;
    if (options.mode === 'detached') {
      const outPath = join(localDir, 'supervisor.out.log');
      io.log(`Супервизор запущен в фоне, процесс ${child.pid}.`);
      io.log(`Вывод: ${outPath}`);
      io.log('');
      io.log('Смотреть за ним:');
      io.log(`  Get-Content '${outPath}' -Wait -Tail 40 -Encoding UTF8   (PowerShell)`);
      io.log(`  tail -f '${outPath}'                                      (sh)`);
      io.log('Снять:');
      io.log('  start --stop');
      return 0;
    }
  }
  const deadline = io.now() + 10_000;
  try {
    await io.watch({
      root,
      signal,
      afterTick: (current) => {
        if (confirmed) return;
        // Конкурент мог взять замок первым; подключаемся к живому победителю.
        if (current.kind === 'live') {
          confirmed = true;
          return;
        }
        if (earlyExit || spawnError)
          throw new Error(
            `Запуск не удался: ${spawnError?.message ?? `процесс завершился (${earlyExit.code ?? earlyExit.signal})`}. Хвост stderr показан выше.`,
          );
        if (io.now() >= deadline)
          throw new Error(
            'Запуск не подтверждён за 10 секунд. Потенциально живой процесс не остановлен.',
          );
      },
    });
    return 0;
  } catch (error) {
    io.error(error.message);
    return 1;
  }
}
