import { verificationMain } from './cli';

process.exitCode = await verificationMain(['--unit', ...process.argv.slice(2)]);
