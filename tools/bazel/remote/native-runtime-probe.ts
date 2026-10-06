if (
  process.platform !== 'linux' ||
  !['x64', 'arm64'].includes(process.arch) ||
  Bun.version !== '1.4.2'
)
  process.exit(1);
process.stdout.write(
  `${JSON.stringify({ platform: process.platform, arch: process.arch, bun: Bun.version })}\n`,
);
