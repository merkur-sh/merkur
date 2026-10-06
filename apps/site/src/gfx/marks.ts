/**
 * The liquid-metal marks: icons and a few large words whose chrome flows.
 *
 * A mark is a mask (its shape in red, a blurred copy as its height in green,
 * baked by `scripts/render-marks.ts`) and one shader that reads the height as
 * a surface and runs bands of chrome across it. Every mark shares one context:
 * each that is on screen is drawn into the same canvas at its own size and
 * copied out, so no canvas is resized and a mark off screen costs nothing.
 */
import type { Renderer } from './worker';

const VERTEX_SHADER = `#version 300 es
in vec2 p; out vec2 vUv;
void main(){ vUv = p*0.5+0.5; gl_Position = vec4(p,0,1); }`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D t; uniform vec2 res; uniform float time; uniform float seed; uniform vec2 ptr;
// The mask is two grey pictures side by side, the shape then its height, rows top to
// bottom; the flow's own space has its origin at the bottom. x is the shape, y the height.
vec2 mask(vec2 uv){
  float side = 0.5 - 0.5/float(textureSize(t, 0).x);
  float x = clamp(uv.x, 0.0, 1.0)*side; float y = 1.0 - uv.y;
  return vec2(texture(t, vec2(x, y)).r, texture(t, vec2(0.5 + x, y)).r);
}
vec3 chrome(float x){ x = fract(x);
  vec3 dark = vec3(0.02,0.02,0.05), steel = vec3(0.42,0.5,0.74), white = vec3(0.98,0.98,1.0), warm = vec3(1.0,0.5,0.22);
  vec3 c = mix(dark, steel, smoothstep(0.02,0.3,x));
  c = mix(c, white, smoothstep(0.3,0.44,x)*(1.0-smoothstep(0.5,0.66,x)));
  c = mix(c, dark, smoothstep(0.68,0.94,x));
  c += warm*exp(-pow((x-0.7)*26.0,2.0))*0.95;
  c += vec3(0.35,0.45,1.0)*exp(-pow((x-0.24)*30.0,2.0))*0.5;
  return c; }
void main(){
  vec2 s = mask(vUv); float m = s.x;
  if (m < 0.003) { outColor = vec4(0.0); return; }
  vec2 e = 1.5/res;
  float hx = mask(vUv+vec2(e.x,0.)).y - mask(vUv-vec2(e.x,0.)).y;
  float hy = mask(vUv+vec2(0.,e.y)).y - mask(vUv-vec2(0.,e.y)).y;
  vec3 n = normalize(vec3(-hx*7.0, -hy*7.0, 1.0));
  float tt = time*0.16 + seed;
  vec2 q = vUv + n.xy*0.75 + ptr*0.12;
  float f = q.y*1.25 + 0.32*sin(q.x*3.4+tt*2.1) + 0.22*sin(q.y*5.2-tt*1.4+q.x*2.3) + s.y*0.6 + tt*0.45;
  float d = 0.022 + 0.03*(1.0-n.z);
  vec3 col = vec3(chrome(f+d).r, chrome(f).g, chrome(f-d).b);
  col += pow(1.0-n.z, 1.6)*vec3(0.18,0.22,0.4);
  col *= 0.82 + 0.28*s.y;
  outColor = vec4(col*m, m);
}`;

/** The chrome moves slowly; half the display's frames carry it. */
const FRAME_MS = 33;

interface Mark {
  readonly id: number;
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
  readonly texture: WebGLTexture;
  readonly seed: number;
  pointer: readonly [number, number];
  visible: boolean;
  announced: boolean;
}

export interface MarkRenderer extends Renderer {
  add(
    id: number,
    canvas: OffscreenCanvas,
    mask: ImageBitmap,
    seed: number,
  ): {
    setVisible(on: boolean): void;
    pointer(at: readonly [number, number] | null): void;
    /** The mark's canvas takes a new size in device pixels. */
    fit(width: number, height: number): void;
  };
}

export function createMarkRenderer(drawn: (id: number) => void): MarkRenderer {
  const source = new OffscreenCanvas(1, 1);
  const marks: Mark[] = [];
  const started = performance.now();
  let state: {
    gl: WebGL2RenderingContext;
    res: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    seed: WebGLUniformLocation | null;
    ptr: WebGLUniformLocation | null;
  } | null = null;

  const context = (): NonNullable<typeof state> => {
    if (state !== null) return state;
    const gl = source.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });
    if (gl === null) throw new Error('site: the marks have no WebGL2 context');
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
    gl.clearColor(0, 0, 0, 0);
    state = {
      gl,
      res: gl.getUniformLocation(program, 'res'),
      time: gl.getUniformLocation(program, 'time'),
      seed: gl.getUniformLocation(program, 'seed'),
      ptr: gl.getUniformLocation(program, 'ptr'),
    };
    return state;
  };

  return {
    minFrameMs: FRAME_MS,
    wantsFrames: () => marks.some((mark) => mark.visible),
    draw(now) {
      const { gl, res, time, seed, ptr } = context();
      gl.uniform1f(time, (now - started) / 1000);
      for (const mark of marks) {
        if (!mark.visible) continue;
        const { width, height } = mark.canvas;
        gl.viewport(0, 0, width, height);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindTexture(gl.TEXTURE_2D, mark.texture);
        gl.uniform2f(res, width, height);
        gl.uniform1f(seed, mark.seed);
        gl.uniform2f(ptr, mark.pointer[0], mark.pointer[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        mark.context.clearRect(0, 0, width, height);
        // The viewport sits at the bottom-left of the shared canvas.
        mark.context.drawImage(
          source,
          0,
          source.height - height,
          width,
          height,
          0,
          0,
          width,
          height,
        );
        if (!mark.announced) {
          mark.announced = true;
          drawn(mark.id);
        }
      }
    },
    add(id, canvas, mask, seed) {
      // The shared canvas only ever grows, and only when a mark is added or resized.
      const hold = (): void => {
        if (canvas.width > source.width || canvas.height > source.height) {
          source.width = Math.max(source.width, canvas.width);
          source.height = Math.max(source.height, canvas.height);
        }
      };
      hold();
      const { gl } = context();
      const texture = gl.createTexture();
      const target = canvas.getContext('2d');
      if (texture === null || target === null) throw new Error('site: a mark cannot be set up');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      mask.close();
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const mark: Mark = {
        id,
        canvas,
        context: target,
        texture,
        seed,
        pointer: [0, 0],
        visible: false,
        announced: false,
      };
      marks.push(mark);
      return {
        setVisible(on) {
          mark.visible = on;
        },
        pointer(at) {
          mark.pointer = at === null ? [0, 0] : [at[0], -at[1]];
        },
        fit(width, height) {
          canvas.width = width;
          canvas.height = height;
          hold();
        },
      };
    },
  };
}
