import path from 'node:path';

/** Canonical relative File names shared by compiler materialization and attribution. */
export function portablePath(value: string, problem: string): string {
  if (
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error(problem);
  return value;
}
