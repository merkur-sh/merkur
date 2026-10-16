import { $ } from 'bun';
import { Elysia } from 'elysia';

new Elysia().post('/run', { body: {} }, ({ body }) => { // $ Source
  Bun.spawn([body.program, '--help']); // $ Alert
  Bun.spawn(['git', 'log', body.revision]);
  Bun.spawnSync({ cmd: [body.program] }); // $ Alert
  $`git log ${body.revision}`;
  $`git log ${{ raw: body.revision }}`; // $ Alert
});
