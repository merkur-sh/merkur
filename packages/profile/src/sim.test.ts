import { describe, expect, test } from 'bun:test';
import { parseSimOptions, testExecutable } from './sim';

describe('profile:sim', () => {
  test('options are exact', () => {
    expect(parseSimOptions([])).toEqual({ rounds: 2_000, cpu: false, out: null });
    expect(parseSimOptions(['--rounds', '500', '--cpu'])).toEqual({
      rounds: 500,
      cpu: true,
      out: null,
    });
    expect(parseSimOptions(['--rounds', '0'])).toBeNull();
    expect(parseSimOptions(['--rounds', '1e3'])).toBeNull();
    expect(parseSimOptions(['--verbose'])).toBeNull();
  });

  test("the dataplane library's test binary is the one Cargo names", () => {
    const messages = [
      JSON.stringify({ reason: 'build-script-executed', package_id: 'x' }),
      JSON.stringify({
        reason: 'compiler-artifact',
        target: { name: 'merkur_dataplane', kind: ['lib'] },
        profile: { test: false },
        executable: null,
      }),
      JSON.stringify({
        reason: 'compiler-artifact',
        target: { name: 'merkur_dataplane', kind: ['lib'] },
        profile: { test: true },
        executable: '/target/rust/profiling/deps/merkur_dataplane-abc',
      }),
    ].join('\n');
    expect(testExecutable(messages)).toBe('/target/rust/profiling/deps/merkur_dataplane-abc');
    expect(testExecutable('not json')).toBeNull();
  });
});
