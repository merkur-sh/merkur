import { setupTypebox } from 'elysia';
import exactMirror from 'exact-mirror';
import * as compile from 'typebox/compile';
import * as schema from 'typebox/schema';
import * as system from 'typebox/system';
import * as type from 'typebox/type';
import * as value from 'typebox/value';

// Elysia loads these through dynamic require by default. Static registration
// embeds them in the standalone executable, before any route constructs schemas.
setupTypebox({ exactMirror, typebox: { compile, schema, system, type, value } });
