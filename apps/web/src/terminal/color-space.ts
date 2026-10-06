/** IEC sRGB transfer functions. Inputs and outputs are normalized components. */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

// Decode once per vertex, never per covered pixel. An sRGB attachment performs
// destination decoding, linear blending and output encoding in fixed-function hardware.
export const SRGB_DECODE_WGSL = `
fn srgb_to_linear(c: vec3f) -> vec3f {
  return select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c > vec3f(0.04045));
}`;
