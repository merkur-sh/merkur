-- The slowest spans named {{span}}, each with its thread, its start in milliseconds from the
-- trace's first span, and the time of each child span inside it.
select
  s.id,
  t.tid as thread,
  round((s.ts - (select min(ts) from slice)) / 1e6, 3) as at_ms,
  round(s.dur / 1e3, 1) as dur_us,
  (
    select group_concat(c.name || ' ' || round(c.dur / 1e3, 1), ', ')
    from slice c
    where c.parent_id = s.id and c.dur > 0
  ) as children_us
from slice s
join thread_track tt on s.track_id = tt.id
join thread t using (utid)
where s.name = '{{span}}'
order by s.dur desc
limit {{limit}};
