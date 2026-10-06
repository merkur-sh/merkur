import { startServer } from '../../apps/server/src/index';

const webDirectory = process.argv[2];
if (webDirectory === undefined) throw new Error('E2E server requires its prepared web artifact');
await startServer(webDirectory);
