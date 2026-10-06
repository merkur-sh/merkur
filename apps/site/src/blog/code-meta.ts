/**
 * The words after a fenced block's language: `file=<name>`, which the block's
 * header shows, and `mark=<line>`, the line the prose points at. Anything else
 * is a mistake, and stops the build.
 */
export function readCodeMeta(meta: string): { file: string; mark: number | null } {
  let file = '';
  let mark: number | null = null;
  for (const word of meta.split(/\s+/).filter((entry) => entry !== '')) {
    const [key, value = ''] = word.split('=');
    if (key === 'file' && value !== '') file = value;
    else if (key === 'mark' && /^\d+$/.test(value)) mark = Number(value);
    else
      throw new Error(`blog: a fenced block says "${word}"; it takes file=<name> and mark=<line>`);
  }
  if (file === '') throw new Error('blog: a fenced block names no file=<name>');
  return { file, mark };
}
