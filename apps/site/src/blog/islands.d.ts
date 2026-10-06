/** `blogPages()` writes this module: every figure a built post has, by `<slug>/<name>`. */
declare module 'virtual:blog-islands' {
  import type { Component } from 'solid-js';

  export const islands: Readonly<Record<string, () => Promise<{ default: Component }>>>;
}
