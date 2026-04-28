// Deterministic per-lineage colour. Same FNV-1a foundation we already
// use in `sim/lineage-names.ts` to mint names — so a lineage's name and
// its colour are derived from the same hash, and a probe's colour
// matches between the substrate map, the lineage tree, and any future
// per-lineage visualisation. No store state, no cross-panel
// coordination needed; every panel calls `lineageColor(id)` and gets
// the same answer.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a(value: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash ^ BigInt(value.charCodeAt(i))) * FNV_PRIME) & U64_MASK;
  }
  return hash;
}

// OKLCH lightness/chroma chosen to read well on the observatory dark
// background — bright enough to pop against the surface tones, not so
// saturated that two adjacent lineages clash. Hue spans the full wheel
// from the hash, so a few-dozen lineages occupy comfortable spacing.
const LIGHTNESS = 0.72;
const CHROMA = 0.13;

export function lineageColor(id: string): string {
  const hash = fnv1a(id);
  // Use the high 16 bits of the hash as the hue source; low bits feed
  // other identity-derived values (lineage names) and we don't want
  // colour to collide with name-pick patterns.
  const huePoint = Number((hash >> 16n) & 0xffffn) / 0xffff;
  const hue = Math.floor(huePoint * 360);
  return `oklch(${LIGHTNESS.toString()} ${CHROMA.toString()} ${hue.toString()})`;
}

// Soft variant for fills behind text or as backdrop tints.
export function lineageColorSoft(id: string, alpha = 0.18): string {
  const hash = fnv1a(id);
  const huePoint = Number((hash >> 16n) & 0xffffn) / 0xffff;
  const hue = Math.floor(huePoint * 360);
  return `oklch(${LIGHTNESS.toString()} ${CHROMA.toString()} ${hue.toString()} / ${alpha.toString()})`;
}
