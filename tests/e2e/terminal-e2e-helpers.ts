import { expect, type Locator, type Page } from '@playwright/test';
import { expectConnected } from './app-state';

/**
 * Returns the shared shell to a known state before a test. The screen is part of
 * that state: a line printed over a row an earlier test drew keeps the rest of
 * that row, so an exact-line wait on it can never match.
 */
export const SHELL_RESET_COMMAND =
  'stty sane echo; for job in $(jobs -p); do kill "$job" 2>/dev/null; done; cd /; unset actual value bytes; printf "\\033[H\\033[2J"';

export async function connectTerminal(page: Page, daemonName: string): Promise<void> {
  await page.getByTitle(`Connect to ${daemonName}`).click();
  await expectConnected(page, 20_000);
  // The focused window claims its viewport through the normal focus event.
  await page.bringToFront();
}

export async function primeTerminal(page: Page, daemonName: string): Promise<Locator> {
  await connectTerminal(page, daemonName);
  await interruptForegroundCommand(page);
  await page.keyboard.type(`${SHELL_RESET_COMMAND}\n`);
  // The mirror's first read is a silent baseline, so output before it is never
  // announced. Once it has one, the ready line is announced after everything the
  // reset printed: the test starts on a mirror with nothing still owed.
  await waitForMirrorBaseline(page, 15_000);
  const ready = readyLine('__merkur_e2e_ready_');
  await page.keyboard.type(`${ready.command}\n`);
  await waitForTerminalLog(page, ready.marker, 'line', 15_000);
  return page.getByRole('log', { name: 'Terminal output' });
}

/**
 * A ready line no earlier test printed. The reset clears the screen, so priming
 * draws the same rows every time, and the mirror announces a row only when its
 * text differs from the last read: a fixed line on the row the previous test
 * left it on is never announced. The command prints the marker in two halves so
 * its own echo cannot match.
 */
function readyLine(prefix: string): { readonly command: string; readonly marker: string } {
  const nonce = Math.random().toString(36).slice(2, 8);
  return { command: `printf '%s%s\\n' ${prefix} ${nonce}__`, marker: `${prefix}${nonce}__` };
}

/**
 * Free the shell before resetting it.
 *
 * `SHELL_RESET_COMMAND` reaches `jobs -p`, which lists background jobs only, so
 * a shell parked in a *foreground* command cannot be reset by typing at it —
 * the reset queues in the tty behind whatever is running and every later
 * assertion reads echo instead of output. The daemon's shell outlives a single
 * test, so one spec parking the shell (to hold the screen still, say) silently
 * disarms the specs that follow it, including specs in other files, and no
 * later test can detect or recover from it.
 *
 * Interrupting here rather than at the end of the spec that parked the shell is
 * deliberate: a spec that fails partway never reaches its own cleanup, and this
 * runs before every test regardless of how the previous one ended. On an idle
 * prompt it costs one `^C` and a fresh prompt line. Ctrl+C reaches the PTY as
 * ETX — the copy binding is Ctrl+Shift+C.
 */
export async function interruptForegroundCommand(page: Page): Promise<void> {
  await page.keyboard.press('Control+c');
}

export async function expectOutput(
  output: Locator,
  marker: string,
  timeout = 15_000,
): Promise<void> {
  await waitForTerminalLog(output.page(), marker, 'text', timeout);
}

const TERMINAL_LOG = '[role="log"][aria-label="Terminal output"]';

/**
 * Resolves the moment the terminal's accessibility log shows `marker`: as one whole
 * line of an entry (`line`) or anywhere in its text (`text`). The log changes only
 * when the worker's output settles, so this waits on the log's own mutations. A
 * poll's back-off (100, 250, 500, then 1000 ms) lands most checks well after the
 * entry, and polling inside a measured window is page work the window would count.
 */
export async function waitForTerminalLog(
  page: Page,
  marker: string,
  match: 'line' | 'text',
  timeoutMs: number,
): Promise<void> {
  await waitForTerminalMirror(page, { kind: match, marker }, timeoutMs);
}

/** Resolves once the terminal's accessibility mirror holds its silent baseline. */
export async function waitForMirrorBaseline(page: Page, timeoutMs: number): Promise<void> {
  await waitForTerminalMirror(page, { kind: 'baseline' }, timeoutMs);
}

type MirrorCondition =
  | { readonly kind: 'baseline' }
  | { readonly kind: 'line' | 'text'; readonly marker: string };

async function waitForTerminalMirror(
  page: Page,
  condition: MirrorCondition,
  timeoutMs: number,
): Promise<void> {
  await page.evaluate(
    ({ selector, condition, timeoutMs }) =>
      new Promise<void>((resolve, reject) => {
        const met = (): boolean => {
          const log = document.querySelector(selector);
          if (log === null) return false;
          if (condition.kind === 'baseline') return log.hasAttribute('data-baseline');
          if (condition.kind === 'text') return (log.textContent ?? '').includes(condition.marker);
          for (const entry of log.querySelectorAll('div')) {
            for (const line of (entry.textContent ?? '').split(/\r?\n/)) {
              if (line.trimEnd() === condition.marker) return true;
            }
          }
          return false;
        };
        if (met()) {
          resolve();
          return;
        }
        const observer = new MutationObserver(() => {
          if (!met()) return;
          observer.disconnect();
          clearTimeout(timer);
          resolve();
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(
            new Error(`terminal mirror ${JSON.stringify(condition)} not met in ${timeoutMs} ms`),
          );
        }, timeoutMs);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['data-baseline'],
        });
      }),
    { selector: TERMINAL_LOG, condition, timeoutMs },
  );
}

export async function dispatchWindowPaste(page: Page, text: string): Promise<void> {
  await page.evaluate((payload) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', payload);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard }));
  }, text);
}

export async function enableTouchKeyboard(page: Page): Promise<Locator> {
  const surface = page.locator('textarea[data-terminal-hidden-input]');
  await expect(surface).toHaveCount(1);
  const toggle = page.getByRole('button', { name: /keyboard/i });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect.poll(() => terminalTouchInputActive(page)).toBe(true);
  return surface;
}

export async function primeTouchTerminal(page: Page, daemonName: string): Promise<Locator> {
  await connectTerminal(page, daemonName);
  await enableTouchKeyboard(page);
  await interruptForegroundCommand(page);
  await insertTouchText(page, SHELL_RESET_COMMAND);
  await sendTouchEnter(page);
  // As in `primeTerminal`: baseline first, then a ready line the mirror must announce.
  await waitForMirrorBaseline(page, 15_000);
  const ready = readyLine('__merkur_touch_ready_');
  await insertTouchText(page, ready.command);
  await sendTouchEnter(page);
  await waitForTerminalLog(page, ready.marker, 'line', 15_000);
  return page.getByRole('log', { name: 'Terminal output' });
}

export async function insertTouchText(page: Page, text: string): Promise<void> {
  await page.evaluate((payload) => {
    const surface = document.querySelector('textarea[data-terminal-hidden-input]');
    if (!(surface instanceof HTMLTextAreaElement)) throw new Error('editing surface missing');
    surface.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: payload,
        inputType: 'insertText',
      }),
    );
  }, text);
}

export async function sendTouchEnter(page: Page): Promise<void> {
  await dispatchTouchBeforeInput(page, 'insertLineBreak');
}

export async function dispatchTouchBeforeInput(page: Page, inputType: string): Promise<void> {
  await page.evaluate((type) => {
    const surface = document.querySelector('textarea[data-terminal-hidden-input]');
    if (!(surface instanceof HTMLTextAreaElement)) throw new Error('editing surface missing');
    surface.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: type }),
    );
  }, inputType);
}

export async function dispatchTouchPaste(page: Page, text: string): Promise<void> {
  await page.evaluate((payload) => {
    const surface = document.querySelector('textarea[data-terminal-hidden-input]');
    if (!(surface instanceof HTMLTextAreaElement)) throw new Error('editing surface missing');
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', payload);
    surface.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
  }, text);
}

export async function terminalTouchInputActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active?.hasAttribute('data-terminal-hidden-input')) return true;

    const keyboard = document.querySelector('[data-terminal-keyboard-shell]:not([hidden])');
    const terminal = document.querySelector('#terminal');
    return (
      keyboard !== null &&
      active instanceof Element &&
      (active === terminal || keyboard.contains(active))
    );
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function exactValueCommand(value: string, marker: string): string {
  const quoted = shellQuote(value);
  return `actual=${quoted}; [ "$actual" = ${quoted} ] && printf '${marker}\\n'\n`;
}
