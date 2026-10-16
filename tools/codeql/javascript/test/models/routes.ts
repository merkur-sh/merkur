import { file } from 'bun';
import { Elysia } from 'elysia';
import { CompiledQuery, sql } from 'kysely';

new Elysia({ name: 'fixture' })
  .group('/files', (files) =>
    files
      .get('/:name', ({ params }) => Bun.file(params.name)) // $ Alert[js/path-injection]
      .get('/raw/:name', ({ params }) => file(params.name)) // $ Alert[js/path-injection]
      .get('/static', () => Bun.file('index.html')),
  )
  .get('/search', ({ query }) => sql.raw(query.text)) // $ Alert[js/sql-injection]
  .get('/bound', ({ query }) => sql`select * from users where name = ${query.text}`)
  .derive(({ request }) => {
    const header = request.headers.get('x-statement'); // $ Source[js/sql-injection]
    return { statement: CompiledQuery.raw(header) }; // $ Alert[js/sql-injection]
  })
  .ws('/socket', {
    message(_socket, message) { // $ Source[js/path-injection]
      Bun.write(message, ''); // $ Alert[js/path-injection]
    },
  });
