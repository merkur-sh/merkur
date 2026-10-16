import { open } from 'node:fs/promises';

/**
 * The offline release-signing seed. The file is opened once, so the file whose type, size and mode
 * are checked is the file whose bytes are read.
 */
export async function readReleaseSigningSeed(seedFile: string): Promise<Buffer> {
  const handle = await open(seedFile, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== 32) {
      throw new Error('release signing seed file must be exactly 32 raw bytes');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error('release signing seed file must not be accessible by group or other users');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
