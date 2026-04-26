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

import { mkdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
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

  // Helper for hosts that compose keys for slots and event-log files.
  // Joins under the storage root semantics — pure string manipulation, no
  // filesystem hit.
  static joinKey(...parts: readonly string[]): string {
    return join(...parts);
  }
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'ENOENT'
  );
}
