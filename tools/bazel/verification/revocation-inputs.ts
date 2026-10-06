import { createHash } from 'node:crypto';
import { OwnedDirectory } from '../bun/owned-files';
import { parseLedger, type TestReservation } from './revocation';

/** Complete analysis inventory, with one File per test; admission state never enters inputs. */
export function nonceRepositoryFiles(reservation: TestReservation): ReadonlyMap<string, string> {
  const ledger = parseLedger(reservation.snapshot.ledger);
  const files = new Map<string, string>([['REPO.bazel', '']]);
  const entries: Record<string, string> = {};
  if (
    new Set(reservation.labels).size !== reservation.labels.length ||
    reservation.labels.length === 0
  )
    throw new Error('Nonce repository requires a nonempty unique selected test inventory');
  for (const label of reservation.labels)
    if (ledger[label] === undefined) throw new Error('Selected test lacks a reserved nonce');
  for (const label of Object.keys(ledger).sort()) {
    const epoch = ledger[label];
    if (epoch === undefined) throw new Error('Analysis inventory lacks a declared test epoch');
    const file = `nonce/${createHash('sha256').update(label).digest('hex')}.txt`;
    files.set(file, epoch.nonce + '\n');
    entries[file] = label;
  }
  files.set(
    'BUILD.bazel',
    [
      'load("@//tools/bazel/verification:test-nonce.bzl", "test_epochs")',
      'package(default_visibility = ["//visibility:public"])',
      `exports_files(${JSON.stringify(Object.keys(entries))})`,
      `test_epochs(name = "epochs", nonces = ${JSON.stringify(entries)})`,
      '',
    ].join('\n'),
  );
  return files;
}

/** Publish once into a private engine-owned directory, retaining capabilities throughout. */
export function publishNonceRepository(directory: string, reservation: TestReservation): void {
  const owned = new OwnedDirectory(directory);
  try {
    for (const [file, bytes] of nonceRepositoryFiles(reservation)) {
      owned.write(file, Buffer.from(bytes), 0o444);
      owned.verify(file);
    }
  } finally {
    owned.close();
  }
}
