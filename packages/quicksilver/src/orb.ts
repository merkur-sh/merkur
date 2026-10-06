/**
 * The mark: a raymarched machined-metal sphere, reflecting a three-lobe
 * environment through a lathe-grooved surface, tone-mapped with ACES and
 * dithered so the gradient across it has no banding.
 *
 * One implementation for every surface that draws it. The app wraps it in
 * `MerkurOrb` (apps/web), which adds the route half of "on screen"; the legal
 * pages mount it from `apps/web/src/legal/orb.ts`. Both draw the same shader at
 * the same intensity from the same rest time, so the mark cannot drift between
 * them. No framework and no logger here: a surface that cannot draw reports
 * why, and its caller decides how to say so.
 */

/**
 * The shader time the orb is defined to be *at rest*.
 *
 * It is where the reduced-motion draw stops, where `.orb-rest` was captured,
 * where the PWA icons in `public/` were rendered, and where the animation
 * starts — one value, so the still and the animation's first frame are the same
 * image rather than two arbitrary points in the noise field. They were not, and
 * the orb visibly jerked as the splash handed over. Recapture the still
 * (`bun run scripts/capture-orb-still.ts`) and re-render the icons if this
 * value ever moves.
 */
export const ORB_REST_TIME = 1.2;

/**
 * The one intensity. Chosen against the whole ramp of them, and there is
 * deliberately no per-screen override: a mark that is subtly different on the
 * login screen than on the machine list is two marks.
 */
export const ORB_INTENSITY = 1.2;

/** `--a`, the accent, as linear components. */
export const ORB_ACCENT: readonly [number, number, number] = [0x7f / 255, 0x5a / 255, 0xf0 / 255];

/** Throttle. A logo does not need the full frame rate. */
export const ORB_FRAME_MS = 25;

/**
 * How many octaves of the displacement field survive at a given render width.
 *
 * An octave whose period lands under about two device pixels can only alias —
 * at 22px the fifth octave was pure noise crawling over the surface, which is
 * what made the small mark look like it was boiling while the large one looked
 * machined. Dropping those octaves and renormalising keeps TOTAL deformation
 * size-independent while the detail gets deliberately chunkier as the mark gets
 * smaller, which is exactly what a real object does at distance.
 */
export function octavesFor(renderPixels: number): number {
  return Math.max(2, Math.min(4, Math.floor(Math.log2(renderPixels)) - 3));
}

const VERTEX_SHADER = `#version 300 es
in vec2 p; out vec2 vUv;
void main(){ vUv = p*0.5+0.5; gl_Position = vec4(p,0,1); }`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform float uT;
uniform vec2  uRes;
uniform float uIntensity;
uniform vec3  uAccent;
uniform float uOct;

vec3 hash3(vec3 p){
  p = vec3(dot(p,vec3(127.1,311.7, 74.7)),
           dot(p,vec3(269.5,183.3,246.1)),
           dot(p,vec3(113.5,271.9,124.6)));
  return -1.0 + 2.0*fract(sin(p)*43758.5453123);
}
float noise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  return mix(mix(mix(dot(hash3(i+vec3(0,0,0)), f-vec3(0,0,0)),
                     dot(hash3(i+vec3(1,0,0)), f-vec3(1,0,0)), u.x),
                 mix(dot(hash3(i+vec3(0,1,0)), f-vec3(0,1,0)),
                     dot(hash3(i+vec3(1,1,0)), f-vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash3(i+vec3(0,0,1)), f-vec3(0,0,1)),
                     dot(hash3(i+vec3(1,0,1)), f-vec3(1,0,1)), u.x),
                 mix(dot(hash3(i+vec3(0,1,1)), f-vec3(0,1,1)),
                     dot(hash3(i+vec3(1,1,1)), f-vec3(1,1,1)), u.x), u.y), u.z);
}
// Octaves past the render's Nyquist limit are dropped and the sum renormalised,
// so the amplitude of the whole field is the same at 22px as at 192px.
float fbm(vec3 p, int oct){
  float v = 0.0, a = 0.5, norm = 0.0;
  for(int i=0;i<5;i++){
    if (i >= oct) break;
    v += a*noise(p); norm += a;
    p *= 2.03; a *= 0.5;
  }
  return v / max(norm, 1e-4) * 0.75;
}
float swell(vec3 p){
  return fbm(p*1.45 + vec3(0.0, uT*0.10, uT*0.045), int(uOct));
}
float map(vec3 p){ return length(p) - 1.0 + 0.13 * swell(p) * uIntensity; }
vec3 calcNormal(vec3 p){
  // The sampling epsilon follows the render resolution: a fixed one samples
  // detail the pixel grid cannot carry, which is the same aliasing the octave
  // clamp exists to remove.
  float e = max(0.0022, 2.6/uRes.x);
  vec2 h = vec2(1,-1)*0.5773;
  return normalize( h.xyy*map(p+h.xyy*e) + h.yyx*map(p+h.yyx*e) +
                    h.yxy*map(p+h.yxy*e) + h.xxx*map(p+h.xxx*e) );
}
// Fine circumferential grooves, as a normal perturbation rather than geometry.
vec3 lathe(vec3 n){
  vec3 t = normalize(cross(n, vec3(0.0,1.0,0.0)) + vec3(1e-4));
  vec3 b = cross(n, t);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float g = sin(lat*150.0) + 0.5*sin(lat*61.0);
  return normalize(n + b * g * 0.026);
}
// The environment the metal reflects: a graduated ground, a horizon band, a
// key light, a cool fill, and the accent from below.
vec3 env(vec3 r){
  float h = r.y*0.5 + 0.5;
  vec3 c = mix(vec3(0.085,0.086,0.105), vec3(0.30,0.30,0.37), pow(h, 1.35));
  c += vec3(0.62,0.62,0.70) * exp(-abs(r.y)*5.5);
  c += vec3(1.00,0.98,0.96) * pow(max(dot(r, normalize(vec3( 0.52, 0.66, 0.54))), 0.0), 26.0) * 2.2;
  c += vec3(0.36,0.36,0.62) * pow(max(dot(r, normalize(vec3(-0.72, 0.28, 0.38))), 0.0),  5.0) * 0.55;
  c += uAccent              * pow(max(dot(r, normalize(vec3( 0.10,-0.62,-0.68))), 0.0),  6.0) * 0.95;
  return c;
}
vec3 aces(vec3 x){
  return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
}

void main(){
  vec2 uv = (vUv*2.0 - 1.0);
  uv.x *= uRes.x/uRes.y;
  vec3 ro = vec3(0.0, 0.0, 3.2);
  vec3 rd = normalize(vec3(uv, -2.6));
  float a = uT*0.06;
  mat2 R2 = mat2(cos(a), -sin(a), sin(a), cos(a));
  ro.xz = R2*ro.xz; rd.xz = R2*rd.xz;

  // March only inside the bounding sphere the displacement can reach. Outside
  // it every step is wasted, and this is the whole cost of the mark.
  float bb = dot(ro, rd);
  float cc = dot(ro, ro) - 1.44;
  float hh = bb*bb - cc;
  vec3 col = vec3(0.0); float alpha = 0.0;
  if (hh > 0.0) {
    float t = max(-bb - sqrt(hh), 0.0);
    float tMax = t + 2.6;
    bool hit = false; vec3 p = ro;
    for (int i = 0; i < 56; i++) {
      p = ro + rd*t;
      float d = map(p);
      if (d < 0.0012) { hit = true; break; }
      if (t > tMax) break;
      t += d*0.92;
    }
    if (hit) {
      vec3 n = lathe(calcNormal(p));
      vec3 refl = reflect(rd, n);
      float ndv = max(dot(n, -rd), 0.0);
      vec3 F0 = vec3(0.70, 0.70, 0.76);
      vec3 F  = F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0);
      // Three taps across the groove direction stand in for a rough reflection;
      // one mirror tap made the grooves read as wire rather than as metal.
      vec3 tg = normalize(cross(n, vec3(0.0,1.0,0.0)) + vec3(1e-4));
      vec3 reflected = env(refl)*0.5
                     + env(normalize(refl + tg*0.13))*0.25
                     + env(normalize(refl - tg*0.13))*0.25;
      float disp = pow(1.0 - ndv, 3.0) * 0.05;
      reflected.r = mix(reflected.r, env(normalize(refl + n*disp)).r, 0.8);
      reflected.b = mix(reflected.b, env(normalize(refl - n*disp)).b, 0.8);
      float ao = clamp(1.0 - abs(swell(p)) * 1.9 * uIntensity, 0.45, 1.0);
      col = reflected * F * ao;
      col += uAccent * pow(1.0 - ndv, 4.0) * 0.20;
      alpha = 1.0;
    }
  }
  if (alpha < 0.5) {
    float r = length(uv);
    float g = exp(-r*r*4.2);
    col = uAccent * g * 0.13;
    alpha = g * 0.32;
  }
  col = aces(col);
  // Ordered-enough dither at one 8-bit step. Without it the ground behind the
  // sphere bands into visible rings on any panel.
  float dz = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453) - 0.5;
  col += dz / 255.0;
  outColor = vec4(col, alpha);
}`;

/** Why a canvas could not carry the orb. */
export type OrbFailure =
  | { readonly reason: 'webgl2-unavailable' }
  | { readonly reason: 'shader-compile-failed'; readonly log: string }
  | { readonly reason: 'program-build-failed' }
  | { readonly reason: 'program-link-failed'; readonly log: string }
  | { readonly reason: 'geometry-buffers-unavailable' };

/** A canvas set up to draw the orb at one size. */
export interface OrbSurface {
  /** Draws the frame at `shaderTime` seconds of the noise field. */
  readonly draw: (shaderTime: number) => void;
  /** Releases the WebGL context. */
  readonly destroy: () => void;
}

export type OrbSurfaceResult =
  | { readonly ok: true; readonly surface: OrbSurface }
  | { readonly ok: false; readonly failure: OrbFailure };

/**
 * Sizes `canvas` for `cssSize` CSS pixels at `devicePixelRatio` (capped at 2)
 * and builds the shader program with its constant uniforms. The canvas's CSS
 * box is the caller's: this sets only the backing store.
 */
export function createOrbSurface(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  cssSize: number,
  devicePixelRatio: number,
): OrbSurfaceResult {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(cssSize * dpr));
  canvas.height = Math.max(1, Math.round(cssSize * dpr));

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    powerPreference: 'low-power',
  });
  if (!gl) return { ok: false, failure: { reason: 'webgl2-unavailable' } };

  let compileFailure: OrbFailure | null = null;
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      compileFailure = { reason: 'shader-compile-failed', log: gl.getShaderInfoLog(shader) ?? '' };
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vertexShader = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (compileFailure !== null) return { ok: false, failure: compileFailure };
  const program = gl.createProgram();
  if (!vertexShader || !fragmentShader || !program) {
    return { ok: false, failure: { reason: 'program-build-failed' } };
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, 0, 'p');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return {
      ok: false,
      failure: { reason: 'program-link-failed', log: gl.getProgramInfoLog(program) ?? '' },
    };
  }
  gl.useProgram(program);

  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) return { ok: false, failure: { reason: 'geometry-buffers-unavailable' } };
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const uT = gl.getUniformLocation(program, 'uT');

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  // Constant uniforms only need to be set once.
  gl.uniform2f(gl.getUniformLocation(program, 'uRes'), canvas.width, canvas.height);
  gl.uniform1f(gl.getUniformLocation(program, 'uIntensity'), ORB_INTENSITY);
  gl.uniform1f(gl.getUniformLocation(program, 'uOct'), octavesFor(canvas.width));
  gl.uniform3f(
    gl.getUniformLocation(program, 'uAccent'),
    ORB_ACCENT[0],
    ORB_ACCENT[1],
    ORB_ACCENT[2],
  );

  return {
    ok: true,
    surface: {
      draw(shaderTime) {
        gl.uniform1f(uT, shaderTime);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      destroy() {
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      },
    },
  };
}

/** One animation-frame slot: arming replaces whatever was armed. */
export interface OrbFrameSlot {
  readonly arm: (callback: () => void) => void;
  readonly cancel: () => void;
}

/** The orb's clock, started and stopped by whatever decides it is on screen. */
export interface OrbAnimation {
  readonly setRunning: (running: boolean) => void;
  readonly stop: () => void;
}

/**
 * Draws the rest frame now, then animates from it while running, throttled to
 * `ORB_FRAME_MS`. The still is the frame at `ORB_REST_TIME`, so the animation
 * starts there rather than wherever the clock happens to be when the canvas
 * mounts. `now` is the caller's monotonic clock in milliseconds.
 */
export function createOrbAnimation(
  surface: OrbSurface,
  slot: OrbFrameSlot,
  now: () => number,
): OrbAnimation {
  const startTime = now();
  let lastFrame = startTime;
  let running = false;
  surface.draw(ORB_REST_TIME);

  const frame = (): void => {
    if (!running) return;
    const at = now();
    if (at - lastFrame < ORB_FRAME_MS) {
      slot.arm(frame);
      return;
    }
    lastFrame = at;
    surface.draw(ORB_REST_TIME + (at - startTime) / 1000);
    slot.arm(frame);
  };

  return {
    setRunning(next) {
      if (next === running) return;
      running = next;
      if (running) slot.arm(frame);
      else slot.cancel();
    },
    stop() {
      running = false;
      slot.cancel();
    },
  };
}
