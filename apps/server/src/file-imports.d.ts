/**
 * An asset imported `with { type: 'file' }` is embedded by `bun build --compile`,
 * and at runtime the binding is the path to read it from. TypeScript needs the
 * shape declared; the import attribute picks the loader.
 */
declare module '*.png' {
  const path: string;
  export default path;
}
