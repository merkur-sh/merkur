import path from 'node:path';
import { resolveSidecarBinaryPath } from '@merkur/shared/node-sidecar';

export function resolveDataplaneBinaryPath(): string | null {
  return resolveSidecarBinaryPath({
    envKey: 'MERKUR_DATAPLANE_BIN',
    binaryName: process.platform === 'win32' ? 'merkur-dataplane.exe' : 'merkur-dataplane',
    moduleUrl: import.meta.url,
    appDirectory: 'daemon',
    rustTargetReleaseSubdirectory: path.join('target', 'rust', 'release'),
  });
}
