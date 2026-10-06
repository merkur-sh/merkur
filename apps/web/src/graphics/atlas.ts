interface Node {
  x: number;
  y: number;
  width: number;
  height: number;
  freeWidth: number;
  freeHeight: number;
  occupied: boolean;
  parent: Node | null;
  children: [Node, Node] | null;
}

export interface AtlasRegion {
  readonly x: number;
  readonly y: number;
  readonly layer: number;
  release(): void;
}

function node(x: number, y: number, width: number, height: number, parent: Node | null): Node {
  return {
    x,
    y,
    width,
    height,
    freeWidth: width,
    freeHeight: height,
    occupied: false,
    parent,
    children: null,
  };
}

function refresh(current: Node): void {
  let next: Node | null = current;
  while (next !== null) {
    const children: [Node, Node] | null = next.children;
    if (children === null) {
      next.freeWidth = next.occupied ? 0 : next.width;
      next.freeHeight = next.occupied ? 0 : next.height;
    } else {
      if (children.every((child) => child.children === null && !child.occupied)) {
        next.children = null;
        next.freeWidth = next.width;
        next.freeHeight = next.height;
      } else {
        next.freeWidth = Math.max(children[0].freeWidth, children[1].freeWidth);
        next.freeHeight = Math.max(children[0].freeHeight, children[1].freeHeight);
      }
    }
    next = next.parent;
  }
}

function claim(current: Node, width: number, height: number): Node | null {
  if (current.freeWidth < width || current.freeHeight < height) return null;
  if (current.children !== null)
    return claim(current.children[0], width, height) ?? claim(current.children[1], width, height);
  if (current.occupied) return null;
  if (current.width > width) {
    current.children = [
      node(current.x, current.y, width, current.height, current),
      node(current.x + width, current.y, current.width - width, current.height, current),
    ];
    return claim(current.children[0], width, height);
  }
  if (current.height > height) {
    current.children = [
      node(current.x, current.y, width, height, current),
      node(current.x, current.y + height, width, current.height - height, current),
    ];
    return claim(current.children[0], width, height);
  }
  current.occupied = true;
  refresh(current);
  return current;
}

/** Deterministic rectangle splitting with exact sibling coalescing. Small tiles
 * consume their actual guttered extent, rather than one whole 258-pixel layer.
 * A released region may be rewritten on the same queue after its previous draws;
 * its backing texture remains owned until every use has retired. */
export class GraphicsAtlas {
  private readonly roots: Node[];
  constructor(side: number, layers: number) {
    this.roots = Array.from({ length: layers }, () => node(0, 0, side, side, null));
  }

  allocate(width: number, height: number): AtlasRegion | null {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
      return null;
    for (const [layer, root] of this.roots.entries()) {
      const owned = claim(root, width, height);
      if (owned === null) continue;
      let active = true;
      return {
        x: owned.x,
        y: owned.y,
        layer,
        release() {
          if (!active) throw new Error('graphics atlas region released twice');
          active = false;
          owned.occupied = false;
          refresh(owned);
        },
      };
    }
    return null;
  }
}
