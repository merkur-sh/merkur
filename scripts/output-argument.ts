import path from 'node:path';

/** The one absolute output path a release build script takes, as `usage` names it. */
export function outputArgument(usage: string, argv = process.argv.slice(2)): string {
  const [output, ...rest] = argv;
  if (output === undefined || rest.length > 0 || !path.isAbsolute(output))
    throw new Error(`usage: ${usage}`);
  return output;
}
