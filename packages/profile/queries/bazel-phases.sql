-- A Bazel command's phases, in seconds, from its own profile (`command.profile.gz`): the last
-- phase, "Complete build", has no end marker.
select
  name as phase,
  round((lead(ts) over (order by ts) - ts) / 1e9, 2) as seconds
from slice
where category = 'build phase marker'
order by ts;
