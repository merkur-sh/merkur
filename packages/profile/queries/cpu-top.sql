-- Self time by thread and function across the whole capture, in on-CPU samples.
select t.tid as thread, t.name as thread_name, f.name as function, count(*) as samples
from perf_sample ps
join thread t using (utid)
join stack_profile_callsite c on c.id = ps.callsite_id
join stack_profile_frame f on f.id = c.frame_id
group by t.tid, f.name
order by samples desc
limit {{limit}};
