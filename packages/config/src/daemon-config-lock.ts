import { Worker } from 'node:worker_threads';

export class FileLockBusyError extends Error {
  constructor() {
    super('Another daemon link or file transaction is already in progress');
  }
}

export function lockFileDescriptor(descriptor: number, operation: 2 | 6): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./daemon-config-lock-worker.ts', import.meta.url), {
      workerData: { descriptor, operation },
    });
    worker.once('message', () => reject(new FileLockBusyError()));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`File lock worker exited ${code}`));
    });
  });
}
