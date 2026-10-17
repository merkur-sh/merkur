/**
 * Imported `with { type: 'file' }`, which `bun build --compile` embeds; at
 * runtime the binding is the path to read the image from. Declared beside the
 * file rather than as a `*.png` module so every project that reaches
 * `mail-message.ts` resolves it, not only the server's.
 */
declare const path: string;
export default path;
