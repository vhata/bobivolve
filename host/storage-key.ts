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
