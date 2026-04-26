// OPFSStorage — Origin Private File System backed implementation of
// sim/ports.ts Storage. Browser-side counterpart to NodeStorage.
//
// ARCHITECTURE.md "Event log": NDJSON, append-only, keyed by (tick, seq).
// The browser host backs storage with OPFS, the Node host backs it with
// plain files; both serve the same NDJSON shape, so a save file moves
// between hosts without conversion.
//
// The Storage interface is path-agnostic — keys are arbitrary `/`-separated
// strings. This adapter resolves them under an OPFS directory subtree
// rooted either at the OPFS root itself or at a named subdirectory the
// host nominates (mirrors NodeStorage's `root` option). Tests exercising
// multiple "roots" within a single origin therefore stay cheap and
// isolated.
//
// Async path only. `FileSystemFileHandle.createSyncAccessHandle()` is
// faster on workers, but the extra mode-management and the fact that sync
// access handles are exclusive (one open handle per file) is not
// load-bearing for R0. We can revisit when a profiler tells us to.

import type { Storage } from '../sim/ports.js';

export interface OPFSStorageOptions {
  // Optional sub-directory under the OPFS origin root. When omitted, the
  // origin root itself is used. Created on first write if it does not
  // exist. The same value across sessions yields the same directory —
  // that is the durability contract of OPFS.
  readonly root?: string;
}

// The subset of the OPFS API we depend on. Declared structurally so the
// in-memory shim used by the test file (and any future polyfill) can
// satisfy it without dragging in the full lib.dom typings — and so this
// module compiles under `lib: ["WebWorker"]` regardless of which DOM
// version ships the OPFS types.
interface OPFSDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OPFSFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OPFSDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface OPFSFileHandle {
  getFile(): Promise<OPFSFile>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OPFSWritable>;
}

interface OPFSFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly size: number;
}

interface OPFSWritable {
  // Real OPFS writables accept FileSystemWriteChunkType, which includes
  // BufferSource. We narrow to Uint8Array because that is the only thing
  // OPFSStorage hands them; widening invites TS5.7's
  // ArrayBufferLike-vs-ArrayBuffer friction with no payoff here.
  write(data: Uint8Array): Promise<void>;
  seek(position: number): Promise<void>;
  close(): Promise<void>;
}

// Locator for a key once it has been validated and split into directory
// segments plus a terminal file name.
interface KeyPath {
  readonly dirs: readonly string[];
  readonly file: string;
}

export class OPFSStorage implements Storage {
  private readonly rootName: string | undefined;
  private rootPromise: Promise<OPFSDirectoryHandle> | undefined;

  constructor(options: OPFSStorageOptions = {}) {
    this.rootName = options.root;
  }

  async read(key: string): Promise<Uint8Array | null> {
    const path = this.parseKey(key);
    const dir = await this.resolveDirReadOnly(path.dirs);
    if (dir === null) return null;
    let fileHandle: OPFSFileHandle;
    try {
      fileHandle = await dir.getFileHandle(path.file, { create: false });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
    const file = await fileHandle.getFile();
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const path = this.parseKey(key);
    const dir = await this.resolveDirCreating(path.dirs);
    const fileHandle = await dir.getFileHandle(path.file, { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  async append(key: string, data: Uint8Array): Promise<void> {
    const path = this.parseKey(key);
    const dir = await this.resolveDirCreating(path.dirs);
    const fileHandle = await dir.getFileHandle(path.file, { create: true });
    // OPFS createWritable() opens at offset 0 by default. To append we ask
    // for the existing size and seek there before writing. keepExistingData
    // must be true or the seek lands inside a freshly truncated file.
    const file = await fileHandle.getFile();
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(file.size);
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.parseKey(key);
    const dir = await this.resolveDirReadOnly(path.dirs);
    if (dir === null) return;
    try {
      await dir.removeEntry(path.file);
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
  }

  // Whether a key currently exists. Not part of the Storage interface;
  // useful for host-level concerns like "does this save slot exist".
  async exists(key: string): Promise<boolean> {
    const path = this.parseKey(key);
    const dir = await this.resolveDirReadOnly(path.dirs);
    if (dir === null) return false;
    try {
      await dir.getFileHandle(path.file, { create: false });
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  // Helper for tests / hosts that want a printable locator for a key.
  // OPFS has no notion of an absolute filesystem path, so we return the
  // normalised key itself — joined with `/`, prefixed by the storage
  // root name if one was configured. Pure string manipulation, no IO.
  pathFor(key: string): string {
    const path = this.parseKey(key);
    const joined = [...path.dirs, path.file].join('/');
    return this.rootName === undefined ? joined : `${this.rootName}/${joined}`;
  }

  // Helper for hosts that compose keys for slots and event-log files.
  // Pure string manipulation, no IO. Mirrors NodeStorage.joinKey.
  static joinKey(...parts: readonly string[]): string {
    return parts.filter((p) => p.length > 0).join('/');
  }

  // Lazily acquire the root directory handle. Cached for the lifetime of
  // the storage instance — OPFS handles are cheap to re-fetch but the
  // round-trips add up across the event-log workload.
  private async getRoot(): Promise<OPFSDirectoryHandle> {
    if (this.rootPromise === undefined) {
      this.rootPromise = this.acquireRoot();
    }
    return this.rootPromise;
  }

  private async acquireRoot(): Promise<OPFSDirectoryHandle> {
    const storage = (
      globalThis as {
        navigator?: { storage?: { getDirectory?: () => Promise<OPFSDirectoryHandle> } };
      }
    ).navigator?.storage;
    if (storage === undefined || typeof storage.getDirectory !== 'function') {
      throw new Error('OPFSStorage: navigator.storage.getDirectory is not available');
    }
    const origin = await storage.getDirectory();
    if (this.rootName === undefined) return origin;
    return origin.getDirectoryHandle(this.rootName, { create: true });
  }

  // Walk the directory chain from root to the parent of the target file,
  // creating missing intermediates (the OPFS equivalent of mkdir -p).
  // Used by write and append.
  private async resolveDirCreating(dirs: readonly string[]): Promise<OPFSDirectoryHandle> {
    let dir = await this.getRoot();
    for (const segment of dirs) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    return dir;
  }

  // Walk the directory chain without creating anything. A missing
  // intermediate yields null so callers can short-circuit to "not found".
  // Used by read, delete, and exists.
  private async resolveDirReadOnly(dirs: readonly string[]): Promise<OPFSDirectoryHandle | null> {
    let dir = await this.getRoot();
    for (const segment of dirs) {
      try {
        dir = await dir.getDirectoryHandle(segment, { create: false });
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    }
    return dir;
  }

  // Validate a key and split it into directory segments plus a terminal
  // file name. Refuses keys that escape the root or contain segments
  // OPFS would reject anyway. Semantics mirror NodeStorage.resolveKey:
  //
  // - Empty key → invalid.
  // - NUL byte in the key → invalid (NodeStorage rejects this; OPFS
  //   implementations diverge, so we reject up-front for parity).
  // - Leading `/` → invalid (would mean "absolute path", which is the
  //   Node-side escape vector).
  // - Any segment of `..` or `.` → escapes (or no-ops, which we still
  //   refuse for parity with the Node side, where `normalize()` collapses
  //   them and any net-upward result is rejected).
  // - Trailing `/` (i.e. last segment empty) → invalid: we need a file
  //   name, not a directory.
  private parseKey(key: string): KeyPath {
    if (key === '' || key.includes('\0')) {
      throw new Error(`OPFSStorage: invalid key ${JSON.stringify(key)}`);
    }
    if (key.startsWith('/')) {
      throw new Error(`OPFSStorage: key ${JSON.stringify(key)} escapes root`);
    }
    const segments = key.split('/');
    let depth = 0;
    for (const segment of segments) {
      if (segment === '' || segment === '.') {
        throw new Error(`OPFSStorage: invalid key ${JSON.stringify(key)}`);
      }
      if (segment === '..') {
        if (depth === 0) {
          throw new Error(`OPFSStorage: key ${JSON.stringify(key)} escapes root`);
        }
        depth -= 1;
        continue;
      }
      depth += 1;
    }
    // Re-walk to materialise the normalised path. Any `..` we accepted
    // above must cancel a prior segment; we rebuild the resolved list.
    const resolved: string[] = [];
    for (const segment of segments) {
      if (segment === '..') {
        resolved.pop();
        continue;
      }
      resolved.push(segment);
    }
    if (resolved.length === 0) {
      throw new Error(`OPFSStorage: key ${JSON.stringify(key)} escapes root`);
    }
    const file = resolved[resolved.length - 1];
    // Defensive: noUncheckedIndexedAccess makes this a string | undefined.
    if (file === undefined) {
      throw new Error(`OPFSStorage: invalid key ${JSON.stringify(key)}`);
    }
    return { dirs: resolved.slice(0, -1), file };
  }
}

function isNotFound(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  // The OPFS spec throws DOMException with name 'NotFoundError' for
  // missing entries. The shim used in tests does the same. Some older
  // implementations also surfaced 'NotFound' or set a `code` property;
  // we cover both for portability.
  if ('name' in e) {
    const name = (e as { name: unknown }).name;
    if (name === 'NotFoundError' || name === 'NotFound') return true;
  }
  if ('code' in e) {
    const code = (e as { code: unknown }).code;
    if (code === 'ENOENT' || code === 'NotFoundError') return true;
  }
  return false;
}
