export interface CiPlan {
  readonly source: boolean;
  readonly native: boolean;
  readonly integration: boolean;
}

export function checkCiResults(plan: CiPlan, results: Record<string, { result: string }>): void {
  const expected = {
    plan: true,
    wasm: plan.source,
    source: true, // A prose-only change still runs check:docs.
    native: plan.native,
    'browser-native': plan.integration,
    integration: plan.integration,
    transport: plan.integration,
  };
  if (Object.keys(results).length !== Object.keys(expected).length) {
    throw new Error('CI result inventory does not match the required jobs');
  }
  for (const [job, selected] of Object.entries(expected)) {
    if (results[job]?.result !== (selected ? 'success' : 'skipped')) {
      throw new Error(`CI job ${job} must be ${selected ? 'successful' : 'intentionally skipped'}`);
    }
  }
}

if (import.meta.main) {
  const flag = (name: string): boolean => {
    const value = process.env[name];
    if (value !== 'true' && value !== 'false') throw new Error(`missing CI plan output ${name}`);
    return value === 'true';
  };
  checkCiResults(
    {
      source: flag('SOURCE'),
      native: flag('NATIVE'),
      integration: flag('INTEGRATION'),
    },
    JSON.parse(process.env.RESULTS ?? 'null'),
  );
}
