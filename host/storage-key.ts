// Storage key validation shared by NodeStorage and OPFSStorage, so both
// adapters accept and refuse exactly the same keys.
//
// A key is a `/`-separated relative path. Every segment must be a plain
// name: no empty segments (`a//b`, `a/`), no `.` or `..`, no backslash
// (a separator on Windows and refused by OPFS), and no NUL. Keys are never
// normalised, so `runs/.` cannot collapse to `runs` and `runs/x/../y`
// cannot reach a sibling: a caller that composes a key from untrusted
// input gets an error instead of a different path.

export function splitStorageKey(adapter: string, key: string): readonly string[] {
  if (key === '' || key.includes('\0') || key.includes('\\')) {
    throw new Error(`${adapter}: invalid key ${JSON.stringify(key)}`);
  }
  if (key.startsWith('/')) {
    throw new Error(`${adapter}: key ${JSON.stringify(key)} escapes root`);
  }
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(`${adapter}: key ${JSON.stringify(key)} escapes root`);
    }
    if (segment === '' || segment === '.') {
      throw new Error(`${adapter}: invalid key ${JSON.stringify(key)}`);
    }
  }
  return segments;
}

// Filesystems that fold case or Unicode normalization (macOS and Windows
// by default) resolve differently spelled names to one entry, so `Keep`
// and `keep`, or `Café` in NFC and NFD, may be the same file. Two names
// whose folded forms are equal may alias. The repeated case mapping
// catches characters whose upper and lower forms differ in length or do
// not round-trip, such as `ß`, `ẞ`, `ς` and `ſ`.
export function foldStorageName(name: string): string {
  return name.normalize('NFD').toLowerCase().toUpperCase().toLowerCase().normalize('NFD');
}

// Returns a name from `names`, spelled differently from `name`, that may
// resolve to the same storage entry.
export function findAliasedName(names: Iterable<string>, name: string): string | undefined {
  const folded = foldStorageName(name);
  for (const candidate of names) {
    if (candidate !== name && foldStorageName(candidate) === folded) return candidate;
  }
  return undefined;
}
