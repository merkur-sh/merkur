-- Each display preparation's hop between threads, joined by the token its three marks share:
-- queued (submit on the owner to take on the worker), prepare (the worker's span that
-- starts at the take), returned (prepare's end to the owner receiving it) and total. In
-- microseconds, nearest-rank percentiles.
with marks as (
  select s.name, s.ts, a.int_value as token
  from slice s
  join args a on a.arg_set_id = s.arg_set_id and a.key = 'debug.value'
  where s.name in ('prepare.submit', 'prepare.take', 'prepare.receive')
),
hop as (
  select
    token,
    max(case when name = 'prepare.submit' then ts end) as submit,
    max(case when name = 'prepare.take' then ts end) as take,
    max(case when name = 'prepare.receive' then ts end) as receive
  from marks
  group by token
),
prepared as (
  select
    hop.*,
    (
      select p.ts + p.dur
      from slice p
      where p.name = 'display.prepare' and p.ts >= hop.take
      order by p.ts
      limit 1
    ) as done
  from hop
  where submit is not null and take is not null and receive is not null
),
stages as (
  select 'queued' as stage, 1 as stage_order, take - submit as dur from prepared
  union all
  select 'prepare', 2, done - take from prepared where done is not null
  union all
  select 'returned', 3, receive - done from prepared where done is not null
  union all
  select 'total', 4, receive - submit from prepared
),
ranked as (
  select
    stage,
    stage_order,
    dur,
    row_number() over (partition by stage order by dur) as rank,
    count(*) over (partition by stage) as n
  from stages
)
select
  stage,
  n as count,
  round(max(case when rank = (n * 50 + 99) / 100 then dur end) / 1e3, 1) as p50_us,
  round(max(case when rank = (n * 90 + 99) / 100 then dur end) / 1e3, 1) as p90_us,
  round(max(case when rank = (n * 99 + 99) / 100 then dur end) / 1e3, 1) as p99_us,
  round(max(dur) / 1e3, 1) as max_us
from ranked
group by stage
order by stage_order;
