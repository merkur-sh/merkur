-- The actions on a Bazel command's critical path, longest first, in milliseconds: the chain no
-- amount of parallelism shortens.
select s.name as step, round(s.dur / 1e6, 1) as ms
from slice s
join thread_track tt on s.track_id = tt.id
join thread t using (utid)
where t.name = 'Critical Path'
order by s.dur desc
limit {{limit}};
