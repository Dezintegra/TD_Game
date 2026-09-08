# Тайм-ауты зеркала baseline: прогон 33430184681

Гипотеза единого взаимного истощения не подтверждена. Все 11 тайм-аутов
сохраняют за последние пять минут снижение HP обеих баз и заказы войск обеими
сторонами. Давление в среднем усиливается к концу, а не исчезает. Паузы и
асимметрия есть: в последнюю минуту только seed 42 не показывает снижения HP
ни одной базы; это отдельный случай для дальнейшего разбора доставки урона.
Утверждать, что остальные обязательно скоро закончились бы, также нельзя.

## Источник и воспроизведение

- [Прогон 33430184681](https://github.com/Dezintegra/TD_Game/actions/runs/33430184681), success, 31.08.2026.
- [Независимый job log 99613388157](https://github.com/Dezintegra/TD_Game/actions/runs/33430184681/job/99613388157): все 60 строк исходов сверены по seed, не только итог 11/49.
- Артефакт arena-33430184681, id 9772372513, скачан 08.09.2026; архив 37 087 607 байт, expired=false, expires_at 30.09.2026. Внутри SQLite: .matchlog/arena.sqlite.
- SHA workflow и каждого match: 69bf0809e7ed2e3aa4be5a1e5f9265b1823aaacf; git_dirty=0 у всех 60. Профиль 0/1: baseline-2026-08.
- SHA256 SQLite: 80de6cee1531ef0ed61bf67d3db86f7536ff08abe99a8aa94088c99db70ca4e5. Это хеш распакованной базы, не архива.
- Внешние параметры: run, 30 тиков/с, предел 1200 с. Match не хранит tuning и tickCap. Частота и стандартный предел проверены в исторических [constants.ts](https://github.com/Dezintegra/TD_Game/blob/69bf0809e7ed2e3aa4be5a1e5f9265b1823aaacf/packages/shared/src/constants.ts) и [match.ts](https://github.com/Dezintegra/TD_Game/blob/69bf0809e7ed2e3aa4be5a1e5f9265b1823aaacf/apps/arena/src/match.ts), длительности timeout — также в job log. Эти сведения не выдаются за колонки SQLite.

Из корня назначенного дерева, команды по одной:

```powershell
gh run download 33430184681 --name arena-33430184681 --dir .matchlog/0050-source
node scripts/analysis/mirror-timeouts.mjs --db .matchlog/0050-source/.matchlog/arena.sqlite --run 33430184681 --sha 69bf0809e7ed2e3aa4be5a1e5f9265b1823aaacf --profile baseline-2026-08 --seed-start 1 --matches 60 --ticks-per-second 30 --cap-seconds 1200 --out .matchlog/0050-source/result.json
```

В автономном implement тот же CLI вызван разрешённой обёрткой

```js
import { runCli } from '../scripts/analysis/mirror-timeouts.mjs';
process.exitCode = runCli(process.argv.slice(2));
```

Файл обёртки — .matchlog/0050-analyze.mjs; команда та же с заменой имени скрипта.
Без --out прибор печатает полный Markdown. Повторный анализ дал идентичный JSON
и Markdown; SHA256 до и после совпал. База не пересобиралась, replay и новые
матчи не запускались. Игровые правила, ИИ и текущие константы не подменяют источник.

## Определения и покрытия

Единица сравнения — матч. Для каждой метрики сначала среднее двух годных сторон,
затем равновесные среднее и квартильные показатели по матчам. Медиана/Q1/Q3 —
линейная интерполяция индекса (n−1)×p. В таблицах n — годные матчи; sides — все
годные стороны (включая сторону без годной пары); missing — негодные среди
доживших. pooled — отдельно сумма числителей/знаменателей сторон, не средний матч.

Первые 120 снимков на тике 30 имеют HP=40000. Этот наблюдённый HP, с его тиком,
служит ориентиром; он не называется максимальным или полным здоровьем.
Первое наблюдение уже включает ранние решения. В восьми завершённых мирах
(13, 22, 28, 41, 48, 53, 54, 55) на тике 30 у одной или обеих сторон есть
3–4 башни и 0–1 юнит; таких сторон девять. У всех 11 timeout первый снимок
показывает 0 башен и 2 юнита с каждой стороны. Это ещё одно различие начального
наблюдения, связанное с миром и ранним поведением; его нельзя считать
случайно назначенным воздействием или доказательством пользы башен.
HP, энергия — целые единицы исторической базы; доход — энергия/тик, численности —
объекты, queue_len — очередь, upgrade_total_level — сумма уровней. Δ = конец
минус начало, в том числе положительная ΔHP сохраняется. Пик башен/стен включает
недострой; разность с концом — сокращение относительно пика, не число уничтожений.

Отсечки 300/600/900/1200 с = 9000/18000/27000/36000 тиков. Матч, завершившийся
раньше, исключён, даже если его последний sample ближе секунды. Для состояния
допустим последний sample не старше секунды. Интервал использует a < tick ≤ b,
первый a=30, поэтому первый интервал имеет 299 sample на сторону, остальные — 300. Разности используют один матч на обоих концах; средние на соседних отсечках
вычитать нельзя из-за изменения состава. Lifetime охватывает всю запись; в
завершённом матче последнее состояние может предшествовать footer до секунды.

В базе 92214 sample и 184564 decision. Секундные сетки наблюдаемых интервалов
полны, у доживших нет пропусков основных состояний/долей времени. Нулевые
знаменатели дальних решений встречаются: это отсутствие наблюдаемого дальнего
решения, а не 0% одиночества. За lifetime для far_unescorted годны 11 матчей
тайм-аутов (22 стороны) и 40 завершённых (89 отдельных сторон, 9 негодных пар).
В отдельных окнах n уменьшается дополнительно, что показано ниже.

general_dead = sample с general_alive=0 / все sample окна; это не точное число
смертей. no_path = path_to_enemy=0 / все sample. Ни один из 92214 sample не
имеет no_path: зарегистрированная блокировка пути этим источником не поддержана.
hp_decrease_steps считает соседние секундные снижения HP, не весь нанесённый урон.
Хвост без снижения измерен от последнего снижения до последнего sample, а не
до предполагаемой будущей победы; секундный шаг не видит всё внутри секунды.

far_unescorted: nearby_units=0 среди decision с approach_shortest>0,
general_from_home>=0 и отношением >0.5. with_army добавляет live_units>0 при том
же знаменателе. bought — решение хотя бы с одним result=bought; saving —
хотя бы wait или note=saving-for-better; impatient — флаг impatient=1. Они могут
пересекаться. TrainUnit — только kind=2, accepted=1, по собственному тику команды;
это заказ, не рождение. Attempt и decision не размножают sample. Числители и
знаменатели в индивидуальных таблицах записаны в квадратных скобках.

Timeout — цензурирование на 1200 с без победителя. Группы выбраны по будущему
исходу и разным мирам; это описательное сравнение, не парный причинный тест.
Отбор доживших и сравнение всей жизни с разной длиной ограничивают интерпретацию.
На двадцатой минуте завершённых матчей нет: «—» не означает нулевую силу.

## Состав и длительности

| group          | n   | mean seconds | Q1       | median   | Q3    | interpretation              |
| -------------- | --- | ------------ | -------- | -------- | ----- | --------------------------- |
| timeout        | 11  | 1200         | 1200     | 1200     | 1200  | нижняя граница, winner=null |
| base-destroyed | 49  | 672.0252     | 467.6667 | 676.2333 | 883.7 | наблюдённый снос базы       |

Timeout seed: 2, 3, 5, 11, 17, 23, 32, 39, 42, 58, 60. 11/60 = 18.3333%. Это не доказательство нарушения проектного потолка 20%; предмет отчёта — устройство хвоста.

| match_id                                 | seed | ai_seed_0  | ai_seed_1 | ticks | reason         | winner |
| ---------------------------------------- | ---- | ---------- | --------- | ----- | -------------- | ------ |
| s1-baseline-2026-08-vs-baseline-2026-08  | 1    | 1542469172 | 795744886 | 9601  | base-destroyed | 1      |
| s2-baseline-2026-08-vs-baseline-2026-08  | 2    | 1542469175 | 795744885 | 36000 | timeout        | —      |
| s3-baseline-2026-08-vs-baseline-2026-08  | 3    | 1542469174 | 795744884 | 36000 | timeout        | —      |
| s4-baseline-2026-08-vs-baseline-2026-08  | 4    | 1542469169 | 795744883 | 19187 | base-destroyed | 1      |
| s5-baseline-2026-08-vs-baseline-2026-08  | 5    | 1542469168 | 795744882 | 36000 | timeout        | —      |
| s6-baseline-2026-08-vs-baseline-2026-08  | 6    | 1542469171 | 795744881 | 5634  | base-destroyed | 1      |
| s7-baseline-2026-08-vs-baseline-2026-08  | 7    | 1542469170 | 795744880 | 12602 | base-destroyed | 1      |
| s8-baseline-2026-08-vs-baseline-2026-08  | 8    | 1542469181 | 795744895 | 22314 | base-destroyed | 0      |
| s9-baseline-2026-08-vs-baseline-2026-08  | 9    | 1542469180 | 795744894 | 25715 | base-destroyed | 1      |
| s10-baseline-2026-08-vs-baseline-2026-08 | 10   | 1542469183 | 795744893 | 14921 | base-destroyed | 1      |
| s11-baseline-2026-08-vs-baseline-2026-08 | 11   | 1542469182 | 795744892 | 36000 | timeout        | —      |
| s12-baseline-2026-08-vs-baseline-2026-08 | 12   | 1542469177 | 795744891 | 8679  | base-destroyed | 0      |
| s13-baseline-2026-08-vs-baseline-2026-08 | 13   | 1542469176 | 795744890 | 32715 | base-destroyed | 1      |
| s14-baseline-2026-08-vs-baseline-2026-08 | 14   | 1542469179 | 795744889 | 6538  | base-destroyed | 1      |
| s15-baseline-2026-08-vs-baseline-2026-08 | 15   | 1542469178 | 795744888 | 34288 | base-destroyed | 0      |
| s16-baseline-2026-08-vs-baseline-2026-08 | 16   | 1542469157 | 795744871 | 32346 | base-destroyed | 0      |
| s17-baseline-2026-08-vs-baseline-2026-08 | 17   | 1542469156 | 795744870 | 36000 | timeout        | —      |
| s18-baseline-2026-08-vs-baseline-2026-08 | 18   | 1542469159 | 795744869 | 22047 | base-destroyed | 1      |
| s19-baseline-2026-08-vs-baseline-2026-08 | 19   | 1542469158 | 795744868 | 19543 | base-destroyed | 1      |
| s20-baseline-2026-08-vs-baseline-2026-08 | 20   | 1542469153 | 795744867 | 23411 | base-destroyed | 0      |
| s21-baseline-2026-08-vs-baseline-2026-08 | 21   | 1542469152 | 795744866 | 27766 | base-destroyed | 0      |
| s22-baseline-2026-08-vs-baseline-2026-08 | 22   | 1542469155 | 795744865 | 6313  | base-destroyed | 1      |
| s23-baseline-2026-08-vs-baseline-2026-08 | 23   | 1542469154 | 795744864 | 36000 | timeout        | —      |
| s24-baseline-2026-08-vs-baseline-2026-08 | 24   | 1542469165 | 795744879 | 24084 | base-destroyed | 0      |
| s25-baseline-2026-08-vs-baseline-2026-08 | 25   | 1542469164 | 795744878 | 18725 | base-destroyed | 0      |
| s26-baseline-2026-08-vs-baseline-2026-08 | 26   | 1542469167 | 795744877 | 19113 | base-destroyed | 1      |
| s27-baseline-2026-08-vs-baseline-2026-08 | 27   | 1542469166 | 795744876 | 18711 | base-destroyed | 1      |
| s28-baseline-2026-08-vs-baseline-2026-08 | 28   | 1542469161 | 795744875 | 31678 | base-destroyed | 1      |
| s29-baseline-2026-08-vs-baseline-2026-08 | 29   | 1542469160 | 795744874 | 20380 | base-destroyed | 0      |
| s30-baseline-2026-08-vs-baseline-2026-08 | 30   | 1542469163 | 795744873 | 14165 | base-destroyed | 0      |
| s31-baseline-2026-08-vs-baseline-2026-08 | 31   | 1542469162 | 795744872 | 27975 | base-destroyed | 0      |
| s32-baseline-2026-08-vs-baseline-2026-08 | 32   | 1542469141 | 795744855 | 36000 | timeout        | —      |
| s33-baseline-2026-08-vs-baseline-2026-08 | 33   | 1542469140 | 795744854 | 27220 | base-destroyed | 0      |
| s34-baseline-2026-08-vs-baseline-2026-08 | 34   | 1542469143 | 795744853 | 32723 | base-destroyed | 1      |
| s35-baseline-2026-08-vs-baseline-2026-08 | 35   | 1542469142 | 795744852 | 16494 | base-destroyed | 1      |
| s36-baseline-2026-08-vs-baseline-2026-08 | 36   | 1542469137 | 795744851 | 32281 | base-destroyed | 1      |
| s37-baseline-2026-08-vs-baseline-2026-08 | 37   | 1542469136 | 795744850 | 9319  | base-destroyed | 1      |
| s38-baseline-2026-08-vs-baseline-2026-08 | 38   | 1542469139 | 795744849 | 5605  | base-destroyed | 1      |
| s39-baseline-2026-08-vs-baseline-2026-08 | 39   | 1542469138 | 795744848 | 36000 | timeout        | —      |
| s40-baseline-2026-08-vs-baseline-2026-08 | 40   | 1542469149 | 795744863 | 17991 | base-destroyed | 0      |
| s41-baseline-2026-08-vs-baseline-2026-08 | 41   | 1542469148 | 795744862 | 11350 | base-destroyed | 0      |
| s42-baseline-2026-08-vs-baseline-2026-08 | 42   | 1542469151 | 795744861 | 36000 | timeout        | —      |
| s43-baseline-2026-08-vs-baseline-2026-08 | 43   | 1542469150 | 795744860 | 25305 | base-destroyed | 0      |
| s44-baseline-2026-08-vs-baseline-2026-08 | 44   | 1542469145 | 795744859 | 12024 | base-destroyed | 1      |
| s45-baseline-2026-08-vs-baseline-2026-08 | 45   | 1542469144 | 795744858 | 18825 | base-destroyed | 1      |
| s46-baseline-2026-08-vs-baseline-2026-08 | 46   | 1542469147 | 795744857 | 13263 | base-destroyed | 1      |
| s47-baseline-2026-08-vs-baseline-2026-08 | 47   | 1542469146 | 795744856 | 20287 | base-destroyed | 1      |
| s48-baseline-2026-08-vs-baseline-2026-08 | 48   | 1542469125 | 795744839 | 14030 | base-destroyed | 0      |
| s49-baseline-2026-08-vs-baseline-2026-08 | 49   | 1542469124 | 795744838 | 26511 | base-destroyed | 0      |
| s50-baseline-2026-08-vs-baseline-2026-08 | 50   | 1542469127 | 795744837 | 26739 | base-destroyed | 1      |
| s51-baseline-2026-08-vs-baseline-2026-08 | 51   | 1542469126 | 795744836 | 25426 | base-destroyed | 0      |
| s52-baseline-2026-08-vs-baseline-2026-08 | 52   | 1542469121 | 795744835 | 29822 | base-destroyed | 1      |
| s53-baseline-2026-08-vs-baseline-2026-08 | 53   | 1542469120 | 795744834 | 21425 | base-destroyed | 0      |
| s54-baseline-2026-08-vs-baseline-2026-08 | 54   | 1542469123 | 795744833 | 21662 | base-destroyed | 0      |
| s55-baseline-2026-08-vs-baseline-2026-08 | 55   | 1542469122 | 795744832 | 10903 | base-destroyed | 1      |
| s56-baseline-2026-08-vs-baseline-2026-08 | 56   | 1542469133 | 795744847 | 18335 | base-destroyed | 0      |
| s57-baseline-2026-08-vs-baseline-2026-08 | 57   | 1542469132 | 795744846 | 23734 | base-destroyed | 0      |
| s58-baseline-2026-08-vs-baseline-2026-08 | 58   | 1542469135 | 795744845 | 36000 | timeout        | —      |
| s59-baseline-2026-08-vs-baseline-2026-08 | 59   | 1542469134 | 795744844 | 28152 | base-destroyed | 0      |
| s60-baseline-2026-08-vs-baseline-2026-08 | 60   | 1542469129 | 795744843 | 36000 | timeout        | —      |

## Сравнение групп на общих отсечках

В таблицах mean и квартильные величины относятся к среднему двух сторон одного матча.

### 300 секунд

| group          | metric                  | n   | sides | ended earlier | missing | mean       | Q1        | median  | Q3        | pooled n/d or observations |
| -------------- | ----------------------- | --- | ----- | ------------- | ------- | ---------- | --------- | ------- | --------- | -------------------------- |
| timeout        | base_hp_end             | 11  | 22    | 0             | 0       | 37741.1364 | 36862.75  | 38287.5 | 38962.75  | 22                         |
| timeout        | units_alive_end         | 11  | 22    | 0             | 0       | 5.4545     | 4.25      | 5.5     | 6.25      | 22                         |
| timeout        | towers_end              | 11  | 22    | 0             | 0       | 1.3636     | 1         | 1.5     | 1.5       | 22                         |
| timeout        | walls_end               | 11  | 22    | 0             | 0       | 7.5        | 4.5       | 7       | 10.25     | 22                         |
| timeout        | energy_end              | 11  | 22    | 0             | 0       | 1133.9091  | 832       | 1163.5  | 1416.25   | 22                         |
| timeout        | income_per_tick_end     | 11  | 22    | 0             | 0       | 16.7727    | 17        | 17      | 17        | 22                         |
| timeout        | queue_len_end           | 11  | 22    | 0             | 0       | 0          | 0         | 0       | 0         | 22                         |
| timeout        | upgrade_total_level_end | 11  | 22    | 0             | 0       | 27.4545    | 26.5      | 28.5    | 29        | 22                         |
| timeout        | general_alive_end       | 11  | 22    | 0             | 0       | 1          | 1         | 1       | 1         | 22                         |
| timeout        | general_hp_end          | 11  | 22    | 0             | 0       | 101.1364   | 56.75     | 101     | 136.75    | 22                         |
| base-destroyed | base_hp_end             | 44  | 88    | 5             | 0       | 34091.6136 | 32463.875 | 35606   | 38171.625 | 88                         |
| base-destroyed | units_alive_end         | 44  | 88    | 5             | 0       | 6.7727     | 5.875     | 6.5     | 7.5       | 88                         |
| base-destroyed | towers_end              | 44  | 88    | 5             | 0       | 1.2273     | 0.5       | 1       | 1.5       | 88                         |
| base-destroyed | walls_end               | 44  | 88    | 5             | 0       | 6.5909     | 4         | 6.5     | 8.625     | 88                         |
| base-destroyed | energy_end              | 44  | 88    | 5             | 0       | 1025.7045  | 713.125   | 1013.25 | 1361.75   | 88                         |
| base-destroyed | income_per_tick_end     | 44  | 88    | 5             | 0       | 15.3864    | 14        | 16      | 17        | 88                         |
| base-destroyed | queue_len_end           | 44  | 88    | 5             | 0       | 0          | 0         | 0       | 0         | 88                         |
| base-destroyed | upgrade_total_level_end | 44  | 88    | 5             | 0       | 24.1591    | 20.75     | 24.75   | 27.25     | 88                         |
| base-destroyed | general_alive_end       | 44  | 88    | 5             | 0       | 0.8864     | 1         | 1       | 1         | 88                         |
| base-destroyed | general_hp_end          | 44  | 88    | 5             | 0       | 108.2841   | 75.75     | 105     | 143       | 88                         |

### 600 секунд

| group          | metric                  | n   | sides | ended earlier | missing | mean       | Q1      | median  | Q3       | pooled n/d or observations |
| -------------- | ----------------------- | --- | ----- | ------------- | ------- | ---------- | ------- | ------- | -------- | -------------------------- |
| timeout        | base_hp_end             | 11  | 22    | 0             | 0       | 34786.1364 | 32375.5 | 34125.5 | 37849.5  | 22                         |
| timeout        | units_alive_end         | 11  | 22    | 0             | 0       | 4.0909     | 3.5     | 4.5     | 4.75     | 22                         |
| timeout        | towers_end              | 11  | 22    | 0             | 0       | 1.4091     | 1       | 1       | 2        | 22                         |
| timeout        | walls_end               | 11  | 22    | 0             | 0       | 15.4091    | 9.25    | 19      | 20.75    | 22                         |
| timeout        | energy_end              | 11  | 22    | 0             | 0       | 1231.6818  | 1064.25 | 1226.5  | 1480     | 22                         |
| timeout        | income_per_tick_end     | 11  | 22    | 0             | 0       | 16.7727    | 17      | 17      | 17       | 22                         |
| timeout        | queue_len_end           | 11  | 22    | 0             | 0       | 0          | 0       | 0       | 0        | 22                         |
| timeout        | upgrade_total_level_end | 11  | 22    | 0             | 0       | 40.1364    | 38.75   | 40      | 42       | 22                         |
| timeout        | general_alive_end       | 11  | 22    | 0             | 0       | 0.8636     | 0.75    | 1       | 1        | 22                         |
| timeout        | general_hp_end          | 11  | 22    | 0             | 0       | 91.2273    | 58.5    | 73.5    | 102.25   | 22                         |
| base-destroyed | base_hp_end             | 32  | 64    | 17            | 0       | 26918.1563 | 23092   | 26692.5 | 32094.75 | 64                         |
| base-destroyed | units_alive_end         | 32  | 64    | 17            | 0       | 5.4688     | 4       | 5.25    | 6        | 64                         |
| base-destroyed | towers_end              | 32  | 64    | 17            | 0       | 1.3594     | 0.5     | 1.5     | 2        | 64                         |
| base-destroyed | walls_end               | 32  | 64    | 17            | 0       | 13.0625    | 9       | 12.75   | 15.625   | 64                         |
| base-destroyed | energy_end              | 32  | 64    | 17            | 0       | 1377.2969  | 934.625 | 1159.5  | 1556.875 | 64                         |
| base-destroyed | income_per_tick_end     | 32  | 64    | 17            | 0       | 15.875     | 15      | 16.5    | 17       | 64                         |
| base-destroyed | queue_len_end           | 32  | 64    | 17            | 0       | 0          | 0       | 0       | 0        | 64                         |
| base-destroyed | upgrade_total_level_end | 32  | 64    | 17            | 0       | 38.5781    | 33.875  | 39      | 43.5     | 64                         |
| base-destroyed | general_alive_end       | 32  | 64    | 17            | 0       | 0.875      | 1       | 1       | 1        | 64                         |
| base-destroyed | general_hp_end          | 32  | 64    | 17            | 0       | 112.7656   | 73.75   | 111     | 153.375  | 64                         |

### 900 секунд

| group          | metric                  | n   | sides | ended earlier | missing | mean       | Q1       | median | Q3       | pooled n/d or observations |
| -------------- | ----------------------- | --- | ----- | ------------- | ------- | ---------- | -------- | ------ | -------- | -------------------------- |
| timeout        | base_hp_end             | 11  | 22    | 0             | 0       | 28268.1818 | 22986.5  | 28518  | 32542    | 22                         |
| timeout        | units_alive_end         | 11  | 22    | 0             | 0       | 4.9091     | 4.5      | 4.5    | 5.5      | 22                         |
| timeout        | towers_end              | 11  | 22    | 0             | 0       | 1.1364     | 0.75     | 1      | 1.25     | 22                         |
| timeout        | walls_end               | 11  | 22    | 0             | 0       | 19.0455    | 14       | 20     | 24.75    | 22                         |
| timeout        | energy_end              | 11  | 22    | 0             | 0       | 1250.9545  | 1113     | 1208   | 1426.25  | 22                         |
| timeout        | income_per_tick_end     | 11  | 22    | 0             | 0       | 16.8636    | 17       | 17     | 17       | 22                         |
| timeout        | queue_len_end           | 11  | 22    | 0             | 0       | 0          | 0        | 0      | 0        | 22                         |
| timeout        | upgrade_total_level_end | 11  | 22    | 0             | 0       | 46.2273    | 45.5     | 47     | 48.25    | 22                         |
| timeout        | general_alive_end       | 11  | 22    | 0             | 0       | 0.8182     | 0.5      | 1      | 1        | 22                         |
| timeout        | general_hp_end          | 11  | 22    | 0             | 0       | 84.6818    | 46.75    | 82     | 99       | 22                         |
| base-destroyed | base_hp_end             | 11  | 22    | 38            | 0       | 20742      | 18141.75 | 20140  | 20952.25 | 22                         |
| base-destroyed | units_alive_end         | 11  | 22    | 38            | 0       | 5.0909     | 4        | 5      | 5.25     | 22                         |
| base-destroyed | towers_end              | 11  | 22    | 38            | 0       | 1.0909     | 0.5      | 1      | 1.75     | 22                         |
| base-destroyed | walls_end               | 11  | 22    | 38            | 0       | 17.5455    | 14.75    | 17.5   | 21       | 22                         |
| base-destroyed | energy_end              | 11  | 22    | 38            | 0       | 1204       | 987.75   | 1079   | 1414.25  | 22                         |
| base-destroyed | income_per_tick_end     | 11  | 22    | 38            | 0       | 16.2727    | 15.75    | 17     | 17.5     | 22                         |
| base-destroyed | queue_len_end           | 11  | 22    | 38            | 0       | 0          | 0        | 0      | 0        | 22                         |
| base-destroyed | upgrade_total_level_end | 11  | 22    | 38            | 0       | 44.8636    | 42.25    | 45.5   | 49.75    | 22                         |
| base-destroyed | general_alive_end       | 11  | 22    | 38            | 0       | 0.9091     | 1        | 1      | 1        | 22                         |
| base-destroyed | general_hp_end          | 11  | 22    | 38            | 0       | 95.4545    | 67.5     | 81     | 120.25   | 22                         |

### 1200 секунд

| group          | metric                  | n   | sides | ended earlier | missing | mean       | Q1       | median  | Q3       | pooled n/d or observations |
| -------------- | ----------------------- | --- | ----- | ------------- | ------- | ---------- | -------- | ------- | -------- | -------------------------- |
| timeout        | base_hp_end             | 11  | 22    | 0             | 0       | 17362.1364 | 14039.75 | 19381.5 | 21369.25 | 22                         |
| timeout        | units_alive_end         | 11  | 22    | 0             | 0       | 4.8182     | 4        | 4       | 5.25     | 22                         |
| timeout        | towers_end              | 11  | 22    | 0             | 0       | 0.9545     | 0.5      | 1       | 1        | 22                         |
| timeout        | walls_end               | 11  | 22    | 0             | 0       | 18.2273    | 12.25    | 16.5    | 25.75    | 22                         |
| timeout        | energy_end              | 11  | 22    | 0             | 0       | 1473       | 1092.5   | 1407    | 1696.5   | 22                         |
| timeout        | income_per_tick_end     | 11  | 22    | 0             | 0       | 16.8636    | 17       | 17      | 17       | 22                         |
| timeout        | queue_len_end           | 11  | 22    | 0             | 0       | 0          | 0        | 0       | 0        | 22                         |
| timeout        | upgrade_total_level_end | 11  | 22    | 0             | 0       | 50.8636    | 49.75    | 51      | 52.5     | 22                         |
| timeout        | general_alive_end       | 11  | 22    | 0             | 0       | 0.7273     | 0.5      | 0.5     | 1        | 22                         |
| timeout        | general_hp_end          | 11  | 22    | 0             | 0       | 75.4091    | 18.25    | 51.5    | 102.25   | 22                         |
| base-destroyed | base_hp_end             | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | units_alive_end         | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | towers_end              | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | walls_end               | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | energy_end              | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | income_per_tick_end     | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | queue_len_end           | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | upgrade_total_level_end | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | general_alive_end       | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |
| base-destroyed | general_hp_end          | 0   | 0     | 49            | 0       | —          | —        | —       | —        | 0                          |

## Общие интервалы и вся наблюдённая жизнь

Интервальная ΔHP рассчитана внутри каждого матча. Например, mean HP завершённых на 300 и 600 с вычитать нельзя: n=44 и n=32. Вся жизнь показана отдельно и не устраняет различие длительностей.

### lifetime

| group          | metric                   | n   | sides | ended earlier | missing | mean        | Q1        | median   | Q3        | pooled n/d or observations |
| -------------- | ------------------------ | --- | ----- | ------------- | ------- | ----------- | --------- | -------- | --------- | -------------------------- |
| timeout        | base_hp_net              | 11  | 22    | 0             | 0       | -22637.8636 | -25960.25 | -20618.5 | -18630.75 | 44                         |
| timeout        | units_alive_net          | 11  | 22    | 0             | 0       | 2.8182      | 2         | 2        | 3.25      | 44                         |
| timeout        | towers_peak              | 11  | 22    | 0             | 0       | 5.1364      | 4         | 5.5      | 6         | 26400                      |
| timeout        | towers_below_peak        | 11  | 22    | 0             | 0       | 4.1818      | 3.5       | 4        | 4.75      | 26400                      |
| timeout        | structures_end           | 11  | 22    | 0             | 0       | 19.1818     | 13.5      | 17.5     | 26.5      | 22                         |
| timeout        | general_dead             | 11  | 22    | 0             | 0       | 0.1205      | 0.0917    | 0.1321   | 0.1431    | 3180/26400                 |
| timeout        | no_path                  | 11  | 22    | 0             | 0       | 0           | 0         | 0        | 0         | 0/26400                    |
| timeout        | far_unescorted           | 11  | 22    | 0             | 0       | 0.3109      | 0.2075    | 0.2847   | 0.4004    | 1513/5001                  |
| timeout        | far_unescorted_with_army | 11  | 22    | 0             | 0       | 0.3101      | 0.2075    | 0.2847   | 0.4004    | 1510/5001                  |
| timeout        | train_accepted           | 11  | 22    | 0             | 0       | 278.1364    | 254.75    | 286.5    | 296.75    | 34120                      |
| timeout        | bought_decisions         | 11  | 22    | 0             | 0       | 0.1827      | 0.1806    | 0.1831   | 0.1871    | 9644/52800                 |
| timeout        | saving_decisions         | 11  | 22    | 0             | 0       | 0.9271      | 0.9194    | 0.93     | 0.9341    | 48950/52800                |
| timeout        | impatient_decisions      | 11  | 22    | 0             | 0       | 0           | 0         | 0        | 0         | 0/52800                    |
| timeout        | hp_decrease_steps        | 11  | 22    | 0             | 0       | 218.7273    | 162.5     | 209      | 269.5     | 26378                      |
| base-destroyed | base_hp_net              | 49  | 98    | 0             | 0       | -23235.7653 | -24966.5  | -21560   | -20298    | 196                        |
| base-destroyed | units_alive_net          | 49  | 98    | 0             | 0       | 6.2959      | 3         | 5        | 8.5       | 196                        |
| base-destroyed | towers_peak              | 49  | 98    | 0             | 0       | 4.6429      | 3.5       | 4.5      | 5.5       | 65814                      |
| base-destroyed | towers_below_peak        | 49  | 98    | 0             | 0       | 3.8163      | 2.5       | 3.5      | 5         | 65814                      |
| base-destroyed | structures_end           | 49  | 98    | 0             | 0       | 12.4592     | 8.5       | 13       | 16.5      | 98                         |
| base-destroyed | general_dead             | 49  | 98    | 0             | 0       | 0.1485      | 0.1144    | 0.1464   | 0.1741    | 9242/65814                 |
| base-destroyed | no_path                  | 49  | 98    | 0             | 0       | 0           | 0         | 0        | 0         | 0/65814                    |
| base-destroyed | far_unescorted           | 40  | 89    | 0             | 9       | 0.3007      | 0.1677    | 0.2458   | 0.4315    | 6151/20678                 |
| base-destroyed | far_unescorted_with_army | 40  | 89    | 0             | 9       | 0.2942      | 0.1677    | 0.2435   | 0.421     | 6142/20678                 |
| base-destroyed | train_accepted           | 49  | 98    | 0             | 0       | 145.6224    | 88        | 141.5    | 198.5     | 84370                      |
| base-destroyed | bought_decisions         | 49  | 98    | 0             | 0       | 0.1821      | 0.1731    | 0.1833   | 0.1894    | 24075/131764               |
| base-destroyed | saving_decisions         | 49  | 98    | 0             | 0       | 0.9003      | 0.8898    | 0.902    | 0.9164    | 119369/131764              |
| base-destroyed | impatient_decisions      | 49  | 98    | 0             | 0       | 0           | 0         | 0        | 0         | 0/131764                   |
| base-destroyed | hp_decrease_steps        | 49  | 98    | 0             | 0       | 173.9184    | 135       | 170      | 215.5     | 65716                      |

### 0-300s

| group          | metric                   | n   | sides | ended earlier | missing | mean       | Q1        | median  | Q3        | pooled n/d or observations |
| -------------- | ------------------------ | --- | ----- | ------------- | ------- | ---------- | --------- | ------- | --------- | -------------------------- |
| timeout        | base_hp_net              | 11  | 22    | 0             | 0       | -2258.8636 | -3137.25  | -1712.5 | -1037.25  | 44                         |
| timeout        | units_alive_net          | 11  | 22    | 0             | 0       | 3.4545     | 2.25      | 3.5     | 4.25      | 44                         |
| timeout        | towers_peak              | 11  | 22    | 0             | 0       | 4.0909     | 3.5       | 4       | 4.25      | 6600                       |
| timeout        | towers_below_peak        | 11  | 22    | 0             | 0       | 2.7273     | 2         | 2.5     | 3.25      | 6600                       |
| timeout        | structures_end           | 11  | 22    | 0             | 0       | 8.8636     | 6.25      | 8.5     | 11.5      | 22                         |
| timeout        | general_dead             | 11  | 22    | 0             | 0       | 0.0547     | 0.0418    | 0.0669  | 0.0669    | 360/6578                   |
| timeout        | no_path                  | 11  | 22    | 0             | 0       | 0          | 0         | 0       | 0         | 0/6578                     |
| timeout        | far_unescorted           | 7   | 18    | 0             | 4       | 0.3047     | 0.1548    | 0.3393  | 0.4278    | 260/1082                   |
| timeout        | far_unescorted_with_army | 7   | 18    | 0             | 4       | 0.3047     | 0.1548    | 0.3393  | 0.4278    | 258/1082                   |
| timeout        | train_accepted           | 11  | 22    | 0             | 0       | 64.3182    | 54.25     | 66.5    | 71.5      | 9008                       |
| timeout        | bought_decisions         | 11  | 22    | 0             | 0       | 0.1833     | 0.1793    | 0.1823  | 0.1885    | 2411/13156                 |
| timeout        | saving_decisions         | 11  | 22    | 0             | 0       | 0.9176     | 0.9064    | 0.9239  | 0.9319    | 12072/13156                |
| timeout        | impatient_decisions      | 11  | 22    | 0             | 0       | 0          | 0         | 0       | 0         | 0/13156                    |
| timeout        | hp_decrease_steps        | 11  | 22    | 0             | 0       | 27.6364    | 15.25     | 25      | 34.5      | 6578                       |
| base-destroyed | base_hp_net              | 44  | 88    | 5             | 0       | -5908.3864 | -7536.125 | -4394   | -1828.375 | 176                        |
| base-destroyed | units_alive_net          | 44  | 88    | 5             | 0       | 4.8864     | 3.875     | 4.5     | 5.625     | 176                        |
| base-destroyed | towers_peak              | 44  | 88    | 5             | 0       | 3.875      | 3         | 4       | 4.5       | 26400                      |
| base-destroyed | towers_below_peak        | 44  | 88    | 5             | 0       | 2.6477     | 1.5       | 2.5     | 3.5       | 26400                      |
| base-destroyed | structures_end           | 44  | 88    | 5             | 0       | 7.8182     | 5.5       | 8.5     | 10        | 88                         |
| base-destroyed | general_dead             | 44  | 88    | 5             | 0       | 0.0961     | 0.0493    | 0.0836  | 0.1179    | 2529/26312                 |
| base-destroyed | no_path                  | 44  | 88    | 5             | 0       | 0          | 0         | 0       | 0         | 0/26312                    |
| base-destroyed | far_unescorted           | 31  | 74    | 5             | 13      | 0.2276     | 0.098     | 0.1742  | 0.2735    | 1971/8001                  |
| base-destroyed | far_unescorted_with_army | 31  | 74    | 5             | 13      | 0.2272     | 0.098     | 0.1742  | 0.2735    | 1965/8001                  |
| base-destroyed | train_accepted           | 44  | 88    | 5             | 0       | 67.9545    | 60        | 68      | 76        | 32649                      |
| base-destroyed | bought_decisions         | 44  | 88    | 5             | 0       | 0.1879     | 0.1779    | 0.1873  | 0.1957    | 9890/52624                 |
| base-destroyed | saving_decisions         | 44  | 88    | 5             | 0       | 0.9001     | 0.8832    | 0.8992  | 0.9185    | 47365/52624                |
| base-destroyed | impatient_decisions      | 44  | 88    | 5             | 0       | 0          | 0         | 0       | 0         | 0/52624                    |
| base-destroyed | hp_decrease_steps        | 44  | 88    | 5             | 0       | 57.2273    | 25.875    | 44.5    | 79.375    | 26312                      |

### 300-600s

| group          | metric                   | n   | sides | ended earlier | missing | mean       | Q1         | median   | Q3        | pooled n/d or observations |
| -------------- | ------------------------ | --- | ----- | ------------- | ------- | ---------- | ---------- | -------- | --------- | -------------------------- |
| timeout        | base_hp_net              | 11  | 22    | 0             | 0       | -2955      | -4945.25   | -1844    | -709.75   | 44                         |
| timeout        | units_alive_net          | 11  | 22    | 0             | 0       | -1.3636    | -2.75      | -1.5     | -0.25     | 44                         |
| timeout        | towers_peak              | 11  | 22    | 0             | 0       | 3.1818     | 2.75       | 3        | 3.75      | 6622                       |
| timeout        | towers_below_peak        | 11  | 22    | 0             | 0       | 1.7727     | 1.25       | 2        | 2.25      | 6622                       |
| timeout        | structures_end           | 11  | 22    | 0             | 0       | 16.8182    | 11.25      | 20       | 23        | 22                         |
| timeout        | general_dead             | 11  | 22    | 0             | 0       | 0.0932     | 0.05       | 0.11     | 0.1308    | 615/6600                   |
| timeout        | no_path                  | 11  | 22    | 0             | 0       | 0          | 0          | 0        | 0         | 0/6600                     |
| timeout        | far_unescorted           | 4   | 15    | 0             | 7       | 0.4132     | 0.2249     | 0.3977   | 0.586     | 267/1000                   |
| timeout        | far_unescorted_with_army | 4   | 15    | 0             | 7       | 0.4132     | 0.2249     | 0.3977   | 0.586     | 267/1000                   |
| timeout        | train_accepted           | 11  | 22    | 0             | 0       | 75.2727    | 63         | 77.5     | 82.5      | 7419                       |
| timeout        | bought_decisions         | 11  | 22    | 0             | 0       | 0.1923     | 0.1879     | 0.1958   | 0.1983    | 2539/13200                 |
| timeout        | saving_decisions         | 11  | 22    | 0             | 0       | 0.9408     | 0.9288     | 0.935    | 0.9575    | 12418/13200                |
| timeout        | impatient_decisions      | 11  | 22    | 0             | 0       | 0          | 0          | 0        | 0         | 0/13200                    |
| timeout        | hp_decrease_steps        | 11  | 22    | 0             | 0       | 37.9545    | 11.25      | 26       | 65        | 6600                       |
| base-destroyed | base_hp_net              | 32  | 64    | 17            | 0       | -8556.2656 | -10038.625 | -7359.75 | -5580.125 | 128                        |
| base-destroyed | units_alive_net          | 32  | 64    | 17            | 0       | -1.0156    | -2.5       | -1.5     | 0         | 128                        |
| base-destroyed | towers_peak              | 32  | 64    | 17            | 0       | 3.8594     | 3          | 3.75     | 4.625     | 19264                      |
| base-destroyed | towers_below_peak        | 32  | 64    | 17            | 0       | 2.5        | 1.5        | 2.5      | 3         | 19264                      |
| base-destroyed | structures_end           | 32  | 64    | 17            | 0       | 14.4219    | 10.375     | 14.75    | 17.625    | 64                         |
| base-destroyed | general_dead             | 32  | 64    | 17            | 0       | 0.1516     | 0.1358     | 0.15     | 0.1675    | 2911/19200                 |
| base-destroyed | no_path                  | 32  | 64    | 17            | 0       | 0          | 0          | 0        | 0         | 0/19200                    |
| base-destroyed | far_unescorted           | 14  | 46    | 17            | 18      | 0.3719     | 0.1653     | 0.3563   | 0.5448    | 1844/6074                  |
| base-destroyed | far_unescorted_with_army | 14  | 46    | 17            | 18      | 0.3716     | 0.1653     | 0.3563   | 0.5448    | 1842/6074                  |
| base-destroyed | train_accepted           | 32  | 64    | 17            | 0       | 62.8594    | 54.5       | 62.5     | 70.5      | 24918                      |
| base-destroyed | bought_decisions         | 32  | 64    | 17            | 0       | 0.1816     | 0.171      | 0.1817   | 0.1942    | 6974/38400                 |
| base-destroyed | saving_decisions         | 32  | 64    | 17            | 0       | 0.9176     | 0.9015     | 0.9175   | 0.9304    | 35235/38400                |
| base-destroyed | impatient_decisions      | 32  | 64    | 17            | 0       | 0          | 0          | 0        | 0         | 0/38400                    |
| base-destroyed | hp_decrease_steps        | 32  | 64    | 17            | 0       | 74.5625    | 61.25      | 75.5     | 94.25     | 19200                      |

### 600-900s

| group          | metric                   | n   | sides | ended earlier | missing | mean        | Q1       | median | Q3       | pooled n/d or observations |
| -------------- | ------------------------ | --- | ----- | ------------- | ------- | ----------- | -------- | ------ | -------- | -------------------------- |
| timeout        | base_hp_net              | 11  | 22    | 0             | 0       | -6517.9545  | -8874.25 | -6519  | -5705.5  | 44                         |
| timeout        | units_alive_net          | 11  | 22    | 0             | 0       | 0.8182      | -0.25    | 0.5    | 2.5      | 44                         |
| timeout        | towers_peak              | 11  | 22    | 0             | 0       | 3.7727      | 3        | 3.5    | 4.25     | 6622                       |
| timeout        | towers_below_peak        | 11  | 22    | 0             | 0       | 2.6364      | 1.75     | 2.5    | 3.25     | 6622                       |
| timeout        | structures_end           | 11  | 22    | 0             | 0       | 20.1818     | 14.75    | 20.5   | 26.25    | 22                         |
| timeout        | general_dead             | 11  | 22    | 0             | 0       | 0.1503      | 0.115    | 0.1533 | 0.1833   | 992/6600                   |
| timeout        | no_path                  | 11  | 22    | 0             | 0       | 0           | 0        | 0      | 0        | 0/6600                     |
| timeout        | far_unescorted           | 9   | 20    | 0             | 2       | 0.4047      | 0.2508   | 0.3842 | 0.456    | 510/1474                   |
| timeout        | far_unescorted_with_army | 9   | 20    | 0             | 2       | 0.4033      | 0.2508   | 0.3842 | 0.456    | 509/1474                   |
| timeout        | train_accepted           | 11  | 22    | 0             | 0       | 71.4091     | 65       | 68.5   | 78.75    | 8598                       |
| timeout        | bought_decisions         | 11  | 22    | 0             | 0       | 0.1799      | 0.1733   | 0.1817 | 0.1854   | 2375/13200                 |
| timeout        | saving_decisions         | 11  | 22    | 0             | 0       | 0.9317      | 0.9217   | 0.93   | 0.9367   | 12299/13200                |
| timeout        | impatient_decisions      | 11  | 22    | 0             | 0       | 0           | 0        | 0      | 0        | 0/13200                    |
| timeout        | hp_decrease_steps        | 11  | 22    | 0             | 0       | 67.5909     | 57.5     | 61     | 90       | 6600                       |
| base-destroyed | base_hp_net              | 11  | 22    | 38            | 0       | -10215.8636 | -12739.5 | -10226 | -8174.75 | 44                         |
| base-destroyed | units_alive_net          | 11  | 22    | 38            | 0       | 0.2727      | -0.5     | -0.5   | 1.25     | 44                         |
| base-destroyed | towers_peak              | 11  | 22    | 38            | 0       | 3.2727      | 3        | 3      | 3.25     | 6622                       |
| base-destroyed | towers_below_peak        | 11  | 22    | 38            | 0       | 2.1818      | 1        | 2.5    | 3        | 6622                       |
| base-destroyed | structures_end           | 11  | 22    | 38            | 0       | 18.6364     | 16.25    | 18     | 22.25    | 22                         |
| base-destroyed | general_dead             | 11  | 22    | 38            | 0       | 0.1671      | 0.1      | 0.1667 | 0.2083   | 1103/6600                  |
| base-destroyed | no_path                  | 11  | 22    | 38            | 0       | 0           | 0        | 0      | 0        | 0/6600                     |
| base-destroyed | far_unescorted           | 4   | 15    | 38            | 7       | 0.322       | 0.245    | 0.3721 | 0.449    | 726/2034                   |
| base-destroyed | far_unescorted_with_army | 4   | 15    | 38            | 7       | 0.322       | 0.245    | 0.3721 | 0.449    | 726/2034                   |
| base-destroyed | train_accepted           | 11  | 22    | 38            | 0       | 63.2273     | 56.75    | 62.5   | 65.5     | 9214                       |
| base-destroyed | bought_decisions         | 11  | 22    | 38            | 0       | 0.1758      | 0.1704   | 0.1775 | 0.1862   | 2321/13200                 |
| base-destroyed | saving_decisions         | 11  | 22    | 38            | 0       | 0.9211      | 0.9067   | 0.9233 | 0.9283   | 12159/13200                |
| base-destroyed | impatient_decisions      | 11  | 22    | 38            | 0       | 0           | 0        | 0      | 0        | 0/13200                    |
| base-destroyed | hp_decrease_steps        | 11  | 22    | 38            | 0       | 88          | 76.75    | 94     | 102.25   | 6600                       |

### 900-1200s

| group          | metric                   | n   | sides | ended earlier | missing | mean        | Q1        | median | Q3       | pooled n/d or observations |
| -------------- | ------------------------ | --- | ----- | ------------- | ------- | ----------- | --------- | ------ | -------- | -------------------------- |
| timeout        | base_hp_net              | 11  | 22    | 0             | 0       | -10906.0455 | -13602.75 | -12367 | -8809.25 | 44                         |
| timeout        | units_alive_net          | 11  | 22    | 0             | 0       | -0.0909     | -2        | -0.5   | 1        | 44                         |
| timeout        | towers_peak              | 11  | 22    | 0             | 0       | 3.2727      | 2.25      | 3      | 4        | 6622                       |
| timeout        | towers_below_peak        | 11  | 22    | 0             | 0       | 2.3182      | 1.5       | 2      | 3        | 6622                       |
| timeout        | structures_end           | 11  | 22    | 0             | 0       | 19.1818     | 13.5      | 17.5   | 26.5     | 22                         |
| timeout        | general_dead             | 11  | 22    | 0             | 0       | 0.1838      | 0.16      | 0.195  | 0.2      | 1213/6600                  |
| timeout        | no_path                  | 11  | 22    | 0             | 0       | 0           | 0         | 0      | 0        | 0/6600                     |
| timeout        | far_unescorted           | 7   | 18    | 0             | 4       | 0.4113      | 0.1644    | 0.4608 | 0.5545   | 476/1445                   |
| timeout        | far_unescorted_with_army | 7   | 18    | 0             | 4       | 0.4113      | 0.1644    | 0.4608 | 0.5545   | 476/1445                   |
| timeout        | train_accepted           | 11  | 22    | 0             | 0       | 65.1364     | 61        | 64     | 68       | 9028                       |
| timeout        | bought_decisions         | 11  | 22    | 0             | 0       | 0.171       | 0.169     | 0.1736 | 0.177    | 2253/13178                 |
| timeout        | saving_decisions         | 11  | 22    | 0             | 0       | 0.9228      | 0.9157    | 0.9232 | 0.929    | 12161/13178                |
| timeout        | impatient_decisions      | 11  | 22    | 0             | 0       | 0           | 0         | 0      | 0        | 0/13178                    |
| timeout        | hp_decrease_steps        | 11  | 22    | 0             | 0       | 85.5455     | 82.75     | 88     | 96.75    | 6600                       |
| base-destroyed | base_hp_net              | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | units_alive_net          | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | towers_peak              | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | towers_below_peak        | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | structures_end           | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | general_dead             | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | no_path                  | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | far_unescorted           | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | far_unescorted_with_army | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | train_accepted           | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | bought_decisions         | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | saving_decisions         | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | impatient_decisions      | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |
| base-destroyed | hp_decrease_steps        | 0   | 0     | 49            | 0       | —           | —         | —      | —        | 0                          |

## Индивидуальный разбор всех тайм-аутов и контроля

В каждой паре чисел порядок player 0 / player 1; HP относится к собственной
базе, заказы и войска — к её стороне. Снижение HP стороны 0 обычно означает
давление противника, а не успех её армии. Начало всех первых окон — тик 30.
Первый HP=40000/40000; стартовые войска=2/2, башни=0/0 у всех перечисленных.
Таблицы включают обе стороны даже при одностороннем отсутствии дальних решений.

Минутные подокна 900–960, 960–1020, 1020–1080, 1080–1140, 1140–1200 с выбраны
для всех 11 timeout одинаково: это последние пять минут до цензурирования,
где можно проверить прекращение давления. Контроль — самый длинный base-destroyed,
при равенстве минимальный seed: seed 15, 34288 тиков = 1142.9333 с, winner=0.
Его полное окно 1140–1200 с исключено; последние 2.9333 с описаны footer и
последним sample отдельно. Общие таблицы используют все 49 завершённых матчей.

Минутные окна рассчитываются экспортированной analyzeDatabase тем же способом:

```js
const windows = Array.from({ length: 20 }, (_, i) => ({
  name: 'minute-' + (i + 1),
  kind: 'interval',
  start: i === 0 ? null : i * 1800,
  end: (i + 1) * 1800,
}));
const result = analyzeDatabase(db, options, windows);
```

db открывается через new DatabaseSync(path, {readOnly:true}); options — паспорт
команды выше. Это чтение той же SQLite, не продолжение матчей.

### Seed 2

После почти неизменной базы 1 на 300–900 с (ΔHP=0 в обоих окнах) давление становится односторонним: в 900–1200 с база 0 теряет 22435 HP, база 1 — 3553. На минуте 18 у стороны 1 уже 15 войск и 7 башен, 15 заказов против 4 у стороны 0; база 0 теряет 13683 HP. Поздняя потеря войск у стороны 1 до двух к концу не доказывает взаимное прекращение боя: база 0 снижается до тика 35370. Хвост базы 1 225 с — асимметрия, не общий застой.

Итог: HP 11082 / 35409; войска 3 / 2; башни пик 3 / 10 → конец 1 / 4. Последние снижения HP: 35370 / 29250 тиков; хвосты: 21 / 225 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 273      | 318      |
| pass: saving-for-better | 879      | 765      |
| wait: unit-unaffordable | 1139     | 1252     |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 35529 / 38962 | -4471 / -1038  | 2→7; 2→4            | 0→1; 0→1             | 4 / 3     | 0.1003 [30/299] / 0.0334 [10/299] | 54 / 18           |
| 300-600s  | 34321 / 38962 | -1208 / 0      | 7→1; 4→3            | 1→1; 1→3             | 8 / 6     | 0.0667 [20/300] / 0.0333 [10/300] | 20 / 0            |
| 600-900s  | 33517 / 38962 | -804 / 0       | 1→1; 3→8            | 1→0; 3→2             | 9 / 8     | 0.1 [30/300] / 0 [0/300]          | 11 / 0            |
| 900-1200s | 11082 / 35409 | -22435 / -3553 | 1→3; 8→2            | 0→1; 2→4             | 5 / 14    | 0.3 [90/300] / 0.1 [30/300]       | 135 / 38          |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                   | far alone with army n/d         |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ------------------------------- | ------------------------------- |
| 0-300s    | 1072 / 1255 | 14 / 14         | 0 / 0     | 19 / 22      | 72 / 81        | 0.1856 [111/598] / 0.194 [116/598]  | 0.9097 [544/598] / 0.9197 [550/598] | 0.2099 [17/81] / 0.1385 [9/65]  | 0.2099 [17/81] / 0.1385 [9/65]  |
| 300-600s  | 911 / 1277  | 14 / 14         | 0 / 0     | 29 / 37      | 71 / 78        | 0.1667 [100/600] / 0.1667 [100/600] | 0.9583 [575/600] / 0.9567 [574/600] | — [0/0] / 0.3803 [27/71]        | — [0/0] / 0.3803 [27/71]        |
| 600-900s  | 1064 / 387  | 14 / 14         | 0 / 0     | 33 / 38      | 82 / 93        | 0.1683 [101/600] / 0.1617 [97/600]  | 0.98 [588/600] / 0.9867 [592/600]   | — [0/0] / 0 [0/10]              | — [0/0] / 0 [0/10]              |
| 900-1200s | 1307 / 1302 | 14 / 14         | 0 / 0     | 39 / 44      | 46 / 64        | 0.1452 [87/599] / 0.1519 [91/599]   | 0.9199 [551/599] / 0.9316 [558/599] | 0.0541 [4/74] / 0.1589 [34/214] | 0.0541 [4/74] / 0.1589 [34/214] |

| minute    | ΔHP           | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d                | HP decrease steps |
| --------- | ------------- | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ---------------------------- | ----------------- |
| minute-16 | -1212 / -1588 | 6 / 0     | 2 / 0      | 1 / 1             | 220 / 3        | 780 / 1132       | 0.1667 [10/60] / 0 [0/60]       | 12 / 7         | 0.0638 [3/47] / 0.4444 [4/9] | 13 / 24           |
| minute-17 | -1375 / -1965 | 3 / 4     | 0 / 8      | 1 / 1             | 220 / 111      | 358 / 1273       | 0.3333 [20/60] / 0.1667 [10/60] | 12 / 7         | 0.037 [1/27] / 0.75 [6/8]    | 17 / 14           |
| minute-18 | -13683 / 0    | 3 / 15    | 0 / 7      | 1 / 1             | 220 / 56       | 390 / 627        | 0.1667 [10/60] / 0 [0/60]       | 4 / 15         | — [0/0] / 0.2556 [23/90]     | 50 / 0            |
| minute-19 | -5399 / 0     | 5 / 5     | 0 / 5      | 1 / 1             | 151 / 198      | 312 / 546        | 0.5 [30/60] / 0.1667 [10/60]    | 8 / 18         | — [0/0] / 0 [0/90]           | 41 / 0            |
| minute-20 | -766 / 0      | 3 / 2     | 1 / 4      | 1 / 1             | 220 / 154      | 312 / 663        | 0.3333 [20/60] / 0.1667 [10/60] | 10 / 17        | — [0/0] / 0.0588 [1/17]      | 14 / 0            |

### Seed 3

На 600 с войска 1/8, на 900 с 5/4, на 1200 с 3/19. За последнюю минуту база 0 теряет 8234 HP при 43 снижениях, последнее прямо на тике 36000. Сторона 1 заказывает 17 юнитов и не имеет мёртвого генерала в этой минуте. Это явный контрпример двустороннему истощению; отсутствие дальних решений у стороны 0 в последнем пятиминутном окне — не отсутствие генерала вообще.

Итог: HP 9681 / 35557; войска 3 / 19; башни пик 8 / 4 → конец 1 / 1. Последние снижения HP: 36000 / 33660 тиков; хвосты: 0 / 78 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 280      | 305      |
| pass: saving-for-better | 832      | 820      |
| wait: unit-unaffordable | 1147     | 1167     |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 39815 / 39749 | -185 / -251    | 2→8; 2→8            | 0→2; 0→1             | 7 / 13    | 0 [0/299] / 0 [0/299]             | 5 / 7             |
| 300-600s  | 37879 / 37997 | -1936 / -1752  | 8→1; 8→8            | 2→0; 1→2             | 16 / 22   | 0.0667 [20/300] / 0.0333 [10/300] | 23 / 18           |
| 600-900s  | 27284 / 36862 | -10595 / -1135 | 1→5; 8→4            | 0→1; 2→1             | 17 / 24   | 0.24 [72/300] / 0.0667 [20/300]   | 96 / 26           |
| 900-1200s | 9681 / 35557  | -17603 / -1305 | 5→3; 4→19           | 1→1; 1→1             | 7 / 26    | 0.2267 [68/300] / 0.1 [30/300]    | 114 / 25          |

| seconds   | energy end | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                    | far alone with army n/d          |
| --------- | ---------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | -------------------------------- | -------------------------------- |
| 0-300s    | 411 / 996  | 17 / 17         | 0 / 0     | 24 / 27      | 80 / 62        | 0.1973 [118/598] / 0.1856 [111/598] | 0.9415 [563/598] / 0.9264 [554/598] | 0 [0/5] / 0.12 [6/50]            | 0 [0/5] / 0.12 [6/50]            |
| 300-600s  | 1963 / 490 | 17 / 17         | 0 / 0     | 37 / 43      | 77 / 78        | 0.2117 [127/600] / 0.1867 [112/600] | 0.9333 [560/600] / 0.9667 [580/600] | 0.2759 [16/58] / — [0/0]         | 0.2759 [16/58] / — [0/0]         |
| 600-900s  | 1316 / 939 | 17 / 19         | 0 / 0     | 42 / 52      | 62 / 85        | 0.18 [108/600] / 0.1833 [110/600]   | 0.9083 [545/600] / 0.935 [561/600]  | 0.6538 [34/52] / 0.1635 [17/104] | 0.6538 [34/52] / 0.1635 [17/104] |
| 900-1200s | 530 / 2284 | 17 / 19         | 0 / 0     | 47 / 59      | 59 / 78        | 0.1669 [100/599] / 0.1753 [105/599] | 0.9232 [553/599] / 0.9399 [563/599] | — [0/0] / 0 [0/72]               | — [0/0] / 0 [0/72]               |

| minute    | ΔHP           | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d      | HP decrease steps |
| --------- | ------------- | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ------------------ | ----------------- |
| minute-16 | -3251 / -1283 | 3 / 2     | 1 / 1      | 1 / 1             | 242 / 197      | 238 / 901        | 0.3 [18/60] / 0.1667 [10/60]    | 10 / 8         | — [0/0] / — [0/0]  | 27 / 24           |
| minute-17 | -514 / 0      | 4 / 5     | 1 / 1      | 1 / 1             | 242 / 189      | 311 / 658        | 0.1667 [10/60] / 0.1667 [10/60] | 10 / 19        | — [0/0] / 0 [0/38] | 9 / 0             |
| minute-18 | -807 / 0      | 3 / 7     | 0 / 1      | 0 / 1             | 0 / 159        | -1 / 1280        | 0.15 [9/60] / 0 [0/60]          | 18 / 17        | — [0/0] / 0 [0/7]  | 6 / 0             |
| minute-19 | -4797 / -22   | 5 / 6     | 1 / 1      | 1 / 1             | 242 / 176      | 238 / 1279       | 0.35 [21/60] / 0.1667 [10/60]   | 15 / 17        | — [0/0] / 0 [0/27] | 29 / 1            |
| minute-20 | -8234 / 0     | 3 / 19    | 1 / 1      | 1 / 1             | 64 / 198       | 313 / 941        | 0.1667 [10/60] / 0 [0/60]       | 6 / 17         | — [0/0] / — [0/0]  | 43 / 0            |

### Seed 5

В 300–600 с давление слабое (−670/−23 HP), затем растёт. На минуте 18 база 0 теряет 9882 HP, у противника 20 войск; на минуте 20 направление меняется: база 0 не снижается, база 1 теряет 5449 HP, войска 7/1. Башни в конце 3/1, заказы последней минуты 13/9. Это смена преимущества и задержка добивания, а не установленный симметричный застой.

Итог: HP 19408 / 23054; войска 7 / 1; башни пик 4 / 8 → конец 3 / 1. Последние снижения HP: 32970 / 35580 тиков; хвосты: 101 / 14 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 312      | 338      |
| pass: saving-for-better | 776      | 649      |
| wait: unit-unaffordable | 1203     | 1313     |

| seconds   | HP end        | ΔHP             | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | --------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 38759 / 39604 | -1241 / -396    | 2→4; 2→8            | 0→1; 0→3             | 3 / 6     | 0.1003 [30/299] / 0.0334 [10/299] | 18 / 8            |
| 300-600s  | 38089 / 39581 | -670 / -23      | 4→3; 8→5            | 1→1; 3→1             | 4 / 11    | 0.0333 [10/300] / 0.0333 [10/300] | 10 / 1            |
| 600-900s  | 35442 / 36691 | -2647 / -2890   | 3→7; 5→2            | 1→1; 1→0             | 13 / 12   | 0.0667 [20/300] / 0.1 [30/300]    | 37 / 42           |
| 900-1200s | 19408 / 23054 | -16034 / -13637 | 7→7; 2→1            | 1→3; 0→1             | 11 / 9    | 0.1 [30/300] / 0.1433 [43/300]    | 77 / 97           |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                   | far alone with army n/d         |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ------------------------------- | ------------------------------- |
| 0-300s    | 1075 / 1577 | 17 / 17         | 0 / 0     | 26 / 25      | 77 / 85        | 0.1839 [110/598] / 0.1923 [115/598] | 0.9264 [554/598] / 0.9515 [569/598] | 0.0909 [3/33] / — [0/0]         | 0.0909 [3/33] / — [0/0]         |
| 300-600s  | 1289 / 1558 | 17 / 17         | 0 / 0     | 42 / 37      | 83 / 94        | 0.1833 [110/600] / 0.1967 [118/600] | 0.95 [570/600] / 0.97 [582/600]     | — [0/0] / 0.0909 [2/22]         | — [0/0] / 0.0909 [2/22]         |
| 600-900s  | 1264 / 1612 | 17 / 17         | 0 / 0     | 49 / 42      | 84 / 84        | 0.2017 [121/600] / 0.1867 [112/600] | 0.925 [555/600] / 0.925 [555/600]   | 0.2778 [15/54] / 0.125 [11/88]  | 0.2778 [15/54] / 0.125 [11/88]  |
| 900-1200s | 588 / 1581  | 17 / 17         | 0 / 0     | 55 / 43      | 66 / 73        | 0.1686 [101/599] / 0.1903 [114/599] | 0.9098 [545/599] / 0.8831 [529/599] | 0.2393 [39/163] / 0.0588 [1/17] | 0.2393 [39/163] / 0.0588 [1/17] |

| minute    | ΔHP           | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d            | HP decrease steps |
| --------- | ------------- | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ------------------------ | ----------------- |
| minute-16 | -1058 / -876  | 8 / 2     | 1 / 1      | 1 / 1             | 220 / 113      | 312 / 1133       | 0.1667 [10/60] / 0.1667 [10/60] | 17 / 18        | 0 [0/1] / 0.0833 [1/12]  | 14 / 8            |
| minute-17 | 0 / -3950     | 2 / 6     | 0 / 1      | 0 / 1             | 0 / 197        | -1 / 1091        | 0.15 [9/60] / 0.1667 [10/60]    | 19 / 9         | 0.2796 [26/93] / — [0/0] | 0 / 35            |
| minute-18 | -9882 / 0     | 3 / 20    | 0 / 1      | 0 / 1             | 0 / 197        | -1 / 779         | 0.1833 [11/60] / 0 [0/60]       | 5 / 22         | — [0/0] / 0 [0/2]        | 44 / 0            |
| minute-19 | -5094 / -3362 | 10 / 1    | 3 / 0      | 1 / 1             | 5 / 220        | 895 / 1168       | 0 [0/60] / 0.1667 [10/60]       | 12 / 15        | 0.25 [7/28] / 0 [0/3]    | 19 / 27           |
| minute-20 | 0 / -5449     | 7 / 1     | 3 / 1      | 1 / 0             | 5 / 0          | 438 / -1         | 0 [0/60] / 0.2167 [13/60]       | 13 / 9         | 0.1463 [6/41] / — [0/0]  | 0 / 27            |

### Seed 11

На 900 с базы почти равны (26880/26590 HP), башни 0/3. К концу башен нет с обеих сторон, однако HP обеих баз снижается на тике 36000. В последнюю минуту заказы 12/15, войска 5/3, 29/5 секундных снижений. В окне 900–1200 с одиночество на дальнем рубеже велико у обеих сторон (0.88 и 0.8679), но это не прекращает давление. Потеря башен совместна, остановка атаки не наблюдается.

Итог: HP 16571 / 22192; войска 5 / 3; башни пик 5 / 6 → конец 0 / 0. Последние снижения HP: 36000 / 36000 тиков; хвосты: 0 / 0 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 273      | 255      |
| pass: saving-for-better | 869      | 949      |
| wait: unit-unaffordable | 1135     | 1055     |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 38193 / 37904 | -1807 / -2096  | 2→0; 2→6            | 0→1; 0→1             | 4 / 17    | 0.0334 [10/299] / 0.0669 [20/299] | 22 / 28           |
| 300-600s  | 29674 / 37904 | -8519 / 0      | 0→5; 6→4            | 1→2; 1→3             | 9 / 30    | 0.1667 [50/300] / 0.0533 [16/300] | 107 / 0           |
| 600-900s  | 26880 / 26590 | -2794 / -11314 | 5→3; 4→4            | 2→0; 3→3             | 18 / 39   | 0.1567 [47/300] / 0.3133 [94/300] | 44 / 123          |
| 900-1200s | 16571 / 22192 | -10309 / -4398 | 3→5; 4→3            | 0→0; 3→0             | 21 / 40   | 0.1767 [53/300] / 0.2133 [64/300] | 107 / 51          |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                   | far alone with army n/d         |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ------------------------------- | ------------------------------- |
| 0-300s    | 1430 / 1848 | 16 / 17         | 0 / 0     | 28 / 27      | 62 / 41        | 0.1722 [103/598] / 0.1773 [106/598] | 0.8796 [526/598] / 0.9181 [549/598] | 0.1366 [25/183] / 1 [1/1]       | 0.1366 [25/183] / 1 [1/1]       |
| 300-600s  | 602 / 1534  | 16 / 17         | 0 / 0     | 45 / 44      | 71 / 85        | 0.2033 [122/600] / 0.2167 [130/600] | 0.9267 [556/600] / 0.9133 [548/600] | — [0/0] / 0.23 [46/200]         | — [0/0] / 0.23 [46/200]         |
| 600-900s  | 843 / 1573  | 16 / 17         | 0 / 0     | 48 / 53      | 69 / 61        | 0.185 [111/600] / 0.1917 [115/600]  | 0.915 [549/600] / 0.9283 [557/600]  | 0.3684 [63/171] / 0.4 [12/30]   | 0.3684 [63/171] / 0.4 [12/30]   |
| 900-1200s | 2902 / 966  | 16 / 17         | 0 / 0     | 48 / 60      | 69 / 66        | 0.1786 [107/599] / 0.1753 [105/599] | 0.9182 [550/599] / 0.9282 [556/599] | 0.88 [110/125] / 0.8679 [46/53] | 0.88 [110/125] / 0.8679 [46/53] |

| minute    | ΔHP          | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d                 | HP decrease steps |
| --------- | ------------ | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ----------------------------- | ----------------- |
| minute-16 | -2444 / -24  | 4 / 8     | 1 / 0      | 1 / 1             | 20 / 20        | 311 / 1022       | 0.2167 [13/60] / 0 [0/60]       | 10 / 18        | — [0/0] / 0.9783 [45/46]      | 32 / 1            |
| minute-17 | -423 / -2565 | 3 / 6     | 2 / 1      | 1 / 1             | 159 / 80       | 907 / 1203       | 0.1667 [10/60] / 0.3333 [20/60] | 18 / 13        | 1 [53/53] / — [0/0]           | 14 / 19           |
| minute-18 | -5039 / -653 | 7 / 3     | 1 / 0      | 1 / 0             | 220 / 0        | 741 / -1         | 0.3333 [20/60] / 0.2667 [16/60] | 14 / 7         | 0.9434 [50/53] / 0.1429 [1/7] | 23 / 11           |
| minute-19 | -545 / -743  | 3 / 6     | 1 / 1      | 1 / 1             | 220 / 74       | 276 / 941        | 0 [0/60] / 0.2333 [14/60]       | 15 / 13        | 0.3684 [7/19] / — [0/0]       | 9 / 15            |
| minute-20 | -1858 / -413 | 5 / 3     | 0 / 0      | 1 / 0             | 57 / 0         | 352 / -1         | 0.1667 [10/60] / 0.2333 [14/60] | 12 / 15        | — [0/0] / — [0/0]             | 29 / 5            |

### Seed 15 — завершённый контроль

Контроль разрушает простое объяснение «генерал мёртв — добить нельзя». На 900 с HP 39978/33629, войска 3/4. На 1080 с у проигравшего нет войск и башен; в 1080–1140 с обе стороны имеют живого генерала во всех 60 sample, но заказы 20/0, войска к концу 22/0. База 1 теряет 22025 HP, снижаясь каждую секунду. Последний sample на 34260 показывает 375 HP, footer на 34288 фиксирует снос и победителя 0. До 300 с вообще не было снижения обеих баз: ранняя пауза совместима с поздним решительным исходом.

Итог: HP 39734 / 375; войска 22 / 0; башни пик 4 / 4 → конец 2 / 1. Последние снижения HP: 31320 / 34260 тиков; хвосты: 98 / 0 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 319      | 288      |
| pass: saving-for-better | 682      | 957      |
| wait: unit-unaffordable | 1220     | 910      |

| seconds   | HP end        | ΔHP         | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | ----------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 40000 / 40000 | 0 / 0       | 2→10; 2→4           | 0→2; 0→2             | 6 / 7     | 0 [0/299] / 0 [0/299]             | 0 / 0             |
| 300-600s  | 39978 / 37046 | -22 / -2954 | 10→3; 4→5           | 2→1; 2→0             | 13 / 18   | 0.0333 [10/300] / 0.1 [30/300]    | 2 / 39            |
| 600-900s  | 39978 / 33629 | 0 / -3417   | 3→3; 5→4            | 1→3; 0→1             | 15 / 17   | 0.0333 [10/300] / 0.1667 [50/300] | 0 / 45            |
| 900-1200s | — / —         | — / —       | —→—; —→—            | —→—; —→—             | — / —     | — [10/242] / — [50/242]           | — / —             |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d            | far alone with army n/d  |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ------------------------ | ------------------------ |
| 0-300s    | 1759 / 1218 | 17 / 17         | 0 / 0     | 25 / 23      | 76 / 87        | 0.1839 [110/598] / 0.1957 [117/598] | 0.9582 [573/598] / 0.9599 [574/598] | — [0/0] / 0 [0/1]        | — [0/0] / 0 [0/1]        |
| 300-600s  | 970 / 1204  | 17 / 17         | 0 / 0     | 45 / 31      | 73 / 89        | 0.1867 [112/600] / 0.21 [126/600]   | 0.9433 [566/600] / 0.9633 [578/600] | 0.5217 [12/23] / — [0/0] | 0.5217 [12/23] / — [0/0] |
| 600-900s  | 1472 / 1410 | 17 / 17         | 0 / 0     | 51 / 37      | 91 / 81        | 0.175 [105/600] / 0.2033 [122/600]  | 0.9617 [577/600] / 0.9433 [566/600] | 0.1404 [8/57] / 0 [0/12] | 0.1404 [8/57] / 0 [0/12] |
| 900-1200s | — / —       | — / —           | — / —     | — / —        | — / —          | — [85/485] / — [81/485]             | — [436/485] / — [428/485]           | — [21/129] / — [0/0]     | — [21/129] / — [0/0]     |

| minute    | ΔHP          | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d           | HP decrease steps |
| --------- | ------------ | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ----------------------- | ----------------- |
| minute-16 | 0 / -3215    | 11 / 4    | 2 / 0      | 1 / 0             | 182 / 0        | 702 / -1         | 0 [0/60] / 0.1667 [10/60]       | 21 / 10        | 0.1311 [8/61] / — [0/0] | 0 / 32            |
| minute-17 | 0 / -3496    | 9 / 4     | 4 / 0      | 1 / 0             | 242 / 0        | 814 / -1         | 0.1667 [10/60] / 0.4833 [29/60] | 18 / 12        | 0.225 [9/40] / — [0/0]  | 0 / 36            |
| minute-18 | -244 / -3439 | 10 / 0    | 2 / 0      | 1 / 1             | 200 / 99       | 664 / 1095       | 0 [0/60] / 0.1833 [11/60]       | 18 / 7         | 0.1429 [4/28] / — [0/0] | 3 / 32            |
| minute-19 | 0 / -22025   | 22 / 0    | 2 / 0      | 1 / 1             | 200 / 99       | 664 / 1095       | 0 [0/60] / 0 [0/60]             | 20 / 0         | — [0/0] / — [0/0]       | 0 / 60            |
| minute-20 | — / —        | — / —     | — / —      | — / —             | — / —          | — / —            | — [0/2] / — [0/2]               | — / —          | — [0/0] / — [0/0]       | — / —             |

### Seed 17

У стороны 0 на 600 с войск нет, но на 900 с их 2, на 1200 с 3: ноль на отсечке не постоянное отсутствие армии. За 900–1200 с база 0 теряет 15260 HP, база 1 — 5365. Заказы 44/84, в последнюю минуту 14/18; снижения продолжаются до 35550/34260 тиков. Это устойчивое преимущество стороны 1 при отдельных паузах, а не свидетельство отсутствия производства у обеих.

Итог: HP 9175 / 32684; войска 3 / 5; башни пик 4 / 4 → конец 0 / 2. Последние снижения HP: 35550 / 34260 тиков; хвосты: 15 / 58 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 278      | 335      |
| pass: saving-for-better | 1021     | 651      |
| wait: unit-unaffordable | 957      | 1340     |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 38592 / 38561 | -1408 / -1439  | 2→3; 2→5            | 0→2; 0→1             | 4 / 1     | 0.0334 [10/299] / 0.0334 [10/299] | 12 / 23           |
| 300-600s  | 36961 / 38561 | -1631 / 0      | 3→0; 5→5            | 2→1; 1→1             | 2 / 3     | 0 [0/300] / 0 [0/300]             | 25 / 0            |
| 600-900s  | 24435 / 38049 | -12526 / -512  | 0→2; 5→8            | 1→2; 1→2             | 5 / 5     | 0.1 [30/300] / 0.0667 [20/300]    | 116 / 6           |
| 900-1200s | 9175 / 32684  | -15260 / -5365 | 2→3; 8→5            | 2→0; 2→2             | 8 / 7     | 0.2 [60/300] / 0.1 [30/300]       | 146 / 50          |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                | far alone with army n/d      |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ---------------------------- | ---------------------------- |
| 0-300s    | 878 / 1670  | 17 / 17         | 0 / 0     | 32 / 25      | 64 / 80        | 0.1722 [103/598] / 0.189 [113/598]  | 0.9298 [556/598] / 0.9181 [549/598] | 0.4286 [9/21] / 0.25 [14/56] | 0.4286 [9/21] / 0.25 [14/56] |
| 300-600s  | 1271 / 850  | 17 / 17         | 0 / 0     | 39 / 43      | 92 / 82        | 0.1917 [115/600] / 0.1733 [104/600] | 0.9483 [569/600] / 0.9667 [580/600] | 0 [0/5] / — [0/0]            | 0 [0/5] / — [0/0]            |
| 600-900s  | 1541 / 1038 | 17 / 17         | 0 / 0     | 43 / 48      | 76 / 87        | 0.1867 [112/600] / 0.17 [102/600]   | 0.9367 [562/600] / 0.955 [573/600]  | — [0/0] / 0.2054 [46/224]    | — [0/0] / 0.2054 [46/224]    |
| 900-1200s | 1944 / 1417 | 17 / 17         | 0 / 0     | 48 / 49      | 44 / 84        | 0.1736 [104/599] / 0.1736 [104/599] | 0.9048 [542/599] / 0.9065 [543/599] | — [0/0] / 0.6563 [63/96]     | — [0/0] / 0.6563 [63/96]     |

| minute    | ΔHP           | units end | towers end | general alive end | general HP end | general cell end | general dead n/d               | train accepted | far alone n/d            | HP decrease steps |
| --------- | ------------- | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------ | -------------- | ------------------------ | ----------------- |
| minute-16 | -5883 / -341  | 7 / 5     | 1 / 1      | 1 / 1             | 197 / 220      | 274 / 1166       | 0.3333 [20/60] / 0 [0/60]      | 6 / 16         | — [0/0] / 0.6563 [63/96] | 46 / 3            |
| minute-17 | -1359 / -2520 | 7 / 4     | 0 / 1      | 0 / 1             | 0 / 65         | -1 / 1128        | 0.25 [15/60] / 0.1667 [10/60]  | 11 / 14        | — [0/0] / — [0/0]        | 19 / 20           |
| minute-18 | -4861 / -1276 | 1 / 7     | 0 / 1      | 1 / 1             | 77 / 158       | 274 / 709        | 0.0833 [5/60] / 0.1667 [10/60] | 3 / 18         | — [0/0] / — [0/0]        | 43 / 12           |
| minute-19 | -1459 / -1134 | 4 / 4     | 1 / 0      | 1 / 0             | 6 / 0          | 433 / -1         | 0 [0/60] / 0.1667 [10/60]      | 10 / 18        | — [0/0] / — [0/0]        | 22 / 13           |
| minute-20 | -1698 / -94   | 3 / 5     | 0 / 2      | 1 / 1             | 55 / 92        | 311 / 1059       | 0.3333 [20/60] / 0 [0/60]      | 14 / 18        | — [0/0] / — [0/0]        | 16 / 2            |

### Seed 23

Ослабление начинается асимметрично: к 600 с база 0 уже 20359 HP, база 1 — 38556. В последних минутах давление разворачивается: на минуте 20 база 0 теряет 96 HP, база 1 — 2762; войска 8/4, заказы 15/13. Последнее снижение базы 1 на тике 36000. Малое число башен и доли мёртвого генерала совместимы с продолжающимся боем и не устанавливают общего истощения.

Итог: HP 7027 / 17233; войска 8 / 4; башни пик 3 / 5 → конец 1 / 0. Последние снижения HP: 35100 / 36000 тиков; хвосты: 30 / 0 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 239      | 241      |
| pass: saving-for-better | 1009     | 936      |
| wait: unit-unaffordable | 992      | 1086     |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | ------------------------------- | ----------------- |
| 0-300s    | 32960 / 40000 | -7040 / 0      | 2→2; 2→6            | 0→1; 0→2             | 6 / 3     | 0.1338 [40/299] / 0 [0/299]     | 57 / 0            |
| 300-600s  | 20359 / 38556 | -12601 / -1444 | 2→4; 6→6            | 1→0; 2→1             | 30 / 17   | 0.1567 [47/300] / 0.1 [30/300]  | 142 / 22          |
| 600-900s  | 13619 / 26970 | -6740 / -11586 | 4→4; 6→5            | 0→0; 1→1             | 28 / 33   | 0.2033 [61/300] / 0.2 [60/300]  | 69 / 131          |
| 900-1200s | 7027 / 17233  | -6592 / -9737  | 4→8; 5→4            | 0→1; 1→0             | 23 / 29   | 0.14 [42/300] / 0.1767 [53/300] | 70 / 106          |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                 | far alone with army n/d       |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ----------------------------- | ----------------------------- |
| 0-300s    | 1088 / 1068 | 17 / 17         | 0 / 0     | 24 / 34      | 69 / 66        | 0.1923 [115/598] / 0.1739 [104/598] | 0.9314 [557/598] / 0.9197 [550/598] | — [0/0] / 0.5122 [21/41]      | — [0/0] / 0.5122 [21/41]      |
| 300-600s  | 942 / 1019  | 17 / 17         | 0 / 0     | 32 / 44      | 46 / 66        | 0.21 [126/600] / 0.185 [111/600]    | 0.91 [546/600] / 0.9 [540/600]      | — [0/0] / 0.3186 [72/226]     | — [0/0] / 0.3186 [72/226]     |
| 600-900s  | 919 / 1334  | 17 / 17         | 0 / 0     | 42 / 55      | 59 / 47        | 0.1733 [104/600] / 0.1933 [116/600] | 0.8967 [538/600] / 0.905 [543/600]  | 0.4 [26/65] / 0.5119 [43/84]  | 0.4 [26/65] / 0.5119 [43/84]  |
| 900-1200s | 3025 / 1750 | 17 / 17         | 0 / 0     | 47 / 55      | 63 / 60        | 0.172 [103/599] / 0.172 [103/599]   | 0.9182 [550/599] / 0.9182 [550/599] | 0.46 [23/50] / 0.4615 [12/26] | 0.46 [23/50] / 0.4615 [12/26] |

| minute    | ΔHP           | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d             | HP decrease steps |
| --------- | ------------- | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ------------------------- | ----------------- |
| minute-16 | -4024 / -95   | 4 / 8     | 0 / 0      | 1 / 1             | 49 / 242       | 349 / 1087       | 0.2 [12/60] / 0.1667 [10/60]    | 10 / 18        | — [0/0] / 0.4583 [11/24]  | 38 / 2            |
| minute-17 | -274 / -994   | 3 / 5     | 2 / 1      | 1 / 1             | 19 / 242       | 361 / 1202       | 0 [0/60] / 0.1667 [10/60]       | 15 / 13        | 0.1818 [2/11] / 0.5 [1/2] | 6 / 22            |
| minute-18 | -1685 / -3488 | 5 / 2     | 0 / 0      | 0 / 1             | 0 / 242        | -1 / 1131        | 0.3333 [20/60] / 0.1667 [10/60] | 10 / 8         | 0.4091 [9/22] / — [0/0]   | 15 / 27           |
| minute-19 | -513 / -2398  | 6 / 2     | 1 / 1      | 1 / 1             | 124 / 58       | 540 / 976        | 0.1667 [10/60] / 0.1667 [10/60] | 13 / 8         | 1 [1/1] / — [0/0]         | 9 / 24            |
| minute-20 | -96 / -2762   | 8 / 4     | 1 / 0      | 1 / 0             | 16 / 0         | 936 / -1         | 0 [0/60] / 0.2167 [13/60]       | 15 / 13        | 0.6875 [11/16] / — [0/0]  | 2 / 31            |

### Seed 32

На минутах 18–20 обе базы снова получают давление после паузы базы 1 на минуте 17. На минуте 18 изменения −10388/−3861 HP, мёртвый генерал 37/20 из 60 снимков; на минуте 20 изменения −1902/−3342, заказы 12/11, войска 6/4. Двустороннее ослабление генералов сопутствует обмену ударами; оно не объясняет тайм-аут через прекращение давления.

Итог: HP 1866 / 11654; войска 6 / 4; башни пик 3 / 3 → конец 1 / 0. Последние снижения HP: 34980 / 36000 тиков; хвосты: 34 / 0 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 239      | 245      |
| pass: saving-for-better | 973      | 1045     |
| wait: unit-unaffordable | 1041     | 973      |

| seconds   | HP end        | ΔHP             | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                   | HP decrease steps |
| --------- | ------------- | --------------- | ------------------- | -------------------- | --------- | ---------------------------------- | ----------------- |
| 0-300s    | 39527 / 38047 | -473 / -1953    | 2→7; 2→6            | 0→1; 0→2             | 10 / 13   | 0.0669 [20/299] / 0.0669 [20/299]  | 16 / 27           |
| 300-600s  | 32280 / 33740 | -7247 / -4307   | 7→8; 6→4            | 1→1; 2→1             | 19 / 20   | 0.2333 [70/300] / 0.1333 [40/300]  | 83 / 59           |
| 600-900s  | 22845 / 22790 | -9435 / -10950  | 8→3; 4→5            | 1→0; 1→1             | 22 / 18   | 0.1667 [50/300] / 0.2 [60/300]     | 82 / 91           |
| 900-1200s | 1866 / 11654  | -20979 / -11136 | 3→6; 5→4            | 0→1; 1→0             | 19 / 14   | 0.3333 [100/300] / 0.1767 [53/300] | 148 / 89          |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                  | far alone with army n/d        |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ------------------------------ | ------------------------------ |
| 0-300s    | 972 / 265   | 17 / 17         | 0 / 0     | 28 / 30      | 55 / 54        | 0.1806 [108/598] / 0.1823 [109/598] | 0.9097 [544/598] / 0.9064 [542/598] | 0.1081 [8/74] / 0.7955 [35/44] | 0.1081 [8/74] / 0.7955 [35/44] |
| 300-600s  | 893 / 284   | 17 / 17         | 0 / 0     | 41 / 44      | 62 / 65        | 0.19 [114/600] / 0.1817 [109/600]   | 0.93 [558/600] / 0.94 [564/600]     | 0.8889 [16/18] / 0.6923 [9/13] | 0.8889 [16/18] / 0.6923 [9/13] |
| 600-900s  | 2047 / 782  | 17 / 17         | 0 / 0     | 46 / 48      | 70 / 65        | 0.1717 [103/600] / 0.1733 [104/600] | 0.9217 [553/600] / 0.94 [564/600]   | 0.3875 [31/80] / 1 [7/7]       | 0.3875 [31/80] / 1 [7/7]       |
| 900-1200s | 1092 / 2102 | 17 / 17         | 0 / 0     | 52 / 52      | 50 / 59        | 0.1686 [101/599] / 0.1653 [99/599]  | 0.9165 [549/599] / 0.9366 [561/599] | 0.4255 [20/47] / 0.5385 [7/13] | 0.4255 [20/47] / 0.5385 [7/13] |

| minute    | ΔHP            | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d            | HP decrease steps |
| --------- | -------------- | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ------------------------ | ----------------- |
| minute-16 | -4224 / -48    | 4 / 6     | 0 / 1      | 1 / 0             | 9 / 0          | 422 / -1         | 0.1667 [10/60] / 0.0833 [5/60]  | 8 / 15         | — [0/0] / — [0/0]        | 41 / 2            |
| minute-17 | -210 / 0       | 1 / 6     | 1 / 1      | 1 / 1             | 56 / 125       | 237 / 1128       | 0.1667 [10/60] / 0.0833 [5/60]  | 14 / 17        | — [0/0] / — [0/0]        | 7 / 0             |
| minute-18 | -10388 / -3861 | 4 / 6     | 0 / 0      | 0 / 1             | 0 / 220        | -1 / 1017        | 0.6167 [37/60] / 0.3333 [20/60] | 6 / 7          | — [0/0] / 0.5385 [7/13]  | 51 / 25           |
| minute-19 | -4255 / -3885  | 5 / 5     | 0 / 1      | 0 / 1             | 0 / 140        | -1 / 1163        | 0.45 [27/60] / 0.1667 [10/60]   | 10 / 9         | — [0/0] / — [0/0]        | 31 / 36           |
| minute-20 | -1902 / -3342  | 6 / 4     | 1 / 0      | 1 / 0             | 103 / 0        | 553 / -1         | 0.2667 [16/60] / 0.2167 [13/60] | 12 / 11        | 0.4255 [20/47] / — [0/0] | 18 / 26           |

### Seed 39

За 900–1200 с обе базы снижаются, но на минуте 20 база 0 стабильна, база 1 теряет 9347 HP (48 снижений). У стороны 0 в этой минуте генерал жив во всех sample, заказы 15, войска 7; у стороны 1 20 мёртвых sample, заказы 11, войска 4, башен нет. Пауза одной базы не равна взаимному застою; последнее снижение другой на тике 36000.

Итог: HP 22886 / 14713; войска 7 / 4; башни пик 7 / 8 → конец 1 / 0. Последние снижения HP: 33720 / 36000 тиков; хвосты: 76 / 0 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 279      | 317      |
| pass: saving-for-better | 708      | 883      |
| wait: unit-unaffordable | 1297     | 1077     |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 40000 / 38277 | 0 / -1723      | 2→4; 2→7            | 0→2; 0→1             | 6 / 6     | 0.0334 [10/299] / 0.0669 [20/299] | 0 / 22            |
| 300-600s  | 40000 / 37629 | 0 / -648       | 4→8; 7→0            | 2→5; 1→0             | 8 / 14    | 0 [0/300] / 0.1 [30/300]          | 0 / 8             |
| 600-900s  | 31441 / 34581 | -8559 / -3048  | 8→4; 0→5            | 5→1; 0→1             | 13 / 25   | 0.1667 [50/300] / 0.2 [60/300]    | 82 / 40           |
| 900-1200s | 22886 / 14713 | -8555 / -19868 | 4→7; 5→4            | 1→1; 1→0             | 17 / 19   | 0.1667 [50/300] / 0.2333 [70/300] | 59 / 125          |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                    | far alone with army n/d          |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | -------------------------------- | -------------------------------- |
| 0-300s    | 1177 / 744  | 17 / 19         | 0 / 0     | 31 / 27      | 65 / 68        | 0.1739 [104/598] / 0.1906 [114/598] | 0.9331 [558/598] / 0.9264 [554/598] | 0.2708 [13/48] / 0 [0/6]         | 0.2708 [13/48] / 0 [0/6]         |
| 300-600s  | 1151 / 1848 | 17 / 19         | 0 / 0     | 43 / 36      | 92 / 109       | 0.1767 [106/600] / 0.2233 [134/600] | 0.97 [582/600] / 0.9733 [584/600]   | 0.75 [12/16] / 0.2857 [6/21]     | 0.75 [12/16] / 0.2857 [6/21]     |
| 600-900s  | 3077 / 378  | 17 / 19         | 0 / 0     | 47 / 49      | 60 / 77        | 0.1733 [104/600] / 0.1967 [118/600] | 0.9217 [553/600] / 0.9383 [563/600] | 0.3788 [25/66] / 0.25 [19/76]    | 0.3788 [25/66] / 0.25 [19/76]    |
| 900-1200s | 1827 / 1598 | 17 / 19         | 0 / 0     | 60 / 55      | 60 / 61        | 0.1736 [104/599] / 0.182 [109/599]  | 0.9165 [549/599] / 0.9115 [546/599] | 0.1571 [22/140] / 0.2025 [16/79] | 0.1571 [22/140] / 0.2025 [16/79] |

| minute    | ΔHP          | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d            | HP decrease steps |
| --------- | ------------ | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ------------------------ | ----------------- |
| minute-16 | 0 / -1062    | 6 / 4     | 1 / 0      | 1 / 1             | 220 / 172      | 773 / 1056       | 0.1667 [10/60] / 0.1667 [10/60] | 15 / 15        | — [0/0] / — [0/0]        | 0 / 15            |
| minute-17 | -483 / -8203 | 9 / 2     | 2 / 0      | 1 / 0             | 35 / 0         | 1057 / -1        | 0 [0/60] / 0.3 [18/60]          | 8 / 6          | 0.0789 [3/38] / — [0/0]  | 9 / 49            |
| minute-18 | -5775 / -658 | 6 / 5     | 0 / 4      | 0 / 1             | 0 / 2          | -1 / 435         | 0.4833 [29/60] / 0.0333 [2/60]  | 12 / 15        | 0 [0/5] / 0.1364 [9/66]  | 31 / 4            |
| minute-19 | -2297 / -598 | 6 / 2     | 2 / 0      | 1 / 1             | 242 / 119      | 781 / 1094       | 0.1833 [11/60] / 0.3333 [20/60] | 10 / 14        | 0 [0/8] / 0.5385 [7/13]  | 19 / 9            |
| minute-20 | 0 / -9347    | 7 / 4     | 1 / 0      | 1 / 1             | 44 / 44        | 896 / 1132       | 0 [0/60] / 0.3333 [20/60]       | 15 / 11        | 0.2135 [19/89] / — [0/0] | 0 / 48            |

### Seed 42

Самый отчётливый локальный застой: за 900–1200 с ΔHP лишь −1748/−1548, последнее снижение на 34140/31080 тиках, хвост 62/164 с. На минуте 19 база 0 ещё теряет 1555 HP при 25 мёртвых sample генерала; на минуте 20 обе базы стабильны, войска 4/4, башни 0/1, мёртвый генерал 5/17 из 60 sample. При этом 18/17 принятых заказов за последнюю минуту и 88/89 за последние пять, доход 17/17, путь есть. Срыв доставки урона правдоподобнее прекращения закупок; позиция/цели войск и причинный механизм в этих агрегатах не наблюдаются.

Итог: HP 12640 / 30375; войска 4 / 4; башни пик 4 / 4 → конец 0 / 1. Последние снижения HP: 34140 / 31080 тиков; хвосты: 62 / 164 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 279      | 294      |
| pass: saving-for-better | 770      | 808      |
| wait: unit-unaffordable | 1219     | 1190     |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 28368 / 38552 | -11632 / -1448 | 2→7; 2→8            | 0→0; 0→2             | 12 / 6    | 0.1672 [50/299] / 0.0334 [10/299] | 109 / 25          |
| 300-600s  | 26345 / 37137 | -2023 / -1415  | 7→3; 8→3            | 0→0; 2→1             | 17 / 10   | 0.1 [30/300] / 0.14 [42/300]      | 25 / 27           |
| 600-900s  | 14388 / 31923 | -11957 / -5214 | 3→5; 3→7            | 0→0; 1→2             | 17 / 14   | 0.1333 [40/300] / 0.16 [48/300]   | 104 / 83          |
| 900-1200s | 12640 / 30375 | -1748 / -1548  | 5→4; 7→4            | 0→0; 2→1             | 15 / 14   | 0.1333 [40/300] / 0.19 [57/300]   | 22 / 23           |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                  | far alone with army n/d        |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ------------------------------ | ------------------------------ |
| 0-300s    | 537 / 833   | 17 / 17         | 0 / 0     | 25 / 34      | 47 / 60        | 0.1806 [108/598] / 0.1756 [105/598] | 0.9214 [551/598] / 0.888 [531/598]  | — [0/0] / 0.0881 [14/159]      | — [0/0] / 0.0755 [12/159]      |
| 300-600s  | 1990 / 1305 | 17 / 17         | 0 / 0     | 47 / 42      | 73 / 82        | 0.1967 [118/600] / 0.195 [117/600]  | 0.9133 [548/600] / 0.9467 [568/600] | 0.1333 [8/60] / 0 [0/67]       | 0.1333 [8/60] / 0 [0/67]       |
| 600-900s  | 1882 / 317  | 17 / 17         | 0 / 0     | 49 / 51      | 69 / 61        | 0.175 [105/600] / 0.1733 [104/600]  | 0.9217 [553/600] / 0.9433 [566/600] | 0.2619 [11/42] / 0.1765 [3/17] | 0.2619 [11/42] / 0.1765 [3/17] |
| 900-1200s | 1492 / 709  | 17 / 17         | 0 / 0     | 49 / 53      | 88 / 89        | 0.172 [103/599] / 0.1753 [105/599]  | 0.9716 [582/599] / 0.9432 [565/599] | — [0/0] / 0.3171 [13/41]       | — [0/0] / 0.3171 [13/41]       |

| minute    | ΔHP         | units end | towers end | general alive end | general HP end | general cell end | general dead n/d               | train accepted | far alone n/d            | HP decrease steps |
| --------- | ----------- | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------ | -------------- | ------------------------ | ----------------- |
| minute-16 | -49 / -1140 | 6 / 3     | 2 / 0      | 1 / 1             | 6 / 220        | 464 / 1131       | 0 [0/60] / 0.3333 [20/60]      | 17 / 15        | — [0/0] / 0 [0/3]        | 1 / 11            |
| minute-17 | -72 / -96   | 4 / 6     | 1 / 0      | 1 / 1             | 220 / 4        | 506 / 898        | 0.1667 [10/60] / 0 [0/60]      | 19 / 17        | — [0/0] / 0 [0/1]        | 2 / 3             |
| minute-18 | -72 / -312  | 5 / 4     | 1 / 1      | 1 / 0             | 65 / 0         | 198 / -1         | 0 [0/60] / 0.25 [15/60]        | 18 / 18        | — [0/0] / 0.4444 [12/27] | 2 / 9             |
| minute-19 | -1555 / 0   | 4 / 7     | 0 / 1      | 0 / 1             | 0 / 135        | -1 / 940         | 0.4167 [25/60] / 0.0833 [5/60] | 16 / 22        | — [0/0] / — [0/0]        | 17 / 0            |
| minute-20 | 0 / 0       | 4 / 4     | 0 / 1      | 1 / 0             | 136 / 0        | 276 / -1         | 0.0833 [5/60] / 0.2833 [17/60] | 18 / 17        | — [0/0] / 0.1 [1/10]     | 0 / 0             |

### Seed 58

У стороны 1 войска на 900 с равны 10, на 1080 с ноль, на 1200 с снова 4. На минутах 18 и 19 база 1 теряет 4252 и 7716 HP, несмотря на возобновление заказов. В последнюю минуту обе базы снижаются (−125/−1643), заказы 16/15; последнее снижение 35970/35790 тиков. Это временное ослабление с восстановлением армии, а не постоянная двусторонняя пустота.

Итог: HP 24467 / 7432; войска 4 / 4; башни пик 5 / 6 → конец 1 / 1. Последние снижения HP: 35970 / 35790 тиков; хвосты: 1 / 7 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 271      | 252      |
| pass: saving-for-better | 1018     | 893      |
| wait: unit-unaffordable | 1007     | 1138     |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 37364 / 39211 | -2636 / -789   | 2→8; 2→1            | 0→2; 0→1             | 7 / 7     | 0.0669 [20/299] / 0 [0/299]       | 45 / 21           |
| 300-600s  | 35698 / 32553 | -1666 / -6658  | 8→6; 1→3            | 2→2; 1→2             | 22 / 22   | 0.0667 [20/300] / 0.2 [60/300]    | 32 / 86           |
| 600-900s  | 31153 / 25883 | -4545 / -6670  | 6→4; 3→10           | 2→2; 2→3             | 25 / 31   | 0.1333 [40/300] / 0.1667 [50/300] | 42 / 66           |
| 900-1200s | 24467 / 7432  | -6686 / -18451 | 4→4; 10→4           | 2→1; 3→1             | 23 / 29   | 0.2 [60/300] / 0.2333 [70/300]    | 64 / 127          |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                  | far alone with army n/d        |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | ------------------------------ | ------------------------------ |
| 0-300s    | 1637 / 1400 | 17 / 17         | 0 / 0     | 25 / 31      | 60 / 59        | 0.1823 [109/598] / 0.1722 [103/598] | 0.9348 [559/598] / 0.9348 [559/598] | — [0/0] / 0 [0/1]              | — [0/0] / 0 [0/1]              |
| 300-600s  | 1577 / 1402 | 17 / 17         | 0 / 0     | 36 / 39      | 62 / 63        | 0.1983 [119/600] / 0.195 [117/600]  | 0.93 [558/600] / 0.9383 [563/600]   | 0.4324 [32/74] / 0.1228 [7/57] | 0.4324 [32/74] / 0.1228 [7/57] |
| 600-900s  | 766 / 913   | 17 / 17         | 0 / 0     | 42 / 45      | 82 / 70        | 0.185 [111/600] / 0.1867 [112/600]  | 0.9383 [563/600] / 0.9433 [566/600] | 0.8283 [82/99] / 0.6 [24/40]   | 0.8283 [82/99] / 0.575 [23/40] |
| 900-1200s | 1318 / 683  | 17 / 17         | 0 / 0     | 54 / 49      | 65 / 58        | 0.1619 [97/599] / 0.1653 [99/599]   | 0.9332 [559/599] / 0.9366 [561/599] | 0.3673 [18/49] / — [0/0]       | 0.3673 [18/49] / — [0/0]       |

| minute    | ΔHP           | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d            | HP decrease steps |
| --------- | ------------- | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ------------------------ | ----------------- |
| minute-16 | -5173 / -3422 | 4 / 4     | 0 / 1      | 1 / 1             | 169 / 51       | 275 / 1057       | 0.5 [30/60] / 0.3333 [20/60]    | 9 / 7          | — [0/0] / — [0/0]        | 37 / 29           |
| minute-17 | -598 / -1418  | 10 / 6    | 0 / 0      | 1 / 0             | 242 / 0        | 312 / -1         | 0.1667 [10/60] / 0.1167 [7/60]  | 16 / 16        | 1 [1/1] / — [0/0]        | 12 / 9            |
| minute-18 | -790 / -4252  | 7 / 0     | 3 / 0      | 1 / 1             | 187 / 3        | 547 / 1095       | 0.1667 [10/60] / 0.2167 [13/60] | 11 / 9         | 1 [7/7] / — [0/0]        | 12 / 37           |
| minute-19 | 0 / -7716     | 4 / 5     | 1 / 1      | 1 / 1             | 22 / 134       | 500 / 857        | 0 [0/60] / 0.3333 [20/60]       | 13 / 11        | 0.2439 [10/41] / — [0/0] | 0 / 38            |
| minute-20 | -125 / -1643  | 4 / 4     | 1 / 1      | 1 / 1             | 242 / 220      | 423 / 1133       | 0.1667 [10/60] / 0.1667 [10/60] | 16 / 15        | — [0/0] / — [0/0]        | 3 / 14            |

### Seed 60

На 900 с войска 12/0; на минуте 16 сторона 0 достигает 16, пока база 1 теряет 7301 HP. На минуте 17 у стороны 0 уже два юнита, но база 1 теряет ещё 7229 HP. К концу войска 4/2, последняя минута −857/−2066 HP, заказы 13/15, последнее снижение базы 1 на 36000. Малочисленность меняется во времени и не означает прекращения угрозы базе.

Итог: HP 10223 / 6638; войска 4 / 2; башни пик 5 / 4 → конец 2 / 0. Последние снижения HP: 35280 / 36000 тиков; хвосты: 24 / 0 с.

Попытки производства за всю жизнь (не решения и не принятые команды):

| result: note            | player 0 | player 1 |
| ----------------------- | -------- | -------- |
| bought: none            | 250      | 246      |
| pass: saving-for-better | 967      | 1122     |
| wait: unit-unaffordable | 1037     | 889      |

| seconds   | HP end        | ΔHP            | units start→end 0;1 | towers start→end 0;1 | walls end | general dead n/d                  | HP decrease steps |
| --------- | ------------- | -------------- | ------------------- | -------------------- | --------- | --------------------------------- | ----------------- |
| 0-300s    | 33990 / 38341 | -6010 / -1659  | 2→7; 2→4            | 0→1; 0→1             | 9 / 18    | 0.1003 [30/299] / 0.0334 [10/299] | 59 / 32           |
| 300-600s  | 23347 / 37722 | -10643 / -619  | 7→6; 4→4            | 1→2; 1→1             | 22 / 27   | 0.2333 [70/300] / 0.1 [30/300]    | 133 / 14          |
| 600-900s  | 16051 / 25544 | -7296 / -12178 | 6→12; 4→0           | 2→2; 1→0             | 20 / 23   | 0.1667 [50/300] / 0.2 [60/300]    | 82 / 114          |
| 900-1200s | 10223 / 6638  | -5828 / -18906 | 12→4; 0→2           | 2→2; 0→0             | 27 / 24   | 0.1333 [40/300] / 0.2667 [80/300] | 59 / 150          |

| seconds   | energy end  | income/tick end | queue end | upgrades end | train accepted | bought n/d                          | saving n/d                          | far alone n/d                    | far alone with army n/d          |
| --------- | ----------- | --------------- | --------- | ------------ | -------------- | ----------------------------------- | ----------------------------------- | -------------------------------- | -------------------------------- |
| 0-300s    | 2244 / 769  | 17 / 17         | 0 / 0     | 29 / 31      | 51 / 57        | 0.1789 [107/598] / 0.199 [119/598]  | 0.8829 [528/598] / 0.8779 [525/598] | 0.4632 [44/95] / 0.3445 [41/119] | 0.4632 [44/95] / 0.3445 [41/119] |
| 300-600s  | 1552 / 1389 | 17 / 17         | 0 / 0     | 40 / 43      | 57 / 68        | 0.1967 [118/600] / 0.1867 [112/600] | 0.925 [555/600] / 0.93 [558/600]    | — [0/0] / 0.1522 [14/92]         | — [0/0] / 0.1522 [14/92]         |
| 600-900s  | 1361 / 2168 | 17 / 17         | 0 / 0     | 49 / 46      | 64 / 64        | 0.1683 [101/600] / 0.1733 [104/600] | 0.9183 [551/600] / 0.915 [549/600]  | 0.2615 [17/65] / 0.24 [24/100]   | 0.2615 [17/65] / 0.24 [24/100]   |
| 900-1200s | 1318 / 671  | 17 / 17         | 0 / 0     | 50 / 51      | 76 / 55        | 0.1786 [107/599] / 0.1753 [105/599] | 0.9098 [545/599] / 0.9249 [554/599] | 0.2541 [47/185] / 1 [1/1]        | 0.2541 [47/185] / 1 [1/1]        |

| minute    | ΔHP          | units end | towers end | general alive end | general HP end | general cell end | general dead n/d                | train accepted | far alone n/d            | HP decrease steps |
| --------- | ------------ | --------- | ---------- | ----------------- | -------------- | ---------------- | ------------------------------- | -------------- | ------------------------ | ----------------- |
| minute-16 | 0 / -7301    | 16 / 2    | 3 / 0      | 1 / 0             | 92 / 0         | 709 / -1         | 0 [0/60] / 0.3 [18/60]          | 18 / 7         | 0.3368 [32/95] / — [0/0] | 0 / 53            |
| minute-17 | 0 / -7229    | 2 / 4     | 1 / 2      | 1 / 1             | 92 / 90        | 348 / 1206       | 0 [0/60] / 0.3667 [22/60]       | 19 / 6         | 0.1573 [14/89] / — [0/0] | 0 / 46            |
| minute-18 | -886 / -1563 | 5 / 5     | 1 / 1      | 1 / 1             | 220 / 220      | 279 / 1057       | 0.1667 [10/60] / 0.3333 [20/60] | 16 / 18        | — [0/0] / — [0/0]        | 14 / 13           |
| minute-19 | -4085 / -747 | 2 / 3     | 0 / 1      | 1 / 1             | 1 / 124        | 350 / 739        | 0.3333 [20/60] / 0 [0/60]       | 10 / 9         | 1 [1/1] / 1 [1/1]        | 29 / 10           |
| minute-20 | -857 / -2066 | 4 / 2     | 2 / 0      | 1 / 0             | 9 / 0          | 541 / -1         | 0.1667 [10/60] / 0.3333 [20/60] | 13 / 15        | — [0/0] / — [0/0]        | 16 / 28           |

## Независимая сверка чисел

Прямые SQL-запросы к readOnly-базе не использовали функции расчёта метрик.
Для seed 42 взято окно (27000,36000], для контроля seed 15 — (32400,34200].
Порядок player 0 / 1:

| Проверка                | Seed 42         | Seed 15       |
| ----------------------- | --------------- | ------------- |
| HP начала               | 14388 / 31923   | 39734 / 23479 |
| HP конца                | 12640 / 30375   | 39734 / 1454  |
| ΔHP                     | −1748 / −1548   | 0 / −22025    |
| Соседние снижения       | 22 / 23         | 0 / 60        |
| Последнее снижение окна | 34140 / 31080   | нет / 34200   |
| Принятые TrainUnit      | 88 / 89         | 20 / 0        |
| Мёртвый генерал         | 40/300 / 57/300 | 0/60 / 0/60   |
| Нет пути                | 0/300 / 0/300   | 0/60 / 0/60   |

Разности HP проверены вычитанием показанных концов; снижения — отдельным LAG,
заказы — отдельным COUNT без JOIN; отсутствие строки GROUP BY команды стороны 1
у контроля проверено как ноль заказов при имеющихся sample и decision.
Все перечисленные значения совпали с результатом модуля.

```sql
SELECT tick, player, base_hp, units_alive, towers, general_alive, general_hp
FROM sample WHERE match_id = ? AND tick IN (?, ?) ORDER BY player, tick;

WITH transitions AS (
  SELECT player, tick, base_hp,
    LAG(base_hp) OVER (PARTITION BY player ORDER BY tick) AS prev
  FROM sample WHERE match_id = ? AND tick >= ? AND tick <= ?
)
SELECT player, SUM(base_hp < prev) AS decrease_steps,
  MAX(CASE WHEN base_hp < prev THEN tick END) AS last_decrease
FROM transitions GROUP BY player ORDER BY player;

SELECT player, COUNT(*) FROM command
WHERE match_id = ? AND tick > ? AND tick <= ? AND kind = 2 AND accepted = 1
GROUP BY player ORDER BY player;

SELECT player, SUM(general_alive = 0), COUNT(*), SUM(path_to_enemy = 0)
FROM sample WHERE match_id = ? AND tick > ? AND tick <= ? GROUP BY player;
```

## Что объяснено и что остаётся гипотезой

1. **Слабое раннее давление с последующим усилением** лучше согласуется с общей
   картиной, чем прекращение боя: mean ΔHP тайм-аутов по окнам −2258.9, −2955.0,
   −6518.0, −10906.0; соседних снижений 27.6, 38.0, 67.6, 85.5. Среди завершённых,
   доживших до 300 с, первая ΔHP −5908.4; к 900 с остаётся всего 11 из 49.
   Это описание выбранных групп, не доказательство причинного эффекта темпа.
2. **Неоднородная доставка урона и смена преимущества** видны в seed 2, 3, 5,
   17, 23, 39, 58, 60. Стабильность одной базы сочетается с падением другой;
   seed 3 с 19 юнитами противоположной стороны и снижением HP на пределе —
   сильный контрпример объяснению «обоим нечем добить».
3. **Взаимное ослабление построек и эпизоды отсутствия генерала** присутствуют,
   но не отличают timeout однозначно. За lifetime mean пик→конец башен 5.1364→0.9545
   против 4.6429→0.8265 у завершённых; general_dead 12.05% против 14.85% с равным
   весом матчей. Pooled за жизнь завершённых — 14.04%, это иной знаменатель.
   В seed 11 обе стороны без башен всё ещё снижают HP на пределе. В контроле
   seed 15 решающая минута проходит при живых генералах обеих сторон.
4. **Локальный поздний застой seed 42** подтверждён наблюдениями, его причина
   не установлена. Доход, войска и закупки сохраняются; нельзя объяснить его
   прекращением производства или записанной потерей пути. Отсутствие сопровождения
   не универсально: в последних пяти минутах у стороны 0 нет дальних решений,
   у стороны 1 13/41 без сопровождения, а на последней минуте только 1/10.
5. **Перекрытый путь** не поддержан ни одним sample (0/92214). Секундная
   доступность пути не доказывает положение всех юнитов и не исключает короткого
   внутрисекундного события, но объяснение постоянной блокировкой не подходит.

Полного прекращения закупок обеими сторонами в последних пяти минутах нет ни
в одном timeout. Конечная малочисленность и спад относительно пика не измеряют
реальные потери; нужны события рождения/гибели, позиции и цели, чтобы отличить
быстрое пополнение с потерями от недоставки атак к базе. Нет оснований выбирать
балансное лечение, увеличивать предел или назначать победителя по HP.

Конкретный будущий эксперимент: отдельно исследовать доставку атак в seed 42
на исторической ревизии, сопоставив (если будет получена совместимая запись)
позиции/цели войск и источники урона с seed 3 и завершённым seed 15. Ожидание
задать до запуска: гипотеза недоставки требует сохраняющихся заказов и живых
войск без контакта с базой; гипотеза истощения требует подтверждённых потерь
до контакта. Контроль должен менять один механизм и сохранять миры/зёрна,
а не заменять архив новой ревизией. Этот отчёт не запускает эксперимент и
не обещает восстановить недоступные сырые логи; дальнейший план — отдельная задача.
