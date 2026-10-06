import { realpathSync } from 'node:fs';
import path from 'node:path';
import { openReadOnlyDirectory } from '../bun/owned-files';
import { readDeclaredInput } from '../verification/artifacts';
import type { ControllerResult } from '../verification/controller';
import type { VerificationExpectation } from '../verification/front-end';
import type { VerificationReport } from '../verification/report';
import { sanitizeBuildEvents } from '../verification/sanitize';
import { type ExpectedCiVerification, reconstructCiVerification } from './ci-evidence';
import { captureControllerCiExpectations, reconstructPreparedCiBatch } from './ci-preparation';

/** Constructed in the controller process; serialized copies retain diagnostics only. */
export interface ControllerCiReport {
  readonly admitted: true;
  readonly expectations: readonly VerificationExpectation[];
  readonly reports: readonly VerificationReport[];
}

/** Reuse the one admitted controller batch and its current selected nonce authority. */
export function reconstructControllerCiReport(result: ControllerResult): ControllerCiReport {
  const confirmed = captureControllerCiExpectations(result);
  if (result.admitted !== true || result.problems.length !== 0)
    throw new Error('CI report requires a complete admitted controller result');
  const reports = reconstructPreparedCiBatch(confirmed, result.results);
  return Object.freeze({ admitted: true, expectations: confirmed.expectations, reports });
}

async function read(file: string | undefined): Promise<string> {
  if (file === undefined || !path.isAbsolute(file))
    throw new Error('CI evidence inputs must be explicit absolute paths');
  return (await readDeclaredInput(path.dirname(file), path.basename(file))).bytes.toString();
}

/** Partial failure evidence is retained, while this error forbids complete retention. */
export class IncompleteTestRetention extends Error {
  constructor(readonly document: string) {
    super('Native test-output retention is incomplete or contains foreign output paths');
  }
}

/** File commands retain diagnostics; only the owned controller API constructs a CI report. */
export async function ciAdmissionMain(args: readonly string[]): Promise<string> {
  if (args[0] === 'sanitize-bep' && args.length === 2)
    return sanitizeBuildEvents(await read(args[1]));
  if (args[0] === 'retain-tests' && args.length >= 3) {
    const logs = args[1];
    if (logs === undefined || !path.isAbsolute(logs))
      throw new Error('Absolute engine-materialized test log root required');
    const labels = args.slice(2);
    if (
      new Set(labels).size !== labels.length ||
      !labels.every((label) => /^\/\/[A-Za-z0-9_./-]+:[A-Za-z0-9_.-]+$/.test(label)) ||
      labels.some((label) =>
        label
          .slice(2)
          .split(/[/:]/)
          .some((part) => part === '' || part === '.' || part === '..'),
      )
    )
      throw new Error('Exact unique main-workspace test label inventory required');
    const capability = openReadOnlyDirectory(realpathSync(logs));
    const files = [];
    const missing = [];
    try {
      for (const label of labels) {
        const relative = label.slice(2).replace(':', '/');
        for (const name of ['test.log', 'test.xml']) {
          try {
            // The namespace root is the only canonicalized carrier; descendants use held FDs.
            const captured = capability.read(`${relative}/${name}`);
            files.push({
              label,
              name,
              sha256: captured.sha256,
              size: captured.size,
              base64: captured.bytes.toString('base64'),
            });
          } catch {
            missing.push({ label, name, problem: 'Unavailable or foreign regular output' });
          }
        }
      }
      for (let index = files.length - 1; index >= 0; index--) {
        const file = files[index];
        if (file === undefined) throw new Error('Missing captured output identity');
        try {
          capability.verify(`${file.label.slice(2).replace(':', '/')}/${file.name}`);
        } catch {
          missing.push({
            label: file.label,
            name: file.name,
            problem: 'Output changed during capture',
          });
          files.splice(index, 1);
        }
      }
      // Retention alone does not attest engine origin, configured inventory or a verdict.
      const document = `${JSON.stringify(
        {
          kind: 'native-test-output-retention',
          complete: missing.length === 0,
          labels,
          files,
          missing,
        },
        null,
        2,
      )}\n`;
      if (missing.length !== 0) throw new IncompleteTestRetention(document);
      return document;
    } finally {
      capability.close();
    }
  }
  if (args[0] !== 'reconstruct' || args.length !== 3)
    throw new Error(
      'Usage: ci_admit sanitize-bep ABS_BEP | retain-tests ABS_LOG_ROOT LABEL... | reconstruct ABS_REPORT ABS_EXPECTED_CONTEXT',
    );
  const result: unknown = JSON.parse(await read(args[1]));
  const batch: unknown = JSON.parse(await read(args[2]));
  if (!Array.isArray(batch) || batch.length !== 1)
    throw new Error(
      'This report consumer requires one canonical captured expectation batch member',
    );
  const expected: unknown = batch[0];
  // The constructor validates the complete runtime shape; the cast admits no fields itself.
  const verdict = reconstructCiVerification(result, expected as ExpectedCiVerification);
  return `${JSON.stringify(verdict, null, 2)}\n`;
}

if (import.meta.main) {
  try {
    process.stdout.write(await ciAdmissionMain(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof IncompleteTestRetention)) throw error;
    process.stdout.write(error.document);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
