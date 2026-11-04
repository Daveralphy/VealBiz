import { useEffect, useState } from "react";
import type { Workspace } from "@windveal/shared";
import { publicFileUrl } from "./api";
import { useMe } from "./session";

export type Accent = { c: string; t: string };
export type Palette = Record<Workspace | "me" | "settings" | "import" | "admin" | "profile", Accent>;

const DEFAULT_SEED = "#486FE4";
type Rgb = [number, number, number];

const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
const fromHex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb(h: number, s: number, l: number): Rgb {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * An on-brand family from one colour: the colour itself, close neighbours on either side and a deeper
 * shade. Lightness is kept in a range that reads well on white; no hue strays far from the brand.
 */
export function paletteFrom(seedHex: string): Palette {
  let [h, s] = rgbToHsl(fromHex(seedHex));
  if (s < 0.2) [h, s] = rgbToHsl(fromHex(DEFAULT_SEED)); // grey or black logos: use the default family
  const sat = (x: number) => Math.min(0.78, Math.max(0.5, s * x));
  const make = (dh: number, l: number, sx: number): Accent => {
    // Darken until white text on it is easy to read (contrast 4.5:1 or more), whatever the brand colour.
    let c = hslToRgb(h + dh, sat(sx), l);
    for (let ll = l; contrastWithWhite(c) < 4.5 && ll > 0.18; ll -= 0.02) c = hslToRgb(h + dh, sat(sx), ll);
    return { c: toHex(c), t: toHex(c.map((v) => 255 - (255 - v) * 0.12) as Rgb) };
  };
  return {
    me: make(14, 0.44, 0.9),
    people: make(0, 0.5, 1),
    recruitment: make(-18, 0.45, 0.97),
    crm: make(22, 0.52, 0.86),
    workflows: make(-32, 0.4, 1),
    documents: make(40, 0.5, 0.76),
    insights: make(6, 0.32, 0.83),
    settings: make(-10, 0.38, 0.55),
    import: make(30, 0.44, 0.7),
    admin: make(52, 0.42, 0.62),
    profile: make(0, 0.42, 0.6),
  };
}

function contrastWithWhite([r, g, b]: Rgb) {
  const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05);
}

/** The most common strong colour in an image (ignores white, black, greys and transparent pixels). */
function dominantColour(img: HTMLImageElement): string | null {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, size, size);
  const { data } = g.getImageData(0, 0, size, size);
  const buckets = new Map<string, { n: number; sum: Rgb }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 200) continue;
    const px: Rgb = [data[i]!, data[i + 1]!, data[i + 2]!];
    const [, s, l] = rgbToHsl(px);
    if (s < 0.25 || l < 0.12 || l > 0.9) continue;
    const key = px.map((v) => v >> 5).join(",");
    const b = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] };
    b.n++; b.sum = [b.sum[0] + px[0], b.sum[1] + px[1], b.sum[2] + px[2]];
    buckets.set(key, b);
  }
  let best: { n: number; sum: Rgb } | null = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return best && best.n > 8 ? toHex(best.sum.map((v) => v / best!.n) as Rgb) : null;
}

/**
 * Workspace colours for the signed-in organisation, taken from its uploaded logo. Without a logo (or if
 * it has no strong colour) the brand colour chosen in setup is used, then WindVeal's own family.
 */
export function usePalette(): Palette {
  const { data: me } = useMe();
  const logo = me?.org?.logoFileId ?? null;
  const fallback = me?.org?.brandColor || DEFAULT_SEED;
  const cacheKey = logo ? `wv-palette:${logo}` : null;
  const [seed, setSeed] = useState<string>(() => {
    try { return (cacheKey && localStorage.getItem(cacheKey)) || fallback; } catch { return fallback; }
  });
  useEffect(() => {
    if (!logo) { setSeed(fallback); return; }
    try { const hit = localStorage.getItem(`wv-palette:${logo}`); if (hit) { setSeed(hit); return; } } catch { /* ignore */ }
    const img = new Image();
    img.onload = () => {
      const c = dominantColour(img) ?? fallback;
      setSeed(c);
      try { localStorage.setItem(`wv-palette:${logo}`, c); } catch { /* ignore */ }
    };
    img.onerror = () => setSeed(fallback);
    img.src = publicFileUrl(logo);
  }, [logo, fallback]);
  return paletteFrom(seed);
}
