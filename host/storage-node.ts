// NodeStorage — filesystem-backed implementation of sim/ports.ts Storage.
//
// ARCHITECTURE.md "Event log": NDJSON, append-only, keyed by (tick, seq).
// Browser host backs storage with OPFS; Node host backs it with plain files.
// Both serve the same NDJSON shape, so a save file moves between hosts
// without conversion.
//
// The Storage interface is path-agnostic — keys are arbitrary strings. This
// adapter resolves them under a `root` directory; the host chooses the root
// (e.g. `./saves`, `~/.bobivolve`, or a temp dir for tests) so the adapter
// itself does not encode any "where do save files live" policy.

import { mkdir, readdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import type { Storage } from '../sim/ports.js';

export interface NodeStorageOptions {
  // Filesystem directory under which all keys are resolved. Created on
  // first write if it does not exist.
  readonly root: string;
}

export class NodeStorage implements Storage {
  private readonly root: string;

  constructor(options: NodeStorageOptions) {
    this.root = resolve(options.root);
  }

  async read(key: string): Promise<Uint8Array | null> {
    const path = this.resolveKey(key);
    try {
      return await readFile(path);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async append(key: string, data: Uint8Array): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data);
  }

  async delete(key: string): Promise<void> {
    const path = this.resolveKey(key);
    try {
      await rm(path);
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
  }

  // Whether a key currently exists. Not part of the Storage interface; useful
  // for host-level concerns like "does this save slot exist".
  async exists(key: string): Promise<boolean> {
    const path = this.resolveKey(key);
    try {
      await stat(path);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  // Map a Storage key to a filesystem path under root. Refuses keys that
  // resolve outside root — protection against `../`-laden keys, a precaution
  // for a host that may eventually load keys from external sources.
  private resolveKey(key: string): string {
    if (key === '' || key.includes('\0')) {
      throw new Error(`NodeStorage: invalid key ${JSON.stringify(key)}`);
    }
    const resolved = resolve(this.root, normalize(key));
    const rel = relative(this.root, resolved);
    if (rel.startsWith('..') || rel.startsWith(sep) || resolved === this.root) {
      throw new Error(`NodeStorage: key ${JSON.stringify(key)} escapes root`);
    }
    return resolved;
  }

  // Helper for tests / hosts that want to know the absolute path a key
  // resolves to without performing IO.
  pathFor(key: string): string {
    return this.resolveKey(key);
  }

  // Delete every regular file directly inside `dirKey` and return the count
  // removed. Idempotent: a missing directory yields 0 with no error, an
  // empty directory yields 0. Sub-directories are left in place — the
  // current callers (snapshot reaper) only place flat files inside their
  // target directories, and a recursive sweep would risk being too eager
  // if the directory layout grows. Not part of the Storage interface; this
  // is a host-level convenience the snapshot reaper relies on.
  async reapDirectory(dirKey: string): Promise<number> {
    const path = this.resolveKey(dirKey);
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch (e) {
      if (isNotFound(e)) return 0;
      throw e;
    }
    let reaped = 0;
    for (const entry of entries) {
      const childPath = join(path, entry);
      let info;
      try {
        info = await stat(childPath);
      } catch (e) {
        if (isNotFound(e)) continue;
        throw e;
      }
      if (!info.isFile()) continue;
      try {
        await rm(childPath);
        reaped += 1;
      } catch (e) {
        if (isNotFound(e)) continue;
        throw e;
      }
    }
    return reaped;
  }

  // Enumerate the immediate children of `parentKey`, returning each
  // entry's name and whether it is a file or sub-directory. Idempotent
  // and safe on a missing directory: returns an empty array. Not part
  // of the Storage interface; the run-slots host code uses this to
  // discover persisted run-IDs and inspect their snapshot directories.
  async listEntries(parentKey: string): Promise<readonly StorageDirEntry[]> {
    const path = this.resolveKey(parentKey);
    let names: string[];
    try {
      names = await readdir(path);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const entries: StorageDirEntry[] = [];
    for (const name of names) {
      let info;
      try {
        info = await stat(join(path, name));
      } catch (e) {
        if (isNotFound(e)) continue;
        throw e;
      }
      entries.push({
        name,
        kind: info.isDirectory() ? 'directory' : 'file',
      });
    }
    return entries;
  }

  // mtime of `key` in milliseconds since epoch, or null if missing.
  // Host-level helper for the run-slots UI ("when did this slot last
  // change?"). Not part of the Storage interface.
  async getMtimeMs(key: string): Promise<number | null> {
    const path = this.resolveKey(key);
    try {
      const info = await stat(path);
      return info.mtimeMs;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  // Recursively remove the directory at `dirKey` and everything under
  // it. Idempotent: missing directory yields no error. Not part of the
  // Storage interface — host-level helper for run-slot deletion.
  async removeDirectory(dirKey: string): Promise<void> {
    const path = this.resolveKey(dirKey);
    try {
      await rm(path, { recursive: true, force: true });
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
  }

  // Helper for hosts that compose keys for slots and event-log files.
  // Joins under the storage root semantics — pure string manipulation, no
  // filesystem hit.
  static joinKey(...parts: readonly string[]): string {
    return join(...parts);
  }
}

// Shape returned by the host-level listEntries helper. File / directory
// kind is the only discriminant the host needs; size and mtime are
// fetched separately via getMtimeMs when wanted.
export interface StorageDirEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'ENOENT'
  );
}
