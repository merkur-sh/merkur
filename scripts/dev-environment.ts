import '../packages/shared/src/e2e-wasm-bun';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigProvider, Effect, Redacted } from 'effect';
import {
  EnvironmentError,
  type EnvironmentRecord,
  resolveEnvironment,
} from '../packages/config/src/environment';
import { loadServerConfig } from '../packages/config/src/server-config';
import { serverEnvironment } from '../packages/config/src/server-environment';

export const developmentWebOrigin = 'http://127.0.0.1:3000';

export const loadDevelopmentEnvironment = Effect.fnUntraced(function* (
  envPath: string,
  overrides: EnvironmentRecord,
) {
  const contents = yield* Effect.tryPromise({
    try: () => readFile(envPath, 'utf8'),
    catch: () =>
      new EnvironmentError({ message: 'Cannot read apps/server/.env; run bun run setup' }),
  });
  const environment = yield* resolveEnvironment(contents, overrides);
  const config = yield* loadServerConfig.pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord(Redacted.value(environment.values), {
          preserveEmptyStrings: true,
        }),
      ),
    ),
  );
  return { ...environment, config };
});

/** Only operating-system and compiler inputs cross every child boundary. */
export function toolEnvironment(environment: EnvironmentRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'USER',
    'LOGNAME',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'NO_COLOR',
    'FORCE_COLOR',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'SDKROOT',
    'MACOSX_DEPLOYMENT_TARGET',
    'CC',
    'CXX',
    'AR',
    'CFLAGS',
    'CXXFLAGS',
    'LDFLAGS',
    'PKG_CONFIG_PATH',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ]) {
    const value = environment[key];
    if (value !== undefined) result[key] = value;
  }
  const executableDirectories = [path.dirname(process.execPath)];
  const rustup = result.PATH === undefined ? null : Bun.which('rustup', { PATH: result.PATH });
  if (rustup !== null) executableDirectories.push(path.dirname(rustup));
  if (result.PATH !== undefined) executableDirectories.push(result.PATH);
  result.PATH = executableDirectories.join(path.delimiter);
  return result;
}

export function serverProcessEnvironment(
  platform: EnvironmentRecord,
  settings: EnvironmentRecord,
): Record<string, string> {
  const result = toolEnvironment(platform);
  for (const key of Object.keys(serverEnvironment)) {
    const value = settings[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Wildcard bind addresses are not destinations; URL performs IPv6 authority encoding. */
export function developmentServerOrigin(host: string, port: number): string {
  const dialHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const authority =
    dialHost.includes(':') && !dialHost.startsWith('[') ? `[${dialHost}]` : dialHost;
  return new URL(`http://${authority}:${port}`).origin;
}
