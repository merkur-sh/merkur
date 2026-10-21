-- Where CPU went inside spans named {{span}} lasting at least {{threshold_us}} us: on-CPU
-- samples of the span's own thread inside its window, by the function at the top of the
-- stack (self time). One sample is one sampling interval (1 ms by default).
with slow as (
  select s.ts, s.dur, tt.utid
  from slice s
  join thread_track tt on s.track_id = tt.id
  where s.name = '{{span}}' and s.dur >= {{threshold_us}} * 1000
),
hits as (
  select ps.callsite_id
  from perf_sample ps
  join slow on ps.utid = slow.utid and ps.ts >= slow.ts and ps.ts < slow.ts + slow.dur
)
select f.name as function, count(*) as samples
from hits
join stack_profile_callsite c on c.id = hits.callsite_id
join stack_profile_frame f on f.id = c.frame_id
group by f.name
order by samples desc
limit {{limit}};
