/**
 * Схема аналитической базы.
 *
 * Главный принцип: **храним факты, а не выводы.** В таблицах лежат
 * величины решений, а не суждения о них. Что считать дрожью, что
 * топтанием и что провалом — решается запросом при разборе. Зашей мы
 * признак «это дрожь» в момент записи, и через неделю окажется, что
 * записан не тот признак, а матчи придётся переигрывать.
 *
 * База пересобирается из логов целиком, поэтому миграций у неё нет
 * и не будет: поменялась схема — пересобрали. Это тоже осознанно.
 * Миграции нужны там, где данные незаменимы; здесь незаменимы логи,
 * а база — производное от них.
 */
export const SCHEMA = `
create table if not exists match (
  match_id    text primary key,
  kind        text not null,
  world_seed  integer not null,
  ai_seed_0   integer,
  ai_seed_1   integer,
  profile_0   text,
  profile_1   text,
  git_sha     text not null,
  git_dirty   integer not null,
  started_at  text not null,
  ticks       integer,
  winner      integer,
  end_reason  text,
  wall_ms     integer
);

create table if not exists sample (
  match_id            text not null,
  tick                integer not null,
  player              integer not null,
  energy              integer not null,
  income_per_tick     integer not null,
  units_alive         integer not null,
  structures          integer not null,
  towers              integer not null,
  walls               integer not null,
  base_hp             integer not null,
  general_cell        integer not null,
  general_hp          integer not null,
  general_alive       integer not null,
  queue_len           integer not null,
  upgrade_total_level integer not null,
  target_structure    integer not null
);

create table if not exists decision (
  match_id          text not null,
  tick              integer not null,
  player            integer not null,
  phase_index       integer not null,
  wait_streak       integer not null,
  impatient         integer not null,
  escorting         integer not null,
  live_units        integer not null,
  spend_order       text not null,
  energy            integer not null,
  struck            integer not null,
  command_count     integer not null,
  general_cell      integer not null,
  general_from_home integer not null,
  approach_shortest integer not null
);

-- Попытки потратить энергию: здесь и живёт «чего не произошло».
-- Мир показывает, что случилось; только эта таблица покажет, чего
-- противник хотел и что ему помешало.
create table if not exists attempt (
  match_id text not null,
  tick     integer not null,
  player   integer not null,
  ord      integer not null,
  spending text not null,
  result   text not null,
  note     text
);

-- Оценки ВСЕХ рубежей каждого решения, а не только выбранного.
-- Если победивший рубеж обошёл соседний на два процента, это дрожь,
-- а не решение, и увидеть это можно только имея обе оценки.
create table if not exists frontier (
  match_id     text not null,
  tick         integer not null,
  player       integer not null,
  fraction     real not null,
  cell         integer not null,
  coverage     integer not null,
  gain         real not null,
  risk         real not null,
  score        real not null,
  death_chance real not null,
  chosen       integer not null
);

create table if not exists command (
  match_id      text not null,
  tick          integer not null,
  player        integer not null,
  kind          integer not null,
  arg0          integer not null,
  arg1          integer not null,
  accepted      integer not null,
  reject_reason integer
);

create index if not exists sample_by_match   on sample   (match_id, player, tick);
create index if not exists decision_by_match on decision (match_id, player, tick);
create index if not exists attempt_by_match  on attempt  (match_id, player, tick);
create index if not exists frontier_by_match on frontier (match_id, player, tick);
create index if not exists command_by_match  on command  (match_id, player, tick);
`;

/** Таблицы, зависящие от матча. Чистятся при повторной сборке. */
export const CHILD_TABLES: readonly string[] = [
  'sample',
  'decision',
  'attempt',
  'frontier',
  'command',
];
