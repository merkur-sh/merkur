import { Worker } from 'node:worker_threads';

export function lockDaemonConfigDescriptor(descriptor: number, operation: 2 | 6): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./daemon-config-lock-worker.ts', import.meta.url), {
      workerData: { descriptor, operation },
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Config lock worker exited ${code}`));
    });
  });
}
