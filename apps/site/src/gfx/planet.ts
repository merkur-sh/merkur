/**
 * The planet Mercury in terminal characters: a lit, cratered sphere with a
 * ring of satellites, on a grid of cells, turning slowly and by drag.
 *
 * What each cell shows is decided here, on the worker's own thread, a few
 * thousand cells a frame. Putting it on screen is one draw: a small texture
 * holds each cell's glyph and colour, and the shader looks the glyph up in an
 * atlas the page drew once in the terminal's face.
 */
import type { PlanetInit } from './protocol';
import type { Renderer } from './worker';

/** The atlas's glyphs in order; the page draws the same string (`client.ts`). */
export const PLANET_GLYPHS = ' .,:;-=+*#%@01<>/\\';
const RAMP = ' .,:;-=+*#%@';
const NOISE = '01<>/+*#%';
/** The seven tones a cell can take, darkest first, then the accent and its tint. */
const TONES = [0x3a3a46, 0x686871, 0x9899a1, 0xcdd6f4, 0xf8f8fc, 0x7f5af0, 0xcba6f7] as const;
const EMPTY = 255;

const VERTEX_SHADER = `#version 300 es
in vec2 p;
void main(){ gl_Position = vec4(p,0,1); }`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D atlas; uniform highp usampler2D cells;
uniform vec2 res; uniform vec2 cell; uniform vec2 origin; uniform float glyphs; uniform vec3 tones[7];
void main(){
  vec2 at = (vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) - origin) / cell;
  ivec2 id = ivec2(floor(at)); ivec2 grid = textureSize(cells, 0);
  if (id.x < 0 || id.y < 0 || id.x >= grid.x || id.y >= grid.y) { outColor = vec4(0.0); return; }
  uvec2 c = texelFetch(cells, id, 0).rg;
  if (c.g > 6u) { outColor = vec4(0.0); return; }
  vec2 f = fract(at);
  float a = texture(atlas, vec2((float(c.r) + f.x) / glyphs, f.y)).a;
  outColor = vec4(tones[c.g] * a, a);
}`;

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/** The design's Lehmer generator, so the craters are the design's craters. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/** Forty-six craters: a direction on the unit sphere and an angular size. */
function craters(): readonly (readonly [number, number, number, number])[] {
  const random = seeded(11);
  // The design drew 216 jitter vectors from the same stream first; skip them.
  for (let skipped = 0; skipped < 216 * 4; skipped += 1) random();
  return Array.from({ length: 46 }, () => {
    const u = random() * 2 - 1;
    const a = random() * 6.2832;
    const q = Math.sqrt(1 - u * u);
    return [q * Math.cos(a), u, q * Math.sin(a), 0.05 + random() ** 2.4 * 0.34] as const;
  });
}

const CRATERS = craters();

/** The surface's brightness at a point on the sphere: mottling, crater floors and rims. */
function surface(x: number, y: number, z: number): number {
  let albedo =
    0.8 +
    0.09 * Math.sin(x * 4.1 + z * 2.3) * Math.cos(y * 3.7 - x * 1.3) +
    0.05 * Math.sin(z * 9.1 + y * 7.3);
  for (const [cx, cy, cz, size] of CRATERS) {
    const r2 = size * size;
    const d2 = 2 - 2 * (x * cx + y * cy + z * cz);
    if (d2 > r2 * 1.7) continue;
    const d = Math.sqrt(d2 / r2);
    if (d < 1) albedo -= 0.3 * (1 - d * d);
    albedo += 0.26 * Math.exp(-(d - 1) * (d - 1) * 50);
  }
  return albedo;
}

const LIGHT = (() => {
  const length = Math.hypot(-0.55, 0.5, 0.67);
  return [-0.55 / length, 0.5 / length, 0.67 / length] as const;
})();
/** The satellites' ring: its radius in planet radii, and the roll it is drawn at. */
const RING_REACH = 1.5;
const RING_ROLL_COS = Math.cos(-0.22);
const RING_ROLL_SIN = Math.sin(-0.22);

/** The tone a lit point of the surface takes, darkest first. */
const toneOf = (value: number): number =>
  value < 0.14 ? 0 : value < 0.32 ? 1 : value < 0.55 ? 2 : value < 0.78 ? 3 : 4;

const REST_TILT = 0.22;
const REST_SPIN = 0.16;
const INTRO_MS = 1900;

export interface PlanetRenderer extends Renderer {
  setVisible(on: boolean): void;
  drag(phase: 'start' | 'move' | 'end', dx: number, dy: number): void;
  turn(by: number): void;
  /** The canvas's new size in device pixels and the grid measured for it. */
  fit(width: number, height: number, next: PlanetInit | null): void;
}

export function createPlanetRenderer(
  canvas: OffscreenCanvas,
  init: PlanetInit,
  drawn: () => void,
): PlanetRenderer {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
  });
  if (gl === null) throw new Error('site: the planet has no WebGL2 context');
  const compile = (type: number, text: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error('site: no shader');
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      throw new Error(`site: a shader does not compile: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  if (program === null) throw new Error('site: no program');
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.bindAttribLocation(program, 0, 'p');
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new Error(`site: a program does not link: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(program, name);
  const uRes = uniform('res');
  const uCell = uniform('cell');
  const uOrigin = uniform('origin');
  gl.uniform1f(uniform('glyphs'), PLANET_GLYPHS.length);
  gl.uniform3fv(
    uniform('tones'),
    TONES.flatMap((tone) => [(tone >> 16) / 255, ((tone >> 8) & 255) / 255, (tone & 255) / 255]),
  );
  gl.uniform1i(uniform('atlas'), 0);
  gl.uniform1i(uniform('cells'), 1);
  gl.clearColor(0, 0, 0, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const atlasTexture = gl.createTexture();

  // The grid, in CSS pixels as the design lays it out. All of it follows the
  // canvas's box, so `lay` sets it again whenever the page reports a new one.
  let cols = 0;
  let rows = 0;
  let left = 0;
  let top = 0;
  let radius = 0;
  let centreX = 0;
  let centreY = 0;
  let cellWidth = 0;
  let cellHeight = 0;
  /** Each cell's glyph and tone, row by row. */
  let cells = new Uint8Array(0);
  /** When each cell appears as the planet resolves out of noise, as a share of the intro. */
  let arrival = new Float32Array(0);
  let cellTexture: WebGLTexture | null = null;

  const lay = (next: PlanetInit): void => {
    const { width, height, scale } = next;
    cellWidth = next.cellWidth;
    cellHeight = next.cellHeight;
    cols = Math.floor(width / cellWidth);
    rows = Math.floor(height / cellHeight);
    left = (width - cols * cellWidth) / 2;
    top = (height - rows * cellHeight) / 2;
    radius = Math.min(width, height) * 0.31;
    centreX = width / 2;
    centreY = height / 2;
    cells = new Uint8Array(cols * rows * 2);
    arrival = Float32Array.from({ length: cols * rows }, () => Math.random());

    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform2f(uCell, cellWidth * scale, cellHeight * scale);
    gl.uniform2f(uOrigin, left * scale, top * scale);
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, next.atlas);
    next.atlas.close();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // The cells' storage is fixed at its size, so a new grid takes a new texture.
    gl.activeTexture(gl.TEXTURE1);
    gl.deleteTexture(cellTexture);
    cellTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, cellTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG8UI, cols, rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  };
  lay(init);

  const glyphOf = new Map([...PLANET_GLYPHS].map((glyph, index) => [glyph, index]));
  const rampGlyphs = [...RAMP].map((glyph) => glyphOf.get(glyph) ?? 0);
  const noiseGlyphs = [...NOISE].map((glyph) => glyphOf.get(glyph) ?? 0);

  const put = (i: number, j: number, glyph: string, tone: number): void => {
    if (i < 0 || j < 0 || i >= cols || j >= rows) return;
    const at = (j * cols + i) * 2;
    cells[at] = glyphOf.get(glyph) ?? 0;
    cells[at + 1] = tone;
  };

  let yaw = 0;
  /** The extra turn the page's scroll position gives it. */
  let scrolled = 0;
  let tilt = REST_TILT;
  let spin = 0;
  let nod = 0;
  let phase = 0;
  let intro = 0;
  let introStarted = 0;
  let previous = 0;
  let dragging = false;
  let lastDrag = 0;
  let visible = false;
  let announced = false;

  const cellOf = (x: number, y: number): readonly [number, number] => [
    Math.floor((centreX + x * radius - left) / cellWidth),
    Math.floor((centreY - y * radius - top) / cellHeight),
  ];

  /**
   * The satellites' ring, tipped a little more as the planet is tilted. Its far
   * half goes down before the globe and its near half after, so the globe hides
   * what is behind it.
   */
  const ring = (front: boolean): void => {
    const lean = 0.3 + (tilt - REST_TILT) * 0.4;
    const ce = Math.cos(lean);
    const se = Math.sin(lean);
    const project = (angle: number): readonly [number, number, number] => {
      const x = Math.cos(angle) * RING_REACH;
      const z = Math.sin(angle) * RING_REACH;
      const y = -z * se;
      return [x * RING_ROLL_COS - y * RING_ROLL_SIN, x * RING_ROLL_SIN + y * RING_ROLL_COS, z * ce];
    };
    const hidden = (p: readonly [number, number, number]): boolean =>
      p[2] > 0 !== front || (!front && p[0] * p[0] + p[1] * p[1] < 1);
    const samples = Math.ceil(((RING_REACH * radius * 6.2832) / cellWidth) * 1.3);
    for (let k = 0; k < samples; k += 1) {
      const angle = (k / samples) * 6.2832;
      const p = project(angle);
      if (hidden(p)) continue;
      const tx0 = -Math.sin(angle);
      const ty0 = -Math.cos(angle) * se;
      const tx = tx0 * RING_ROLL_COS - ty0 * RING_ROLL_SIN;
      const ty = tx0 * RING_ROLL_SIN + ty0 * RING_ROLL_COS;
      const slope = -ty / (Math.abs(tx) < 1e-6 ? 1e-6 : tx);
      const [i, j] = cellOf(p[0], p[1]);
      put(i, j, Math.abs(slope) < 0.32 ? '-' : slope < 0 ? '/' : '\\', front ? 2 : 0);
    }
    for (let k = 0; k < 3; k += 1) {
      const p = project(phase + k * 2.0944);
      if (hidden(p)) continue;
      const [i, j] = cellOf(p[0], p[1]);
      put(i, j, '@', 6);
    }
  };

  // The turn the planet is shown at: the rotation its surface is sampled through.
  let m0 = 1;
  let m2 = 0;
  let m3 = 0;
  let m4 = 1;
  let m5 = 0;
  let m6 = 0;
  let m7 = 0;
  let m8 = 1;
  const aim = (): void => {
    const cy = Math.cos(yaw + scrolled);
    const sy = Math.sin(yaw + scrolled);
    const cx = Math.cos(tilt);
    const sx = Math.sin(tilt);
    m0 = cy;
    m2 = sy;
    m3 = sx * sy;
    m4 = cx;
    m5 = -sx * cy;
    m6 = -cx * sy;
    m7 = sx;
    m8 = cx * cy;
  };

  /** One cell of the globe, at a point on the unit sphere facing the reader. */
  const shade = (at: number, x: number, y: number, z: number): void => {
    const lit = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);
    const rim = (1 - z) ** 3;
    if (rim > 0.2 && lit < 0.22) {
      cells[at] = glyphOf.get(rim > 0.5 ? ':' : '.') ?? 0;
      cells[at + 1] = 5;
      return;
    }
    const value =
      lit * surface(m0 * x + m3 * y + m6 * z, m4 * y + m7 * z, m2 * x + m5 * y + m8 * z) + 0.035;
    cells[at] = rampGlyphs[clamp(Math.round(value * (RAMP.length - 1)), 0, RAMP.length - 1)] ?? 0;
    cells[at + 1] = toneOf(value);
  };

  const globe = (): void => {
    for (let j = 0; j < rows; j += 1) {
      const y = (centreY - (top + (j + 0.5) * cellHeight)) / radius;
      if (y * y >= 1) continue;
      for (let i = 0; i < cols; i += 1) {
        const x = (left + (i + 0.5) * cellWidth - centreX) / radius;
        const rr = x * x + y * y;
        if (rr < 1) shade((j * cols + i) * 2, x, y, Math.sqrt(1 - rr));
      }
    }
  };

  /** While the planet resolves out of noise, a cell not yet due is empty or a flicker of it. */
  const resolve = (): void => {
    for (let q = 0; q < cols * rows; q += 1) {
      if (cells[q * 2 + 1] === EMPTY) continue;
      const due = arrival[q] ?? 0;
      if (due > intro + 0.18) {
        cells[q * 2 + 1] = EMPTY;
      } else if (due > intro) {
        cells[q * 2] = noiseGlyphs[Math.floor(due * 997) % noiseGlyphs.length] ?? 0;
        cells[q * 2 + 1] = 5;
      }
    }
  };

  const compose = (): void => {
    for (let at = 0; at < cells.length; at += 2) cells[at + 1] = EMPTY;
    aim();
    ring(false);
    globe();
    ring(true);
    if (intro < 1) resolve();
  };

  return {
    // A slow turn needs half the display's frames; a drag follows the hand.
    get minFrameMs() {
      return dragging ? 0 : 33;
    },
    wantsFrames: () => visible,
    setVisible(on) {
      visible = on;
      if (!on) previous = 0;
    },
    drag(phaseOfDrag, dx, dy) {
      const now = performance.now();
      if (phaseOfDrag === 'start') {
        dragging = true;
      } else if (phaseOfDrag === 'move') {
        const seconds = Math.max(8, now - lastDrag) / 1000;
        yaw += dx * 0.009;
        tilt = clamp(tilt + dy * 0.006, -1.1, 1.1);
        spin = clamp((dx * 0.009) / seconds, -8, 8);
        nod = clamp((dy * 0.006) / seconds, -4, 4);
      } else {
        dragging = false;
      }
      lastDrag = now;
    },
    turn(by) {
      scrolled = by;
    },
    fit(width, height, next) {
      if (next === null) throw new Error('site: the planet was resized without its grid');
      canvas.width = width;
      canvas.height = height;
      lay(next);
    },
    draw(now) {
      const seconds = previous === 0 ? 0.016 : Math.min(0.05, (now - previous) / 1000);
      previous = now;
      if (introStarted === 0) introStarted = now;
      const share = Math.min(1, (now - introStarted) / INTRO_MS);
      intro = 1 - (1 - share) ** 5;
      if (!dragging) {
        spin += (REST_SPIN - spin) * Math.min(1, seconds * 1.6);
        yaw += spin * seconds;
        nod *= 0.05 ** seconds;
        tilt = clamp(
          tilt + nod * seconds + (REST_TILT - tilt) * Math.min(1, seconds * 0.9),
          -1.1,
          1.1,
        );
      }
      phase += seconds * 0.45;
      compose();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RG_INTEGER, gl.UNSIGNED_BYTE, cells);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!announced) {
        announced = true;
        drawn();
      }
    },
  };
}
