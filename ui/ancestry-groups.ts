import type { LineageNode } from './sim-store.js';

export const MAX_ANCESTRY_GROUPS = 6;
export const MAX_ANCESTRY_NAME_LENGTH = 40;
// Group identity is player-selected, so adjacent genetic IDs must not receive
// indistinguishable colours from the lineage hash. Persist the chosen slot.
export const ANCESTRY_GROUP_COLORS = [
  'oklch(0.72 0.13 255)',
  'oklch(0.78 0.13 75)',
  'oklch(0.75 0.13 150)',
  'oklch(0.75 0.13 330)',
  'oklch(0.78 0.1 200)',
  'oklch(0.72 0.16 25)',
] as const;

// Dashboard metadata only: genetic names, ancestry and firmware stay untouched.
export interface AncestryPin {
  readonly rootId: string;
  readonly name: string;
  readonly color: string;
  readonly foundedAtTick: bigint;
  readonly founderProbeId: string;
}

export interface AncestryGroup extends AncestryPin {
  readonly population: bigint;
  readonly memberIds: readonly string[];
}

export interface AncestryGroups {
  readonly groups: readonly AncestryGroup[];
  readonly ownerByLineage: ReadonlyMap<string, string | null>;
  readonly ungroupedPopulation: bigint;
  readonly ungroupedMemberIds: readonly string[];
}

export function validAncestryPins(
  pins: readonly AncestryPin[],
  lineages: ReadonlyMap<string, LineageNode>,
): readonly AncestryPin[] {
  return pins.filter((pin) => {
    const root = lineages.get(pin.rootId);
    return (
      root !== undefined &&
      root.foundedAtTick === pin.foundedAtTick &&
      root.founderProbeId === pin.founderProbeId
    );
  });
}

interface Ownership {
  readonly pins: readonly AncestryPin[];
  readonly owners: ReadonlyMap<string, string | null>;
  readonly results: WeakMap<ReadonlyMap<string, bigint>, AncestryGroups>;
}

const ownershipCache = new WeakMap<
  ReadonlyMap<string, LineageNode>,
  WeakMap<readonly AncestryPin[], Ownership>
>();

export function deriveAncestryGroups(
  lineages: ReadonlyMap<string, LineageNode>,
  populationByLineage: ReadonlyMap<string, bigint>,
  pins: readonly AncestryPin[],
): AncestryGroups {
  let byPins = ownershipCache.get(lineages);
  if (byPins === undefined) {
    byPins = new WeakMap();
    ownershipCache.set(lineages, byPins);
  }
  let ownership = byPins.get(pins);
  if (ownership === undefined) {
    const valid = validAncestryPins(pins, lineages);
    const roots = new Set(valid.map((pin) => pin.rootId));
    const owners = new Map<string, string | null>();
    // Iterative path compression is linear across the tree and never depends
    // on the JS call-stack depth. Missing parents/cycles remain ungrouped.
    for (const id of lineages.keys()) {
      const path: string[] = [];
      const visiting = new Set<string>();
      let current: string | null = id;
      let owner: string | null = null;
      while (current !== null) {
        if (owners.has(current)) {
          owner = owners.get(current) ?? null;
          break;
        }
        if (roots.has(current)) {
          owner = current;
          owners.set(current, current);
          break;
        }
        if (visiting.has(current)) break;
        const lineage = lineages.get(current);
        if (lineage === undefined) break;
        visiting.add(current);
        path.push(current);
        current = lineage.parentId;
      }
      for (const entry of path) owners.set(entry, owner);
    }
    ownership = { pins: valid, owners, results: new WeakMap() };
    byPins.set(pins, ownership);
  }
  const cached = ownership.results.get(populationByLineage);
  if (cached !== undefined) return cached;

  const groups = ownership.pins.map((pin) => ({
    ...pin,
    population: 0n,
    memberIds: [] as string[],
  }));
  const byRoot = new Map(groups.map((group) => [group.rootId, group]));
  let ungroupedPopulation = 0n;
  const ungroupedMemberIds: string[] = [];
  for (const [id, count] of populationByLineage) {
    if (count <= 0n) continue;
    const root = ownership.owners.get(id);
    const group = root === null || root === undefined ? undefined : byRoot.get(root);
    if (group === undefined) {
      ungroupedPopulation += count;
      ungroupedMemberIds.push(id);
    } else {
      group.population += count;
      group.memberIds.push(id);
    }
  }
  const result = {
    groups,
    ownerByLineage: ownership.owners,
    ungroupedPopulation,
    ungroupedMemberIds,
  };
  ownership.results.set(populationByLineage, result);
  return result;
}

const STORAGE_PREFIX = 'bobivolve:ancestry-pins:v1:';
const STORAGE_ERROR =
  'Ancestry groups are available for this session; browser storage is unavailable.';

export function readAncestryPins(runId: string): {
  readonly pins: readonly AncestryPin[];
  readonly error: string | null;
} {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${encodeURIComponent(runId)}`);
    if (raw === null) return { pins: [], error: null };
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > MAX_ANCESTRY_GROUPS) throw new Error();
    const ids = new Set<string>();
    const pins = entries.map((value: unknown): AncestryPin => {
      if (value === null || typeof value !== 'object') throw new Error();
      const pin = value as Record<string, unknown>;
      if (
        typeof pin['rootId'] !== 'string' ||
        pin['rootId'].length === 0 ||
        ids.has(pin['rootId']) ||
        typeof pin['name'] !== 'string' ||
        pin['name'].trim().length === 0 ||
        [...pin['name']].length > MAX_ANCESTRY_NAME_LENGTH ||
        typeof pin['color'] !== 'string' ||
        !/^oklch\([\d.]+ [\d.]+ [\d.]+\)$/.test(pin['color']) ||
        typeof pin['foundedAtTick'] !== 'string' ||
        !/^\d{1,20}$/.test(pin['foundedAtTick']) ||
        typeof pin['founderProbeId'] !== 'string' ||
        pin['founderProbeId'].length === 0
      )
        throw new Error();
      ids.add(pin['rootId']);
      return {
        rootId: pin['rootId'],
        name: pin['name'],
        color: pin['color'],
        foundedAtTick: BigInt(pin['foundedAtTick']),
        founderProbeId: pin['founderProbeId'],
      };
    });
    return { pins, error: null };
  } catch {
    return { pins: [], error: STORAGE_ERROR };
  }
}

export function writeAncestryPins(runId: string, pins: readonly AncestryPin[]): string | null {
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${encodeURIComponent(runId)}`,
      JSON.stringify(pins.map((pin) => ({ ...pin, foundedAtTick: pin.foundedAtTick.toString() }))),
    );
    return null;
  } catch {
    return STORAGE_ERROR;
  }
}
