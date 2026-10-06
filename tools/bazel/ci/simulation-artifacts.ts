/** Copy only reported simulator diagnostics for CI upload; this never admits a result. */
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { openOwnedDirectory, openReadOnlyDirectory } from '../bun/owned-files';
import { readDeclaredInput } from '../verification/artifacts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function absolute(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    safeText(value) &&
    path.normalize(value) === value
  );
}

function relative(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    safeText(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function child(root: string, file: string): string {
  const member = path.relative(root, file);
  if (!relative(member))
    throw new Error('Simulation diagnostics escape the owned temporary namespace');
  return member;
}

function reportedFiles(
  value: unknown,
  temporaryRoot: string,
): { source: string; destination: string }[] {
  if (
    !record(value) ||
    !absolute(value.evidenceDirectory) ||
    !Array.isArray(value.simulationDiagnostics)
  )
    throw new Error('Controller report has no exact simulation diagnostics inventory');
  const evidenceMember = child(temporaryRoot, value.evidenceDirectory);
  const evidenceDirectory = value.evidenceDirectory;
  const roots = new Set<string>();
  const selected: { source: string; destination: string }[] = [];
  for (const row of value.simulationDiagnostics) {
    if (
      !record(row) ||
      Object.keys(row).sort().join(',') !== 'files,problems,root' ||
      !absolute(row.root) ||
      !Array.isArray(row.files) ||
      !row.files.every(relative) ||
      new Set(row.files).size !== row.files.length ||
      !Array.isArray(row.problems) ||
      !row.problems.every((problem) => typeof problem === 'string') ||
      roots.has(row.root)
    )
      throw new Error('Controller simulation diagnostics are malformed or duplicated');
    const rootMember = child(evidenceDirectory, row.root);
    if (
      rootMember.includes('/') ||
      ![
        'simulation-host',
        'simulation-darwin-arm64',
        'simulation-darwin-x86_64',
        'simulation-linux-arm64',
        'simulation-linux-x86_64',
      ].includes(rootMember)
    )
      throw new Error('Simulation diagnostics require their original controller-owned root');
    roots.add(row.root);
    for (const file of row.files)
      selected.push({
        source: `${evidenceMember}/${rootMember}/${file}`,
        destination: `${rootMember}/${file}`,
      });
  }
  return selected;
}

function physicalOutputRoot(requested: string): string {
  if (!absolute(requested)) throw new Error('Explicit absolute CI upload destination required');
  const outputRoot = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  if (!absolute(outputRoot)) throw new Error('Physical CI upload namespace is unsafe');
  return outputRoot;
}

/** The report selects diagnostic Files only, including blocked/cancelled runs. */
export async function stageSimulationArtifacts(options: {
  readonly reportFile: string;
  readonly temporaryRoot: string;
  readonly outputRoot: string;
}): Promise<readonly string[]> {
  if (![options.reportFile, options.temporaryRoot, options.outputRoot].every(absolute))
    throw new Error('Simulation artifact retention requires explicit absolute paths');
  const outputRoot = physicalOutputRoot(options.outputRoot);
  const temporaryRoot = realpathSync(options.temporaryRoot);
  if (temporaryRoot !== options.temporaryRoot)
    throw new Error('Simulation temporary root must be the owned physical directory');
  const temporaryIdentity = lstatSync(temporaryRoot);
  if (!temporaryIdentity.isDirectory()) throw new Error('Owned temporary directory is absent');
  const current = () => {
    const actual = lstatSync(temporaryRoot);
    if (
      !actual.isDirectory() ||
      actual.dev !== temporaryIdentity.dev ||
      actual.ino !== temporaryIdentity.ino ||
      realpathSync(temporaryRoot) !== temporaryRoot
    )
      throw new Error('Owned temporary directory changed');
  };
  const reportParent = path.dirname(options.reportFile);
  const reportMember = path.basename(options.reportFile);
  const report = openReadOnlyDirectory(reportParent);
  let inputs: ReturnType<typeof openReadOnlyDirectory> | undefined;
  let output: ReturnType<typeof openOwnedDirectory> | undefined;
  try {
    inputs = openReadOnlyDirectory(temporaryRoot);
    const heldReport = report.read(reportMember);
    const capturedReport = await readDeclaredInput(reportParent, reportMember);
    if (heldReport.sha256 !== capturedReport.artifact.digest)
      throw new Error('Controller diagnostic report changed');
    const value: unknown = JSON.parse(capturedReport.bytes.toString());
    const selected = reportedFiles(value, temporaryRoot);
    const inTemporary = path.relative(temporaryRoot, outputRoot);
    if (inTemporary === '' || (inTemporary !== '..' && !inTemporary.startsWith(`..${path.sep}`)))
      throw new Error('CI upload staging must survive owned temporary storage cleanup');
    mkdirSync(outputRoot, { mode: 0o700 });
    output = openOwnedDirectory(outputRoot);
    const files: string[] = [];
    for (const member of selected) {
      current();
      report.verify(reportMember);
      const held = inputs.read(member.source);
      const captured = await readDeclaredInput(temporaryRoot, member.source);
      if (held.sha256 !== captured.artifact.digest)
        throw new Error('Reported simulation diagnostic File changed');
      inputs.verify(member.source);
      current();
      output.write(member.destination, captured.bytes, 0o600);
      output.sync(member.destination);
      files.push(path.join(outputRoot, member.destination));
    }
    for (const member of selected) inputs.verify(member.source);
    current();
    report.verify(reportMember);
    output.verifyCreated(outputRoot);
    if (realpathSync(outputRoot) !== outputRoot)
      throw new Error('Physical CI upload namespace changed');
    return Object.freeze(files);
  } catch (error) {
    try {
      output?.removeCreated();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Simulation artifact retention and cleanup failed',
      );
    }
    throw error;
  } finally {
    output?.close();
    inputs?.close();
    report.close();
  }
}

export async function simulationArtifactsMain(args: readonly string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      !['--report-file', '--temporary-root', '--output-directory'].includes(name) ||
      value === undefined ||
      values.has(name)
    )
      throw new Error(
        'Simulation artifact retention requires exact report, temporary and output paths',
      );
    values.set(name, value);
  }
  const reportFile = values.get('--report-file');
  const temporaryRoot = values.get('--temporary-root');
  const requestedOutputRoot = values.get('--output-directory');
  if (reportFile === undefined || temporaryRoot === undefined || requestedOutputRoot === undefined)
    throw new Error(
      'Simulation artifact retention requires exact report, temporary and output paths',
    );
  const outputRoot = physicalOutputRoot(requestedOutputRoot);
  const files = await stageSimulationArtifacts({ reportFile, temporaryRoot, outputRoot });
  // This fresh directory contains only the selected copies, with no additional inventory File.
  if (files.length !== 0) process.stdout.write(`${outputRoot}\n`);
}

if (import.meta.main) {
  try {
    await simulationArtifactsMain(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
