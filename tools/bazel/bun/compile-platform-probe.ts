process.stdout.write(
  JSON.stringify({ platform: process.platform, arch: process.arch, bun: Bun.version }),
);
