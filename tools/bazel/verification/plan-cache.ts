import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A configured plan is a pure function of the captured source, the Git facts, the test epochs
 * and the engine. One slot per question holds the last answer beside the digest of exactly
 * those inputs. Any other digest is a miss, and the engine's answer replaces the slot.
 */
export class PlanCache {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Plan cache requires an absolute directory');
  }

  private file(slot: string): string {
    return path.join(this.directory, `${createHash('sha256').update(slot).digest('hex')}.json`);
  }

  read(slot: string, key: string): unknown {
    let text: string;
    try {
      text = readFileSync(this.file(slot), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      // A torn write is no answer; the engine's answer replaces it.
      return undefined;
    }
    return typeof entry === 'object' &&
      entry !== null &&
      'key' in entry &&
      entry.key === key &&
      'value' in entry
      ? entry.value
      : undefined;
  }

  write(slot: string, key: string, value: unknown): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(slot);
    const staged = `${file}.${process.pid}.tmp`;
    writeFileSync(staged, JSON.stringify({ key, value }), { mode: 0o600 });
    renameSync(staged, file);
  }
}
