import { describe, expect, test } from 'bun:test';

import { PATH_BLOCK_MARKER, parseSetupArguments, pathBlockFor } from './setup';

describe('merkur setup arguments', () => {
  test('takes the three fetched files and nothing else when not linking', () => {
    expect(parseSetupArguments(['a.tar.gz', 'm.json', 'm.sig'])).toEqual({
      artifactPath: 'a.tar.gz',
      manifestPath: 'm.json',
      signaturePath: 'm.sig',
      linkArguments: null,
    });
  });

  test('passes everything after --link to merkur link, origin first', () => {
    expect(
      parseSetupArguments([
        'a.tar.gz',
        'm.json',
        'm.sig',
        '--link',
        'https://merkur.test',
        '--identity-backend',
        'software',
      ])?.linkArguments,
    ).toEqual(['https://merkur.test', '--identity-backend', 'software']);
  });

  test('refuses missing files, a bare --link, and unknown trailing arguments', () => {
    expect(parseSetupArguments(['a.tar.gz', 'm.json'])).toBeNull();
    expect(parseSetupArguments(['a.tar.gz', 'm.json', 'm.sig', '--link'])).toBeNull();
    expect(parseSetupArguments(['a.tar.gz', 'm.json', 'm.sig', '--force'])).toBeNull();
  });
});

describe('PATH startup block', () => {
  const home = '/home/ada';
  const bin = '/home/ada/.merkur/bin';

  test('appends one marked export to the file an interactive zsh reads', () => {
    const block = pathBlockFor(home, bin, '/bin/zsh', 'linux');
    expect(block.file).toBe('/home/ada/.zshrc');
    expect(block.ownsFile).toBe(false);
    expect(block.block).toBe(
      `\n${PATH_BLOCK_MARKER}\nexport PATH='/home/ada/.merkur/bin':"$PATH"\n`,
    );
  });

  test('uses .bash_profile on macOS, where Terminal starts login shells', () => {
    expect(pathBlockFor(home, bin, '/bin/bash', 'darwin').file).toBe('/home/ada/.bash_profile');
    expect(pathBlockFor(home, bin, '/usr/bin/bash', 'linux').file).toBe('/home/ada/.bashrc');
  });

  test('gives fish a conf.d file of its own', () => {
    const block = pathBlockFor(home, bin, '/opt/homebrew/bin/fish', 'darwin');
    expect(block.file).toBe('/home/ada/.config/fish/conf.d/merkur.fish');
    expect(block.ownsFile).toBe(true);
    expect(block.block).toContain("fish_add_path --path --move '/home/ada/.merkur/bin'");
  });

  test('falls to .profile for any other shell', () => {
    expect(pathBlockFor(home, bin, '/bin/dash', 'linux').file).toBe('/home/ada/.profile');
    expect(pathBlockFor(home, bin, '', 'linux').file).toBe('/home/ada/.profile');
  });

  test('quotes a home directory the shell would otherwise split', () => {
    const block = pathBlockFor("/home/o'neil", "/home/o'neil/.merkur/bin", '/bin/zsh', 'linux');
    expect(block.block).toContain(`export PATH='/home/o'\\''neil/.merkur/bin':"$PATH"`);
  });
});
