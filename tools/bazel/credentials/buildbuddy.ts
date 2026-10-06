import { readFile } from 'node:fs/promises';
import path from 'node:path';

const hosts = new Set(['remote.buildbuddy.io', 'app.buildbuddy.io']);

/** Credentials enter the RPC transport through Bazel's helper protocol, never its flags. */
export function credentialHost(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('uri' in input))
    throw new Error('Credential request has no URI');
  if (typeof input.uri !== 'string') throw new Error('Credential URI must be a string');
  const uri = new URL(input.uri);
  if (
    !hosts.has(uri.hostname) ||
    !['https:', 'grpcs:'].includes(uri.protocol) ||
    uri.username !== '' ||
    uri.password !== '' ||
    (uri.port !== '' && uri.port !== '443')
  )
    throw new Error('Credential request is outside the configured BuildBuddy deployment');
  return uri.hostname;
}

/** Only the literal credential binding is read; other Bazel options are never evaluated. */
export function buildBuddyCredential(contents: string): string {
  let credential: string | undefined;
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!line.includes('x-buildbuddy-api-key')) continue;
    const match =
      /^(?:common|build)\s+--remote_header=x-buildbuddy-api-key=([A-Za-z0-9+/=_-]+)(?:\s+#.*)?$/.exec(
        line,
      );
    if (match?.[1] === undefined || credential !== undefined)
      throw new Error('BuildBuddy credential binding is missing or ambiguous');
    credential = match[1];
  }
  if (credential === undefined) throw new Error('BuildBuddy credential binding is missing');
  return credential;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'get')
      throw new Error('Expected the credential-helper get operation');
    credentialHost(JSON.parse(await Bun.stdin.text()));
    const file = process.env.MERKUR_BUILDBUDDY_AUTH_FILE;
    if (file === undefined || !path.isAbsolute(file))
      throw new Error('Explicit absolute BuildBuddy credential File required');
    const credential = buildBuddyCredential(await readFile(file, 'utf8'));
    process.stdout.write(JSON.stringify({ headers: { 'x-buildbuddy-api-key': [credential] } }));
  } catch {
    process.stderr.write('BuildBuddy credential helper rejected the request\n');
    process.exitCode = 1;
  }
}
