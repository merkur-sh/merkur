import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateDaemonConfig } from '@merkur/config';
import { E2E_OPAQUE_PUBLIC_KEY } from '../../scripts/e2e-opaque-pin';
import { test as daemonTest, expect } from './fixtures/daemon-process';
import {
  finishClientFixture,
  floodAndSee,
  type HeadlessEvent,
  presentedScreen,
  typeAndObserve,
  withHeadlessClient,
} from './fixtures/headless-client';

// Compile the PTY driver outside the live-session deadline. Browser CI restores
// release executables, so the driver's separate test profile may be entirely cold.
const test = daemonTest.extend<{ interactiveClientBinary: string }>({
  interactiveClientBinary: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
    async ({}, use) => {
      const root = path.resolve(__dirname, '..', '..');
      const child = spawn(
        'cargo',
        [
          'test',
          '--locked',
          '-p',
          'merkur-tui',
          '--test',
          'interactive_live',
          '--no-run',
          '--message-format=json',
        ],
        {
          cwd: root,
          env: { ...process.env, RUSTUP_TOOLCHAIN: undefined },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const output: string[] = [],
        logs: string[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        expect(code, logs.join('')).toBe(0);
        let executable: string | undefined;
        for (const line of output.join('').split('\n').filter(Boolean)) {
          const artifact = JSON.parse(line) as {
            reason?: string;
            target?: { name?: string; kind?: string[] };
            executable?: string;
          };
          if (
            artifact.reason === 'compiler-artifact' &&
            artifact.target?.name === 'interactive_live' &&
            artifact.target.kind?.includes('test') &&
            typeof artifact.executable === 'string'
          ) {
            executable = artifact.executable;
          }
        }
        if (executable === undefined)
          throw new Error('Cargo produced no interactive PTY test executable');
        await use(executable);
      } finally {
        await finishClientFixture(child, 'interactive-client-build.log', logs.join(''));
      }
    },
    { timeout: 600_000 },
  ],
});

/**
 * The native client signs in with the password the browser registered, has
 * the root sign its own delegation, connects to the linked machine through the
 * edge, and types into its shell. The shell's side effect is the proof the
 * input arrived: nothing but an authenticated, opened input run can create
 * that file.
 *
 * Then its grid follows the machine's screen through a flood of output: the
 * daemon admits each state only against a display grant, so the marker at the
 * end reaches the grid only if the client's ACKs and grants keep flowing.
 */
test('the headless client signs in, connects, types, and its grid follows the screen', async ({
  linkedDaemon,
  baseURL,
}) => {
  await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
    await typeAndObserve(client.child, 'tui');
    await floodAndSee(client, `tui-display-${process.pid}`, 400);
  });
});

/** The browser signs the exact native delegation's revocation; the live
 * session must retire while stdin remains open, before fixture EOF teardown. */
test('revoking the native delegation ends its authenticated live session', async ({
  linkedDaemon,
  baseURL,
  page,
}) => {
  test.setTimeout(120_000);
  await withHeadlessClient(
    linkedDaemon,
    baseURL,
    async (client) => {
      await typeAndObserve(client.child, 'tui-before-revoke');
      const signedIn = client.events.find((event) => event.event === 'signed_in');
      const delegationId = signedIn?.delegation_id;
      if (typeof delegationId !== 'string' || delegationId.length === 0)
        throw new Error('native sign-in did not publish its delegation identity');

      // The existing UI loads a server clock and signs with the browser's live
      // delegation from its vault. No private native credential leaves the TUI.
      await page.keyboard.press('g');
      await page.keyboard.press('s');
      await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
      const nativeRow = page.locator(`[data-session-row="${delegationId}"]`);
      await expect(nativeRow).toBeVisible({ timeout: 15_000 });
      const revoked = page.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname === `/api/browser-sessions/${delegationId}`,
      );
      await nativeRow.getByRole('button', { name: /^Revoke / }).click();
      expect((await revoked).status()).toBe(200);
      await expect(nativeRow).toHaveCount(0);
      await client.next(
        (event) =>
          event.event === 'status' &&
          typeof event.status === 'string' &&
          event.status === 'Closed(AuthRejected)',
        30_000,
      );
      // Revocation itself terminates the actor. Sending EOF would also close a
      // healthy client and therefore cannot be used as the success signal.
      expect(client.child.stdin.writableEnded).toBe(false);
      // A terminal session failure is exit 1; normal stdin EOF is exit 0.
      await expect.poll(() => client.child.exitCode, { timeout: 10_000 }).toBe(1);
      expect(await client.exited).toBe(1);
      // Closing the native peer is independent of the WSS command. Its durable
      // acknowledgement must also complete without taking the daemon offline.
      await expect
        .poll(
          () => {
            const config = validateDaemonConfig(
              JSON.parse(
                readFileSync(path.join(linkedDaemon.daemonHome, '.merkur', 'config.json'), 'utf8'),
              ),
            );
            return config.revoked_delegations.map((target) => target.delegationId);
          },
          { timeout: 10_000 },
        )
        .toContain(delegationId);
    },
    1,
  );
  await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
    await typeAndObserve(client.child, 'tui-after-revoke');
  });
});

/**
 * Each typed key is shown to the client's speculative model before it leaves.
 * The prompt is opened as the latency spec opens it: the command's output
 * enables bracketed paste, after the Enter that ran it closed whatever boundary
 * the prompt held. The worker's shell is shared, so that may be none (the
 * fixture's bash opens none of its own) or one an earlier spec's `PS1` opens at
 * every prompt, under which the opening command is itself modelled. The typed
 * line is therefore counted from the prompt that follows that Enter.
 *
 * The prompt is ready once the client has numbered the Enter and is armed: the
 * Enter fenced the model until display covered it, and the daemon withdrew the
 * old grant before the Enter reached the shell, so an armed model after it
 * holds a grant the shell gave since. There the model takes the typed keys and
 * their echo confirms every one. The closing Enter waits for that echo: it
 * seals the line, and a hidden prediction still unanswered when the line is
 * sealed is dropped, never confirmed.
 */
test('the headless client predicts typed keys and the echo confirms them', async ({
  linkedDaemon,
  baseURL,
}) => {
  await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
    const report = async () =>
      (await presentedScreen(client)) as HeadlessEvent & {
        readonly input: { sent: number };
        readonly prediction: {
          armed: boolean;
          modelled: number;
          confirmed: number;
          mismatched: number;
          expired_covered: number;
        };
      };
    const opening = "printf '\\033[?2004h'\n";
    client.child.stdin.write(opening);
    await expect
      .poll(
        async () => {
          const { input, prediction } = await report();

          return input.sent === opening.length && prediction.armed;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const { prediction: before } = await report();

    const line = `echo tui-predicted-${process.pid}`;
    client.child.stdin.write(line);

    try {
      await expect
        .poll(async () => (await report()).prediction.confirmed - before.confirmed, {
          timeout: 15_000,
        })
        .toBe(line.length);
    } catch (error) {
      // What the client showed and counted, which the bare count cannot say.
      const screen = await presentedScreen(client);

      throw new Error(`the echo did not confirm the typed line: ${JSON.stringify(screen)}`, {
        cause: error,
      });
    }

    client.child.stdin.write('\n');
    const { prediction: settled } = await report();
    expect(settled.modelled - before.modelled, JSON.stringify(settled)).toBe(line.length);
    expect(settled.mismatched - before.mismatched, JSON.stringify(settled)).toBe(0);
    expect(settled.expired_covered - before.expired_covered, JSON.stringify(settled)).toBe(0);
  });
});

/**
 * An image the machine's shell prints reaches the client as verified tiles.
 * The client owns the terminal's size with its cell pixels, without which the
 * daemon places no image; the viewer names the tiles its scene shows, and the
 * session reads each from a finite stream and verifies it against the
 * placement's root before handing it over.
 */
test('the headless client fetches and verifies the tiles of an image the shell shows', async ({
  linkedDaemon,
  baseURL,
}) => {
  await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
    await client.next((event) => event.event === 'geometry' && event.status === 'Owner', 15_000);
    client.child.stdin.write(
      "printf '\\033_Ga=T,f=24,s=2,v=2,c=4,r=2;////////////////\\033\\\\'\n",
    );
    await client.next((event) => event.event === 'graphics_asset', 15_000);
    const asset = client.events.find((event) => event.event === 'graphics_asset');
    expect(asset?.asset, JSON.stringify(asset)).toBe('Tile');
    expect(asset?.bytes, JSON.stringify(asset)).toBeGreaterThan(57);
  });
});

/**
 * An animation the shell prints plays in the client. The daemon hands over the
 * timeline as a verified manifest; the client samples it on the daemon's clock,
 * which each heartbeat answer maps onto its own, and shows each frame once its
 * tiles are held. Two 100 ms frames loop, so the shown frame keeps changing.
 * `q=2` keeps the terminal's replies out of the shell's input.
 */
test('the headless client plays an animation on the daemon clock', async ({
  linkedDaemon,
  baseURL,
}) => {
  await withHeadlessClient(linkedDaemon, baseURL, async (client) => {
    await client.next((event) => event.event === 'geometry' && event.status === 'Owner', 15_000);
    const apc = (control: string, payload = '') => `\\033_G${control};${payload}\\033\\\\`;
    const commands = [
      apc('a=T,q=2,i=9,f=24,s=2,v=2,c=4,r=2', '////////////////'),
      apc('a=f,q=2,i=9,f=24,s=2,v=2,z=100', 'AAAAAAAAAAAAAAAA'),
      apc('a=a,q=2,i=9,r=1,z=100'),
      apc('a=a,q=2,i=9,s=3,v=1'),
    ];
    client.child.stdin.write(`printf '${commands.join('')}'\n`);
    await client.next(
      (event) => event.event === 'graphics_asset' && event.asset === 'Animation',
      15_000,
    );
    const shown = new Set<number>();
    await expect
      .poll(
        async () => {
          const frames = (await presentedScreen(client)).animation_frames;
          if (Array.isArray(frames)) for (const frame of frames) shown.add(Number(frame));
          return shown.size;
        },
        { timeout: 15_000, intervals: [40] },
      )
      .toBe(2);
  });
});

/** The real executable runs in a controlling PTY; alacritty interprets its
 * ANSI output independently and verifies flood, resize, chrome and cleanup. */
test('the interactive client signs in, follows output and resizes its machine', async ({
  interactiveClientBinary,
  linkedDaemon,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const root = path.resolve(__dirname, '..', '..');
  const current = path.join(root, 'target', 'rust', 'release', 'merkur-tui');
  const baseline = process.env.MERKUR_TUI_BENCHMARK_BASELINE;
  // Optional paired measurement uses the same authenticated fixture and driver.
  const binaries =
    baseline === undefined ? [current] : [baseline, current, baseline, current, baseline, current];
  for (const binary of binaries) {
    const child = spawn(
      interactiveClientBinary,
      ['--ignored', '--exact', 'authenticated_interactive_session', '--nocapture'],
      {
        cwd: root,
        env: {
          ...process.env,
          RUSTUP_TOOLCHAIN: undefined,
          MERKUR_TUI_TEST_BIN: binary,
          MERKUR_TUI_TEST_ORIGIN: new URL(baseURL ?? '').origin,
          MERKUR_TUI_TEST_PIN: E2E_OPAQUE_PUBLIC_KEY,
          MERKUR_TUI_TEST_USERNAME: linkedDaemon.username,
          MERKUR_TUI_TEST_MACHINE: linkedDaemon.daemonId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const logs: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    try {
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      child.stdin.end(`${linkedDaemon.password}\n`);
      expect(await exited, logs.join('')).toBe(0);
      for (const line of logs.join('').split('\n')) {
        if (
          !line.startsWith('{"benchmark":') &&
          !line.includes('"benchmark":"tui-authoritative-echo"')
        )
          continue;
        const report: unknown = JSON.parse(line);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        await test.info().attach('tui-authoritative-echo.json', {
          body: JSON.stringify(report),
          contentType: 'application/json',
        });
      }
    } finally {
      await finishClientFixture(child, 'interactive-client.log', logs.join(''));
    }
  }
});
