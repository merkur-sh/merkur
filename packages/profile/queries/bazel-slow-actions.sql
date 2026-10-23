-- A Bazel command's slowest actions, in milliseconds, with when each started from the command's
-- first event: a test's action includes its run.
select
  name as action,
  round((ts - (select min(ts) from slice)) / 1e9, 1) as at_s,
  round(dur / 1e6, 1) as ms
from slice
where category = 'action processing'
order by dur desc
limit {{limit}};
