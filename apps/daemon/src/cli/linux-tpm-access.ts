import { open } from 'node:fs/promises';
import { Effect } from 'effect';
import type { Logger } from '../logger';

/** One link-time repair, scoped to this OS account and the resource-manager device. */
export const repairTpmAccessEffect = Effect.fnUntraced(function* (logger: Logger) {
  if (process.platform !== 'linux') return false;
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const tty = await open('/dev/tty', 'r+');
      await tty.close();
      const sudo = Bun.which('sudo');
      const uid = process.getuid?.();
      if (sudo === null || uid === undefined || !Number.isSafeInteger(uid) || uid < 0) return false;
      const rule = `KERNEL=="tpmrm[0-9]*", MODE="0660", OWNER="${uid}"`;
      const script = `umask 022
mkdir -p /etc/udev/rules.d
printf '%s\n' '${rule}' > /etc/udev/rules.d/70-merkur-tpm.rules
udevadm control --reload-rules
udevadm trigger --action=change --sysname-match='tpmrm*'
udevadm settle`;
      logger.info('daemon_link_tpm_access_repair', {
        command: [sudo, '/bin/sh', '-eu', '-c', script],
      });
      const child = Bun.spawn([sudo, '/bin/sh', '-eu', '-c', script], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        signal,
      });
      return (await child.exited) === 0;
    },
    catch: () => false,
  }).pipe(Effect.catch(() => Effect.succeed(false)));
});
