-- Where a Bazel command's threads spent their time, by the profile's event category, in seconds
-- summed over threads: analysis is "skyframe evaluator" and "Starlark …", a fetch "Fetching
-- repository", execution "action processing".
select category, count(*) as events, round(sum(dur) / 1e9, 1) as seconds
from slice
group by category
order by seconds desc
limit {{limit}};
