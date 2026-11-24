import { CLIP_COLORS, type DisplayParams } from './display';
import { GRID_ORIGIN } from './format';

const VERT = /* glsl */ `#version 300 es
void main() {
  // Full-screen triangle.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_img;   // RGBA32F, rows bottom-up
uniform sampler2D u_lut;   // 256x1 colormap
uniform vec2 u_size;       // image size in px
uniform vec2 u_offset;     // device px of the image's top-left corner on the canvas
uniform float u_scale;     // device px per image px
uniform float u_canvasH;
uniform float u_lo, u_hi;  // window, log2 of value
uniform int u_mode;        // 0 log, 1 linear, 2 false color
uniform int u_channel;     // 0 rgb, 1 r, 2 g, 3 b, 4 luminance, 5 alpha
uniform bool u_clip, u_isolate, u_bands;
uniform vec2 u_hover;      // log2 range highlighted from the histogram; x > y means off
uniform vec3 u_weights;

// Mosaic view of RAW sensor data: one value per photosite, shown in its own color.
uniform bool u_mosaic;
uniform highp usampler2D u_cfa; // R16UI raw integers, rows top-down
uniform sampler2D u_cell;       // RGBA32F per CFA cell: color index, black level, scale
uniform ivec2 u_period;

uniform vec3 c_under, c_over, c_nan, c_neg, c_hover;

const float GRID_ORIGIN = ${GRID_ORIGIN.toFixed(9)}; // log2 where bands start (see format.ts)

out vec4 outColor;

bool isSpecial(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }

float srgb(float x) {
  x = clamp(x, 0.0, 1.0);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}

// Position of a value in the window; < 0 under, > 1 over. Non-positive values are "under".
float windowT(float v) {
  if (u_mode == 1) {
    float a = exp2(u_lo), b = exp2(u_hi);
    return (v - a) / (b - a);
  }
  if (v <= 0.0) return -1.0;
  float ev = log2(v);
  if (u_mode == 2 && u_bands) ev = floor(ev - GRID_ORIGIN) + 0.5 + GRID_ORIGIN;
  return (ev - u_lo) / (u_hi - u_lo);
}

float toDisplay(float t) { return u_mode == 1 ? srgb(t) : clamp(t, 0.0, 1.0); }

void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_canvasH - gl_FragCoord.y);
  vec2 ip = (frag - u_offset) / u_scale;

  if (ip.x < 0.0 || ip.y < 0.0 || ip.x >= u_size.x || ip.y >= u_size.y) {
    // Checkerboard outside the image so black pixels are distinguishable from "no image".
    vec2 c = floor(frag / 12.0);
    float k = mod(c.x + c.y, 2.0);
    outColor = vec4(vec3(0.11 + 0.025 * k), 1.0);
    return;
  }

  ivec2 tc = ivec2(int(ip.x), int(u_size.y) - 1 - int(ip.y));
  vec4 px;
  int site = -1;
  float siteValue = 0.0;
  if (u_mosaic) {
    ivec2 p = ivec2(ip);
    vec4 cell = texelFetch(u_cell, p % u_period, 0);
    siteValue = (float(texelFetch(u_cfa, p, 0).r) - cell.g) * cell.b;
    site = min(int(cell.r + 0.5), 3);
    if (site == 3) site = 1;
    px = vec4(0.0, 0.0, 0.0, 1.0);
    px[site] = siteValue;
    if (u_channel >= 1 && u_channel <= 3 && site != u_channel - 1) {
      // A photosite of another color: there is no value for this channel here.
      vec3 c = vec3(0.045);
      if (u_scale >= 16.0) {
        vec2 f = fract(ip) * u_scale;
        if (f.x < 1.0 || f.y < 1.0) c = mix(c, vec3(0.5), 0.25);
      }
      outColor = vec4(c, 1.0);
      return;
    }
  } else {
    px = texelFetch(u_img, tc, 0);
  }

  // The scalar that drives clipping, isolation and hover tests.
  float v;
  if (site >= 0) v = siteValue;
  else if (u_channel == 1) v = px.r;
  else if (u_channel == 2) v = px.g;
  else if (u_channel == 3) v = px.b;
  else if (u_channel == 5) v = px.a;
  else v = dot(px.rgb, u_weights);

  bool special = u_channel == 0 ? (isSpecial(px.r) || isSpecial(px.g) || isSpecial(px.b)) : isSpecial(v);
  bool negative = u_channel == 0 ? (px.r < 0.0 || px.g < 0.0 || px.b < 0.0) : v < 0.0;

  vec3 color;
  bool over, under;
  if (u_mode == 2 || u_channel != 0) {
    float t = windowT(v);
    under = t < 0.0;
    over = t > 1.0;
    color = u_mode == 2 ? texture(u_lut, vec2((clamp(t, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)).rgb
                        : vec3(toDisplay(t));
  } else {
    vec3 t = vec3(windowT(px.r), windowT(px.g), windowT(px.b));
    under = all(lessThan(t, vec3(0.0)));
    over = any(greaterThan(t, vec3(1.0)));
    color = vec3(toDisplay(t.r), toDisplay(t.g), toDisplay(t.b));
  }

  if (u_clip) {
    if (special) color = c_nan;
    else if (negative) color = c_neg;
    else if (over) color = c_over;
    else if (under) color = c_under;
  } else if (special) {
    color = c_nan;
  }

  if (u_isolate && (over || under || special || negative)) {
    color = u_clip ? color * 0.35 : vec3(0.06);
  }

  if (u_hover.x <= u_hover.y) {
    float ev = v > 0.0 ? log2(v) : -1e9;
    if (ev >= u_hover.x && ev < u_hover.y) color = c_hover;
    else color *= 0.4;
  }

  // Pixel grid when zoomed in far.
  if (u_scale >= 16.0) {
    vec2 f = fract(ip) * u_scale;
    if (f.x < 1.0 || f.y < 1.0) color = mix(color, vec3(0.5), 0.25);
  }

  outColor = vec4(color, 1.0);
}`;

const MODE = { log: 0, linear: 1, false: 2 } as const;
const CHANNEL = { rgb: 0, r: 1, g: 2, b: 3, l: 4, a: 5 } as const;

export interface ViewTransform {
  /** Device px per image px. */
  scale: number;
  /** Device px of the image's top-left corner. */
  offsetX: number;
  offsetY: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private imgTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private cfaTex: WebGLTexture;
  private cellTex: WebGLTexture;
  private period: [number, number] = [0, 0];
  private size: [number, number] = [0, 0];
  readonly maxTextureSize: number;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.program = link(gl, VERT, FRAG);
    this.imgTex = makeTexture(gl);
    this.lutTex = makeTexture(gl, gl.LINEAR);
    // Placeholders, so the integer sampler always has a matching texture bound.
    this.cfaTex = makeTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(1));
    this.cellTex = makeTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    gl.bindVertexArray(gl.createVertexArray());
  }

  private u(name: string) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }

  setImage(width: number, height: number, data: Float32Array) {
    if (width > this.maxTextureSize || height > this.maxTextureSize) {
      throw new Error(`Image is ${width}×${height}, but this GPU's texture limit is ${this.maxTextureSize}px`);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    this.size = [width, height];
  }

  /** Raw CFA integers (rows top-down) and the per-cell table, for the mosaic view. Null clears it. */
  setMosaic(m: { width: number; height: number; dn: Uint16Array; cellW: number; cellH: number; cell: Float32Array } | null) {
    const gl = this.gl;
    this.period = m ? [m.cellW, m.cellH] : [0, 0];
    if (!m) return;
    gl.bindTexture(gl.TEXTURE_2D, this.cfaTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, m.width, m.height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, m.dn);
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, m.cellW, m.cellH, 0, gl.RGBA, gl.FLOAT, m.cell);
  }

  get hasMosaic() {
    return this.period[0] > 0;
  }

  setLut(lut: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  render(view: ViewTransform, p: DisplayParams, hover: [number, number] | null, weights: [number, number, number], mosaic = false) {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.uniform1i(this.u('u_img'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.u('u_lut'), 1);
    const useMosaic = mosaic && this.hasMosaic;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.cfaTex);
    gl.uniform1i(this.u('u_cfa'), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.uniform1i(this.u('u_cell'), 3);
    gl.uniform1i(this.u('u_mosaic'), useMosaic ? 1 : 0);
    gl.uniform2i(this.u('u_period'), Math.max(1, this.period[0]), Math.max(1, this.period[1]));

    gl.uniform2f(this.u('u_size'), this.size[0], this.size[1]);
    gl.uniform2f(this.u('u_offset'), view.offsetX, view.offsetY);
    gl.uniform1f(this.u('u_scale'), view.scale);
    gl.uniform1f(this.u('u_canvasH'), height);
    gl.uniform1f(this.u('u_lo'), p.lo);
    gl.uniform1f(this.u('u_hi'), Math.max(p.hi, p.lo + 1e-4));
    gl.uniform1i(this.u('u_mode'), MODE[p.mode]);
    gl.uniform1i(this.u('u_channel'), CHANNEL[p.channel]);
    gl.uniform1i(this.u('u_clip'), p.clip ? 1 : 0);
    gl.uniform1i(this.u('u_isolate'), p.isolate ? 1 : 0);
    gl.uniform1i(this.u('u_bands'), p.bands ? 1 : 0);
    gl.uniform2f(this.u('u_hover'), hover ? hover[0] : 1, hover ? hover[1] : 0);
    gl.uniform3f(this.u('u_weights'), weights[0], weights[1], weights[2]);
    gl.uniform3fv(this.u('c_under'), CLIP_COLORS.under);
    gl.uniform3fv(this.u('c_over'), CLIP_COLORS.over);
    gl.uniform3fv(this.u('c_nan'), CLIP_COLORS.nan);
    gl.uniform3fv(this.u('c_neg'), CLIP_COLORS.negative);
    gl.uniform3fv(this.u('c_hover'), CLIP_COLORS.hover);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function makeTexture(gl: WebGL2RenderingContext, filter: number = gl.NEAREST): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}
