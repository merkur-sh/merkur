/** Linux NAT-lab process placement. Ordinary E2E fixtures execute unchanged. */
export function nativeNetworkCommand(
  role: 'daemon' | 'client',
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const name =
    environment[role === 'daemon' ? 'MERKUR_E2E_DAEMON_NETNS' : 'MERKUR_E2E_CLIENT_NETNS'];
  if (name === undefined) return { executable, args: [...args] };
  if (platform !== 'linux' || !/^merkur-natlab-[a-z0-9-]+$/u.test(name)) {
    throw new Error('native network namespace must name an isolated Linux NAT-lab namespace');
  }
  return { executable: 'ip', args: ['netns', 'exec', name, executable, ...args] };
}
