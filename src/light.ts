// Fluid "colors" are light wavelengths in nm. A stream is a cloud of tiny
// equal-sized particles, each radiating monochromatic light at its wavelength
// with the same total power — so a mixture's spectrum is delta spikes with
// power proportional to each component's rate. We fold that through the CIE
// 1931 standard observer to get the one honest on-screen color. Consequences
// we embrace: spectral colors overflow the sRGB gamut (we desaturate toward
// white just enough to get back inside), and the eye's response dies off at
// the 400/800 nm edges — near-infrared fluid is nearly invisible, fading to
// the color of an unlit pipe.
import type { FluidMap } from './types';

export const WL_MIN = 400;
export const WL_MAX = 800;

// What fluid with no visible emission looks like: the same faint white as an
// empty pipe on the black background — invisible fluid flows in disguise.
const UNLIT = [107, 110, 118]; // #6b6e76

// Wyman–Sloan–Shirley piecewise-Gaussian fit of the CIE 1931 observer
function lobe(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

export function cmf(wl: number): [number, number, number] {
  return [
    1.056 * lobe(wl, 599.8, 37.9, 31.0) + 0.362 * lobe(wl, 442.0, 16.0, 26.7) - 0.065 * lobe(wl, 501.1, 20.4, 26.2),
    0.821 * lobe(wl, 568.8, 46.9, 40.5) + 0.286 * lobe(wl, 530.9, 16.3, 31.1),
    1.217 * lobe(wl, 437.0, 11.8, 36.0) + 0.681 * lobe(wl, 459.0, 26.0, 13.8),
  ];
}

const srgbGamma = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);

// XYZ -> linear sRGB
const xyzToLinear = (X: number, Y: number, Z: number): [number, number, number] => [
  3.2406 * X - 1.5372 * Y - 0.4986 * Z,
  -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
  0.0557 * X - 0.204 * Y + 1.057 * Z,
];

// THE one free constant (the particles' surface brightness): the glow is
// fully vivid once a liter/sec of fluid draws this much total observer
// response (X+Y+Z per unit rate; mid-spectrum wavelengths reach ~2).
const FULL_GLOW = 0.5;

function rgbHex(rgb: number[]): string {
  const c = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

// The fair mix: total XYZ of all the glowing particles, gamut-mapped.
export function mixtureColor(fm: FluidMap | undefined): string {
  let X = 0, Y = 0, Z = 0, total = 0;
  for (const [k, rate] of Object.entries(fm ?? {})) {
    const [x, y, z] = cmf(Number(k));
    X += x * rate;
    Y += y * rate;
    Z += z * rate;
    total += rate;
  }
  if (total <= 1e-9) return rgbHex(UNLIT);
  let [r, g, b] = xyzToLinear(X, Y, Z);
  // out-of-gamut spectral colors: lift all channels equally (desaturate
  // toward white) until nothing is negative
  const neg = Math.min(r, g, b, 0);
  r -= neg;
  g -= neg;
  b -= neg;
  const mx = Math.max(r, g, b);
  const vivid = Math.min(1, (X + Y + Z) / total / FULL_GLOW);
  if (mx <= 1e-9 || vivid <= 0) return rgbHex(UNLIT);
  const srgb = [r, g, b].map((u) => 255 * srgbGamma(u / mx));
  return rgbHex(srgb.map((v, i) => UNLIT[i] + (v - UNLIT[i]) * vivid));
}

export const wavelengthColor = (wl: number): string => mixtureColor({ [wl]: 1 });

export function wavelengthName(wl: number): string {
  if (wl < 450) return 'violet';
  if (wl < 495) return 'blue';
  if (wl < 570) return 'green';
  if (wl < 590) return 'yellow';
  if (wl < 620) return 'orange';
  if (wl < 740) return 'red';
  return 'infrared';
}
