/**
 * The Boxes section's picture: a 3 × 3 field of rounded boxes in the orb's
 * liquid-chrome material, raymarched, turning slowly and by drag.
 *
 * The surface is the design's signed-distance field; what is bounded is the
 * work of finding it. A ray far from every box needs neither the swell that
 * ripples a surface (three octaves of noise, and it can move a surface by at
 * most `SWELL_MAX`) nor all nine boxes (the nearest is always among the four
 * around the point), so the march takes those steps on a cheap lower bound
 * and pays for the full field only within reach of a surface.
 */
import { ORB_ACCENT } from '@merkur/quicksilver/orb';

import type { Renderer } from './worker';

const VERTEX_SHADER = `#version 300 es
in vec2 p; out vec2 vUv;
void main(){ vUv = p*0.5+0.5; gl_Position = vec4(p,0,1); }`;

export const BOXES_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform float uT; uniform vec2 uRes; uniform vec3 uAccent; uniform float uYaw; uniform float uPitch;
const int OCTAVES = 3;
const float SP = 1.08;
// The most the swell can move a surface, and how near a surface it is evaluated.
const float SWELL_MAX = 0.036;
const float SWELL_REACH = 0.05;
vec3 hash3(vec3 p){
  p = vec3(dot(p,vec3(127.1,311.7, 74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6)));
  return -1.0 + 2.0*fract(sin(p)*43758.5453123);
}
float noise(vec3 p){
  vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.0-2.0*f);
  return mix(mix(mix(dot(hash3(i+vec3(0,0,0)), f-vec3(0,0,0)), dot(hash3(i+vec3(1,0,0)), f-vec3(1,0,0)), u.x),
                 mix(dot(hash3(i+vec3(0,1,0)), f-vec3(0,1,0)), dot(hash3(i+vec3(1,1,0)), f-vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash3(i+vec3(0,0,1)), f-vec3(0,0,1)), dot(hash3(i+vec3(1,0,1)), f-vec3(1,0,1)), u.x),
                 mix(dot(hash3(i+vec3(0,1,1)), f-vec3(0,1,1)), dot(hash3(i+vec3(1,1,1)), f-vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p){
  float v = 0.0, a = 0.5, norm = 0.0;
  for(int i=0;i<OCTAVES;i++){ v += a*noise(p); norm += a; p *= 2.03; a *= 0.5; }
  return v / norm * 0.75;
}
float swell(vec3 p){ return fbm(p*1.45 + vec3(0.0, uT*0.10, uT*0.045)); }
float sdBox(vec3 p, vec3 b, float r){ vec3 q = abs(p) - b; return length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0) - r; }
float isCentre(vec2 id){ return step(abs(id.x) + abs(id.y), 0.5); }
vec3 boxC(vec2 id){ return vec3(id.x*SP, 0.06*sin(uT*1.05 + id.x*1.7 + id.y*2.3) + isCentre(id)*0.16, id.y*SP); }
float boxAt(vec3 p, vec2 id, float w){
  float c = isCentre(id);
  return sdBox(p - boxC(id), vec3(mix(0.36, 0.45, c)), 0.11) + w * mix(0.004, 0.05, c);
}
// The four boxes around the point: its own cell's and the neighbours on the side it leans to.
float field(vec3 p, float w){
  vec2 cell = p.xz/SP;
  vec2 id = clamp(floor(cell + 0.5), -1.0, 1.0);
  vec2 side = sign(cell - id);
  vec2 nx = clamp(id + vec2(side.x, 0.0), -1.0, 1.0);
  vec2 nz = clamp(id + vec2(0.0, side.y), -1.0, 1.0);
  vec2 nd = clamp(id + side, -1.0, 1.0);
  return min(min(boxAt(p, id, w), boxAt(p, nx, w)), min(boxAt(p, nz, w), boxAt(p, nd, w)));
}
float map(vec3 p){ return field(p, swell(p*1.9)); }
// How far the ray may step from p. Away from every surface the bare boxes are an exact
// distance, so the whole of it less the swell's reach is safe; near one, the rippled
// field is not, and the step is the design's cautious share of it. Negative on a hit.
float stride(vec3 p){
  float d = field(p, 0.0);
  if (d > SWELL_REACH) return d - SWELL_MAX;
  d = map(p);
  return d < 0.0015 ? -1.0 : d*0.7;
}
// noise() with its gradient: x is the same value, yzw its derivative in p.
vec4 noised(vec3 p){
  vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.0-2.0*f), du = 6.0*f*(1.0-f);
  vec3 ga = hash3(i+vec3(0,0,0)), gb = hash3(i+vec3(1,0,0)), gc = hash3(i+vec3(0,1,0)), gd = hash3(i+vec3(1,1,0));
  vec3 ge = hash3(i+vec3(0,0,1)), gf = hash3(i+vec3(1,0,1)), gg = hash3(i+vec3(0,1,1)), gh = hash3(i+vec3(1,1,1));
  float va = dot(ga, f-vec3(0,0,0)), vb = dot(gb, f-vec3(1,0,0)), vc = dot(gc, f-vec3(0,1,0)), vd = dot(gd, f-vec3(1,1,0));
  float ve = dot(ge, f-vec3(0,0,1)), vf = dot(gf, f-vec3(1,0,1)), vg = dot(gg, f-vec3(0,1,1)), vh = dot(gh, f-vec3(1,1,1));
  float k = -va+vb+vc-vd+ve-vf-vg+vh;
  float v = va + u.x*(vb-va) + u.y*(vc-va) + u.z*(ve-va) + u.x*u.y*(va-vb-vc+vd) + u.y*u.z*(va-vc-ve+vg) + u.z*u.x*(va-vb-ve+vf) + k*u.x*u.y*u.z;
  vec3 d = ga + u.x*(gb-ga) + u.y*(gc-ga) + u.z*(ge-ga) + u.x*u.y*(ga-gb-gc+gd) + u.y*u.z*(ga-gc-ge+gg) + u.z*u.x*(ga-gb-ge+gf) + (-ga+gb+gc-gd+ge-gf-gg+gh)*u.x*u.y*u.z
    + du*(vec3(vb,vc,ve) - va + u.yzx*vec3(va-vb-vc+vd, va-vc-ve+vg, va-vb-ve+vf) + u.zxy*vec3(va-vb-ve+vf, va-vb-vc+vd, va-vc-ve+vg) + u.yzx*u.zxy*k);
  return vec4(v, d);
}
// swell(p*1.9) and its gradient in p, from one pass over the octaves.
vec4 swellD(vec3 p){
  vec3 q = p*(1.9*1.45) + vec3(0.0, uT*0.10, uT*0.045);
  float a = 0.5, norm = 0.0, f = 1.0; vec4 s = vec4(0.0);
  for(int i=0;i<OCTAVES;i++){ vec4 n = noised(q*f); s += a*vec4(n.x, n.yzw*f); norm += a; f *= 2.03; a *= 0.5; }
  return vec4(s.x, s.yzw*(1.9*1.45)) / norm * 0.75;
}
// The gradient of a rounded box's distance at p, in the box's own frame.
vec3 boxGrad(vec3 p, vec3 b){
  vec3 q = abs(p) - b;
  if (max(q.x, max(q.y, q.z)) > 0.0) return sign(p)*normalize(max(q, 0.0));
  return sign(p)*step(q.yzx, q.xyz)*step(q.zxy, q.xyz);
}
// The box of the four around p that is nearest it.
vec2 nearest(vec3 p, float w){
  vec2 cell = p.xz/SP;
  vec2 id = clamp(floor(cell + 0.5), -1.0, 1.0);
  vec2 side = sign(cell - id);
  vec2 best = id; float d = boxAt(p, id, w);
  vec2 n = clamp(id + vec2(side.x, 0.0), -1.0, 1.0); float e = boxAt(p, n, w); if (e < d) { d = e; best = n; }
  n = clamp(id + vec2(0.0, side.y), -1.0, 1.0); e = boxAt(p, n, w); if (e < d) { d = e; best = n; }
  n = clamp(id + side, -1.0, 1.0); e = boxAt(p, n, w); if (e < d) { best = n; }
  return best;
}
vec3 env(vec3 r){
  float h = r.y*0.5 + 0.5;
  vec3 c = mix(vec3(0.085,0.086,0.105), vec3(0.30,0.30,0.37), pow(h, 1.35));
  c += vec3(0.62,0.62,0.70) * exp(-abs(r.y)*5.5);
  c += vec3(1.00,0.98,0.96) * pow(max(dot(r, normalize(vec3( 0.52, 0.66, 0.54))), 0.0), 26.0) * 2.2;
  c += vec3(0.36,0.36,0.62) * pow(max(dot(r, normalize(vec3(-0.72, 0.28, 0.38))), 0.0),  5.0) * 0.55;
  c += uAccent              * pow(max(dot(r, normalize(vec3( 0.10,-0.62,-0.68))), 0.0),  6.0) * 0.95;
  return c;
}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
void main(){
  vec2 uv = (vUv*2.0 - 1.0); uv.x *= uRes.x/uRes.y;
  vec3 ro = vec3(0.0, 0.0, 6.2); vec3 rd = normalize(vec3(uv, -2.7));
  float cp = cos(uPitch), sp = sin(uPitch); mat2 RP = mat2(cp, -sp, sp, cp);
  ro.yz = RP*ro.yz; rd.yz = RP*rd.yz;
  mat2 R2 = mat2(cos(uYaw), -sin(uYaw), sin(uYaw), cos(uYaw));
  ro.xz = R2*ro.xz; rd.xz = R2*rd.xz;
  float bb = dot(ro, rd); float cc = dot(ro, ro) - 5.2; float hh = bb*bb - cc;
  vec3 col = vec3(0.0); float alpha = 0.0;
  if (hh > 0.0) {
    float t = max(-bb - sqrt(hh), 0.0); float tMax = t + 4.8; bool hit = false; vec3 p = ro;
    for (int i = 0; i < 110; i++) { p = ro + rd*t; float s = stride(p); if (s < 0.0) { hit = true; break; } if (t > tMax) break; t += s; }
    if (hit) {
      // The surface's normal is the field's gradient: the nearest box's, tilted by the swell's.
      vec4 w = swellD(p); vec2 id = nearest(p, w.x); float c = isCentre(id);
      vec3 n = normalize(boxGrad(p - boxC(id), vec3(mix(0.36, 0.45, c))) + w.yzw * mix(0.004, 0.05, c));
      vec3 refl = reflect(rd, n); float ndv = max(dot(n, -rd), 0.0);
      vec3 F0 = vec3(0.70, 0.70, 0.76); vec3 F = F0 + (1.0 - F0) * pow(1.0 - ndv, 5.0);
      vec3 tg = normalize(cross(n, vec3(0.0,1.0,0.0)) + vec3(1e-4));
      vec3 reflected = env(refl)*0.5 + env(normalize(refl + tg*0.13))*0.25 + env(normalize(refl - tg*0.13))*0.25;
      float disp = pow(1.0 - ndv, 3.0) * 0.05;
      reflected.r = mix(reflected.r, env(normalize(refl + n*disp)).r, 0.8);
      reflected.b = mix(reflected.b, env(normalize(refl - n*disp)).b, 0.8);
      float isC = isCentre(clamp(floor(p.xz/SP + 0.5), -1.0, 1.0));
      float ao = clamp(1.0 - abs(w.x) * mix(0.3, 2.0, isC), 0.45, 1.0);
      col = reflected * F * ao; col += uAccent * pow(1.0 - ndv, 4.0) * 0.22;
      col = mix(col, col*vec3(0.8,0.66,1.35) + uAccent*0.16, isC*0.6);
      col *= mix(0.86, 1.0, isC); alpha = 1.0;
    }
  }
  if (alpha < 0.5) { float r = length(uv); float g = exp(-r*r*2.4); col = uAccent * g * 0.1; alpha = g * 0.22; }
  col = aces(col);
  float dz = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453) - 0.5;
  col += dz / 255.0;
  outColor = vec4(col, alpha);
}`;

/** What the field turns at on its own, in radians a second, and how the camera looks down on it. */
const REST_SPIN = 0.12;
const PITCH = 0.62;
/** A third of the display's frames is enough for a slow turn. */
const FRAME_MS = 30;

export interface BoxesRenderer extends Renderer {
  setVisible(on: boolean): void;
  drag(phase: 'start' | 'move' | 'end', dx: number): void;
  /** The canvas's new size in device pixels; the turn carries on where it was. */
  fit(width: number, height: number): void;
}

export function createBoxesProgram(
  gl: WebGL2RenderingContext,
  fragmentShader: string,
): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error('site: no shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      throw new Error(`site: a shader does not compile: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  if (program === null) throw new Error('site: no program');
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentShader));
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
  return program;
}

export function createBoxesRenderer(canvas: OffscreenCanvas, drawn: () => void): BoxesRenderer {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
  });
  if (gl === null) throw new Error('site: the boxes have no WebGL2 context');
  const program = createBoxesProgram(gl, BOXES_FRAGMENT_SHADER);
  const uniform = (name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(program, name);
  const uT = uniform('uT');
  const uYaw = uniform('uYaw');
  gl.uniform3f(uniform('uAccent'), ORB_ACCENT[0], ORB_ACCENT[1], ORB_ACCENT[2]);
  const uRes = uniform('uRes');
  gl.uniform2f(uRes, canvas.width, canvas.height);
  gl.uniform1f(uniform('uPitch'), PITCH);
  gl.clearColor(0, 0, 0, 0);
  gl.viewport(0, 0, canvas.width, canvas.height);

  const started = performance.now();
  let yaw = 0.62;
  let spin = REST_SPIN;
  let previous = 0;
  let dragging = false;
  let lastDrag = 0;
  let visible = false;
  let announced = false;

  return {
    minFrameMs: FRAME_MS,
    wantsFrames: () => visible,
    setVisible(on) {
      visible = on;
      if (!on) previous = 0;
    },
    drag(phase, dx) {
      const now = performance.now();
      if (phase === 'start') {
        dragging = true;
      } else if (phase === 'move') {
        const seconds = Math.max(8, now - lastDrag) / 1000;
        yaw += dx * 0.008;
        spin = Math.max(-5, Math.min(5, (dx * 0.008) / seconds));
      } else {
        dragging = false;
      }
      lastDrag = now;
    },
    fit(width, height) {
      canvas.width = width;
      canvas.height = height;
      gl.uniform2f(uRes, width, height);
      gl.viewport(0, 0, width, height);
    },
    draw(now) {
      const seconds = previous === 0 ? 0.03 : Math.min(0.06, (now - previous) / 1000);
      previous = now;
      if (!dragging) {
        spin += (REST_SPIN - spin) * Math.min(1, seconds * 1.5);
        yaw += spin * seconds;
      }
      gl.uniform1f(uT, 1.2 + (now - started) / 1000);
      gl.uniform1f(uYaw, yaw);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!announced) {
        announced = true;
        drawn();
      }
    },
  };
}
