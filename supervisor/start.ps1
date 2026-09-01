#Requires -Version 5.1
<#
.SYNOPSIS
    Запуск супервизора конвейера агентской разработки.

.DESCRIPTION
    Тонкая обёртка над `bin/supervise.mjs`: находит корень проекта, готовит
    консоль к русскому выводу, отсекает двойной запуск по замку и запускает.
    Решений скрипт не принимает — всё, что он умеет, это донести запуск
    до Node, не потеряв по дороге кодировку и путь.

    По умолчанию запускает В ОКНЕ, выводом на экран: ради этого вывод
    и делался — запустил и смотришь, что происходит. Ключ -Detached уводит
    в фон с записью в файл, и он же нужен сторожу в планировщике.

.PARAMETER Detached
    Запустить в фоне, вывод — в `.pipeline/supervisor.out.log`.

.PARAMETER Shadow
    Режим тени: считать и печатать, мира не трогать (`--dry-run`).

.PARAMETER Quiet
    Молчать в консоль. Журналы пишутся по-прежнему.

.PARAMETER Stop
    Снять работающий супервизор вместе со всем поддеревом процессов.

.PARAMETER ProjectRoot
    Корень проекта. По умолчанию ищется вверх от каталога скрипта
    до каталога с `.git`.

.PARAMETER ConfigPath
    Настройка не из каталога инструмента.

.EXAMPLE
    .\supervisor\start.ps1
    Запустить и смотреть.

.EXAMPLE
    .\supervisor\start.ps1 -Shadow
    Посмотреть, что конвейер собирается делать, ничего не трогая.

.EXAMPLE
    .\supervisor\start.ps1 -Detached
    Запустить в фоне; вывод уедет в .pipeline/supervisor.out.log.

.EXAMPLE
    .\supervisor\start.ps1 -Stop
    Снять работающий супервизор.
#>
[CmdletBinding()]
param(
    [switch] $Detached,
    [switch] $Shadow,
    [switch] $Quiet,
    [switch] $Stop,
    [string] $ProjectRoot,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'

# Вывод супервизора русский, а консоль Windows по умолчанию говорит
# на кодовой странице 866. Без этой строки все строки приходят мохибейком,
# и наблюдать за конвейером становится нечем — ровно то, ради чего подробный
# вывод и заводился. В try, потому что при перенаправлении в файл консоли
# может не быть вовсе, и падать из-за этого незачем.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    Write-Verbose 'кодировку консоли сменить не удалось: вывода на экран, похоже, нет'
}

# Каталог самого инструмента. Имя $Home занято: это автоматическая переменная
# PowerShell (домашний каталог пользователя), и присвоение ей увело бы пути
# не туда — молча и с трудноуловимыми последствиями.
$toolDir = $PSScriptRoot

<#
    Корень проекта: вверх от каталога инструмента до каталога с `.git`.

    Проверяется именно наличие, а не тип: у рабочего дерева `.git` — это файл
    со ссылкой, а не каталог, и проверка на каталог отвергла бы всякий воркри.
#>
function Find-ProjectRoot {
    param([string] $StartAt)

    $dir = Get-Item -LiteralPath $StartAt
    for ($depth = 0; $depth -lt 10 -and $null -ne $dir; $depth += 1) {
        if (Test-Path -LiteralPath (Join-Path $dir.FullName '.git')) { return $dir.FullName }
        $dir = $dir.Parent
    }
    return $null
}

$root = $ProjectRoot
if (-not $root) { $root = $env:PIPELINE_ROOT }
if (-not $root) { $root = Find-ProjectRoot -StartAt $toolDir }

if (-not $root -or -not (Test-Path -LiteralPath $root)) {
    Write-Host 'Не найден корень проекта: вверх от каталога инструмента нет ни одного каталога с .git.' -ForegroundColor Red
    Write-Host 'Назовите его прямо: .\start.ps1 -ProjectRoot C:\путь\к\проекту' -ForegroundColor Yellow
    exit 1
}
$root = (Resolve-Path -LiteralPath $root).Path

$entry = Join-Path $toolDir 'bin\supervise.mjs'
if (-not (Test-Path -LiteralPath $entry)) {
    Write-Host "Не найден сам супервизор: $entry" -ForegroundColor Red
    Write-Host 'Скрипт обязан лежать в каталоге инструмента, рядом с bin/.' -ForegroundColor Yellow
    exit 1
}

$localDir = Join-Path $root '.pipeline'
$lockPath = Join-Path $localDir 'supervisor.lock'

<#
    Номер процесса живого супервизора, если он есть.

    Замок переживает жёсткое убийство, и это не беда: в нём лежит номер
    процесса, и мёртвый номер означает брошенный замок, а не работающего
    соседа. Поэтому спрашиваем систему, а не сам факт существования файла.
#>
function Get-LiveSupervisor {
    if (-not (Test-Path -LiteralPath $lockPath)) { return $null }
    try {
        $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
    if (-not $lock.pid) { return $null }
    if (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue) { return [int] $lock.pid }
    return $null
}

if ($Stop) {
    $live = Get-LiveSupervisor
    if (-not $live) {
        Write-Host 'Супервизор не работает.'
        if (Test-Path -LiteralPath $lockPath) {
            Remove-Item -LiteralPath $lockPath -Force
            Write-Host 'Брошенный замок убран.'
        }
        exit 0
    }

    # Снимается ПОДДЕРЕВО, а не один процесс: этап порождает git, pnpm, gh
    # и браузер, и осиротевший потомок удерживает каталог рабочего дерева
    # не хуже зависшей сессии — уборка потом падает на «каталог занят».
    Write-Host "Снимаю супервизор (процесс $live) вместе с поддеревом..."
    & taskkill.exe /PID $live /T /F | Out-Null
    Start-Sleep -Milliseconds 500

    if (Get-Process -Id $live -ErrorAction SilentlyContinue) {
        Write-Host "Процесс $live не снялся." -ForegroundColor Red
        exit 1
    }
    if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force }
    Write-Host 'Снят.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Идущий этап при этом снят на полуслове. Задача не потеряна:' -ForegroundColor Yellow
    Write-Host 'следующий запуск выдаст ей продолжение, возобновляющее ту же сессию.' -ForegroundColor Yellow
    exit 0
}

$live = Get-LiveSupervisor
if ($live) {
    Write-Host "СУПЕРВИЗОР УЖЕ РАБОТАЕТ: процесс $live." -ForegroundColor Yellow
    Write-Host 'Двойного запуска не будет — замок отсёк бы второй экземпляр и сам.'
    Write-Host 'Снять: .\start.ps1 -Stop'
    exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'Не найдена Node. Супервизор — обычная программа на Node, без неё не запустится ничего.' -ForegroundColor Red
    Write-Host 'Нужна версия 20.12 и новее: на ней появилось чтение .env.' -ForegroundColor Yellow
    exit 1
}

$nodeArgs = @($entry)
if ($Shadow) { $nodeArgs += '--dry-run' }
if ($Quiet) { $nodeArgs += '--quiet' }
if ($ConfigPath) { $nodeArgs += "--config=$ConfigPath" }
# Корень передаётся доводом, а не оставляется на угадывание: скрипт его уже
# нашёл, и пусть обе стороны говорят об одном и том же каталоге.
$nodeArgs += $root

if (-not $Detached) {
    # Прямо здесь, выводом на экран. Останавливается Ctrl+C — и это лучший
    # способ остановки: супервизор ловит сигнал, даёт идущему этапу
    # доработать и лишь затем снимает его поддеревом.
    & $node.Source @nodeArgs
    exit $LASTEXITCODE
}

New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$outLog = Join-Path $localDir 'supervisor.out.log'
$errLog = Join-Path $localDir 'supervisor.err.log'

# Два разных файла, а не один: PowerShell отвергает одинаковые пути
# у обоих перенаправлений. Прошлый вывод затирается — история работы живёт
# в cycle.log и в журналах этапов, а этот файл нужен для «что там сейчас».
$started = Start-Process -FilePath $node.Source -ArgumentList $nodeArgs `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

Write-Host "Супервизор запущен в фоне, процесс $($started.Id)." -ForegroundColor Green
Write-Host "Вывод: $outLog"
Write-Host ''
Write-Host 'Смотреть за ним:'
Write-Host "  Get-Content '$outLog' -Wait -Tail 40 -Encoding UTF8"
Write-Host 'Снять:'
Write-Host '  .\start.ps1 -Stop'
