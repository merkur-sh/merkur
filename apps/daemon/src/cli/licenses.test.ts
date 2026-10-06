import { describe, expect, test } from 'bun:test';

import { runLicensesCommand } from './licenses';

describe('licenses command', () => {
  const notices = runLicensesCommand();

  test('carries Merkur’s own license and the source it corresponds to', () => {
    expect(notices).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(notices).toContain('https://github.com/merkur-sh/merkur');
    expect(notices.endsWith('\n')).toBe(true);
  });

  test('attributes the dependencies compiled into the shipped executables', () => {
    // One vendored crate, one ordinary crate and the runtime: if the generator
    // ever stops walking the resolved graph, the component index goes empty
    // while every other gate stays green.
    expect(notices).toContain('alacritty_terminal');
    expect(notices).toContain('tokio');
    expect(notices).toContain('JavaScriptCore/WebKit');
    expect(notices).toContain('LICENSE TEXTS');
    expect(notices.length).toBeGreaterThan(100_000);
  });
});
