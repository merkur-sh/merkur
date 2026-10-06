import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { verificationArguments } from '../verification/cli';

interface EditorDefinition {
  readonly tasks: readonly {
    readonly label: string;
    readonly type: string;
    readonly command: string;
    readonly options: { readonly cwd: string };
    readonly args: readonly string[];
    readonly detail: string;
  }[];
  readonly inputs: readonly {
    readonly id: string;
    readonly type: string;
    readonly description: string;
  }[];
}

function unsignedEditorTask() {
  const definition: EditorDefinition = JSON.parse(
    readFileSync('.vscode/tasks.bazel.json.in', 'utf8'),
  );
  const tasks = definition.tasks.filter(
    (task) => task.label === 'Bazel: unsigned package verification (inactive integration)',
  );
  if (tasks.length !== 1 || tasks[0] === undefined)
    throw new Error('Expected the one inactive unsigned editor task');
  const task = tasks[0];
  const inputs = new Map(definition.inputs.map((input) => [input.id, `/declared/${input.id}`]));
  const args = task.args.slice(10).map((value) => {
    if (!value.startsWith('${input:')) return value;
    const original = inputs.get(value.slice(8, -1));
    if (original === undefined) throw new Error('Editor references an absent declared input');
    return original;
  });
  return { task, inputs: definition.inputs, args };
}

test('the unsigned editor entrypoint reaches the complete four-platform controller artifact consumer', () => {
  const { task, inputs, args } = unsignedEditorTask();
  expect(task.type).toBe('process');
  expect(task.command).toBe(`\${env:MERKUR_VERIFICATION_BAZEL}`);
  expect(task.options.cwd).toBe(`\${workspaceFolder}`);
  expect(task.args.slice(0, 10)).toEqual([
    '--ignore_all_rc_files',
    '--host_jvm_args=-XX:+ExitOnOutOfMemoryError',
    'run',
    '--incompatible_strict_action_env',
    '--guard_against_concurrent_changes',
    '--remote_verify_downloads',
    '--remote_download_outputs=all',
    '--symlink_prefix=/',
    '//tools:verify',
    '--',
  ]);
  const selected = verificationArguments(args);
  expect(selected.all).toBe(true);
  expect(selected.force).toBe(true);
  expect(selected.unsigned).toBe(true);
  expect(selected.nativePlatforms).toBe(true);
  expect(selected.executorPolicyFile).toBe('/declared/merkurVerificationExecutorPolicy');
  expect(selected.unsignedOutputDirectory).toBe('/declared/merkurVerificationUnsignedOutput');
  expect(selected.ledgerClient).toBe('/declared/merkurVerificationLedger');
  expect(selected.credentialFile).toBe('/declared/merkurVerificationCredential');
  expect(selected.reportFile).toBe('/declared/merkurVerificationReport');
  expect(selected.ciReportFile).toBe('/declared/merkurVerificationCiReport');
  expect(selected.expectedContextFile).toBe('/declared/merkurVerificationExpectation');
  expect(task.detail).toContain('Inactive until qualification');
  expect(task.detail).toContain('all ten original unsigned shipping artifacts');
  expect(task.detail).toContain('Missing producer or executor authority refuses admission');
  expect(task.detail).toContain('does not authorize signing');
  const input = inputs.find((input) => input.id === 'merkurVerificationUnsignedOutput');
  expect(input?.type).toBe('promptString');
  expect(input?.description).toContain('Fresh absolute');
  expect(input?.description).toContain('outside the repository');
});

test('the editor unsigned request cannot omit or relativize its controller-owned output', () => {
  const { args } = unsignedEditorTask();
  const index = args.indexOf('--unsigned-output-directory');
  if (index < 0) throw new Error('Expected the controller artifact output argument');
  expect(() => verificationArguments([...args.slice(0, index), ...args.slice(index + 2)])).toThrow(
    'Unsigned producer binding requires --all, --ci-report-file and --unsigned-output-directory',
  );
  const relative = [...args];
  relative[index + 1] = 'relative-output';
  expect(() => verificationArguments(relative)).toThrow(
    'Admission and report paths must be absolute',
  );
});

test('the complete unsigned editor batch requires an explicit absolute executor policy', () => {
  const { args, inputs } = unsignedEditorTask();
  const index = args.indexOf('--executor-policy-file');
  if (index < 0) throw new Error('Missing editor executor policy');
  expect(() => verificationArguments([...args.slice(0, index), ...args.slice(index + 2)])).toThrow(
    'The complete native platform batch requires --all and --executor-policy-file',
  );
  expect(() =>
    verificationArguments([
      ...args.slice(0, index + 1),
      'relative-policy',
      ...args.slice(index + 2),
    ]),
  ).toThrow('Admission and report paths must be absolute');
  const native = args.indexOf('--native-platforms');
  if (native < 0) throw new Error('Missing editor complete native batch');
  expect(() =>
    verificationArguments([...args.slice(0, native), ...args.slice(native + 1)]),
  ).toThrow('Executor policy requires the complete native platform batch');
  const policy = inputs.find((input) => input.id === 'merkurVerificationExecutorPolicy');
  expect(policy?.type).toBe('promptString');
  expect(policy?.description).toContain('all four native platforms');
  expect(policy?.description).toContain('require qualification');
});
