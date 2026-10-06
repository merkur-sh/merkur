/**
 * `bun build --compile` inlines a text import as a string constant, which is how
 * the generated notices reach the shipped binary. TypeScript needs the shape
 * declared; the import attribute picks the loader.
 */
declare module '*.txt' {
  const contents: string;
  export default contents;
}
