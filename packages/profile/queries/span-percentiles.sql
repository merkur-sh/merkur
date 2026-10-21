-- Duration percentiles of every span name, by total time spent, in microseconds.
-- Nearest rank: the p-th percentile is the ceil(p * n)-th shortest span.
with ranked as (
  select
    name,
    dur,
    row_number() over (partition by name order by dur) as rank,
    count(*) over (partition by name) as n
  from slice
  where dur > 0
)
select
  name,
  n as count,
  round(sum(dur) / 1e3, 1) as total_us,
  round(max(case when rank = (n * 50 + 99) / 100 then dur end) / 1e3, 1) as p50_us,
  round(max(case when rank = (n * 90 + 99) / 100 then dur end) / 1e3, 1) as p90_us,
  round(max(case when rank = (n * 99 + 99) / 100 then dur end) / 1e3, 1) as p99_us,
  round(max(dur) / 1e3, 1) as max_us
from ranked
group by name
order by sum(dur) desc;
