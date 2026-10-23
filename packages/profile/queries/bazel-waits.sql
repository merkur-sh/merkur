-- How long a Bazel command's actions waited for the CPUs and memory they reserve, longest first,
-- in milliseconds: time a busy machine, `--jobs` or `--local_test_jobs` held each back.
select
  replace(name, 'Acquiring resources for: ', '') as action,
  round(dur / 1e6, 1) as waited_ms
from slice
where category = 'action resource lock'
order by dur desc
limit {{limit}};
