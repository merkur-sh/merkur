import type { ImageAnimation, ImageQuad, ImageScene, TileDemand } from '../graphics/scene';

const decoder = new TextDecoder();
const EMPTY_SCENE: ImageScene = Object.freeze({ tiles: [], quads: [], animations: [] });

/** Decode the core's already selected scene into WebGPU resource descriptors. */
export function createClientViewerSceneReader(
  memory: WebAssembly.Memory,
): (pointer: number, length: number, quadsRevision: number) => ImageScene {
  let previousRevision = -1;
  let previousQuads: ImageQuad[] = [];
  return (pointer, length, quadsRevision): ImageScene => {
    if (length === 0) return EMPTY_SCENE;
    const bytes = new Uint8Array(memory.buffer, pointer, length);
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    const word = (): number => {
      const value = data.getUint32(at, true);
      at += 4;
      return value;
    };
    const number = (): number => {
      const value = data.getFloat64(at, true);
      at += 8;
      return value;
    };
    const string = (): string => {
      const size = word();
      const value = decoder.decode(bytes.subarray(at, at + size));
      at += size;
      return value;
    };
    const quadCount = word();
    const tileCount = word();
    const animationCount = word();
    const reuseQuads = previousRevision === quadsRevision;
    const quads: ImageQuad[] = reuseQuads ? previousQuads : [];
    const tiles: TileDemand[] = [];
    const animations: ImageAnimation[] = [];
    for (let index = 0; index < quadCount; index++) {
      const layer = data.getUint8(at);
      at += 4;
      const left = number(),
        top = number(),
        right = number(),
        bottom = number();
      const u = number(),
        v = number(),
        uw = number(),
        vh = number();
      if (reuseQuads) {
        const size = word();
        at += size;
      } else quads.push({ key: string(), layer, left, top, right, bottom, u, v, uw, vh });
    }
    for (let index = 0; index < tileCount; index++) {
      const asset = data.getUint8(at);
      const level = data.getUint8(at + 1);
      at += 4;
      const frame = word(),
        x = word(),
        y = word(),
        width = word(),
        height = word();
      const authority = bytes.slice(at, at + 32);
      at += 32;
      const source = bytes.slice(at, at + 32);
      at += 32;
      const key = string();
      if (asset !== 0) throw new Error('renderer scene contains a manifest demand');
      tiles.push({ asset: 'tile', level, frame, x, y, width, height, authority, source, key });
    }
    for (let index = 0; index < animationCount; index++) {
      const key = string();
      const count = word();
      const reserve = data.getUint8(at) !== 0;
      at += 4;
      const bindings = new Map<string, string>();
      for (let binding = 0; binding < count; binding++) bindings.set(string(), string());
      animations.push({ key, reserve, bindings });
    }
    if (at !== length) throw new Error('renderer scene export has trailing bytes');
    previousRevision = quadsRevision;
    previousQuads = quads;
    return { tiles, quads, animations };
  };
}
