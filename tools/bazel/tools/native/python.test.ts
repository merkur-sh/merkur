import { expect, test } from 'bun:test';

test('the declared native Python executes its bundled stdlib and TLS dependencies', () => {
  const child = Bun.spawnSync(
    [
      'python3',
      '-I',
      '-c',
      'import json,ssl,pathlib,subprocess,platform,sys; print(json.dumps({"version":platform.python_version(),"machine":platform.machine(),"openssl":ssl.OPENSSL_VERSION,"prefix":sys.prefix,"module":str(pathlib.Path(json.__file__).resolve())}))',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(child.exitCode).toBe(0);
  const fact: unknown = JSON.parse(new TextDecoder().decode(child.stdout));
  if (fact === null || typeof fact !== 'object') throw new Error('Malformed native Python receipt');
  const parsed = fact as Record<string, unknown>;
  expect(parsed.version).toBe('3.14.7');
  const machine =
    process.arch === 'arm64' ? (process.platform === 'darwin' ? 'arm64' : 'aarch64') : 'x86_64';
  expect(parsed.machine).toBe(machine);
  expect(typeof parsed.openssl).toBe('string');
  expect(typeof parsed.prefix).toBe('string');
  expect(typeof parsed.module).toBe('string');
});

test('the declared Python performs real JSON, filesystem and child-process work', () => {
  const script =
    'import json,pathlib,subprocess,sys,tempfile; p=pathlib.Path(tempfile.mkdtemp())/"result.json"; p.write_text(json.dumps({"fixture":7})); assert json.loads(p.read_text())["fixture"]==7; child=subprocess.run([sys.executable,"-I","-c","raise SystemExit(13)"]); assert child.returncode==13';
  const child = Bun.spawnSync(['python3', '-I', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode).toBe(0);
});
