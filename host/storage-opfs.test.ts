// OPFSStorage tests. Mirrors storage-node.test.ts: missing key returns
// null; round-trip; overwrite; append; mkdir-p on nested keys; idempotent
// delete; escape rejection; empty / NUL key rejection; exists semantics;
// pathFor.
//
// Test environment choice
// -----------------------
// vitest.config.ts defaults to `environment: 'node'`, which has no OPFS.
// We deliberately do NOT add a happy-dom or jsdom dev dependency for this
// module — neither currently ships a working OPFS implementation, and
// pulling in a third-party shim (e.g. use-strict/file-system-access) adds
// install footprint we'd rather avoid for a single adapter.
//
// Instead, this file stands up an in-memory OPFS shim that implements
// just the slice of the API `storage-opfs.ts` consumes. The shim is
// installed on `globalThis.navigator.storage.getDirectory` for the
// duration of the test run. It is a fake — its purpose is to exercise
// OPFSStorage's logic, not to certify OPFS spec conformance.
//
// When this module is later wired up against a real browser test runner
// (or a real OPFS polyfill enters the dependency tree), this file should
// continue to pass against that real implementation; the shim's
// observable behaviour matches the parts of the OPFS spec that
// OPFSStorage relies on (NotFoundError shape, getFileHandle / create
// semantics, createWritable + seek + close lifecycle).

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPFSStorage } from './storage-opfs.js';

// -----------------------------------------------------------------------
// In-memory OPFS shim
// -----------------------------------------------------------------------

class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

class TypeMismatchError extends Error {
  override readonly name = 'TypeMismatchError';
}

class FakeFile {
  constructor(public data: Uint8Array) {}
  get size(): number {
    return this.data.byteLength;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    // Return a fresh copy so callers cannot mutate our internal buffer.
    const copy = new Uint8Array(this.data);
    return copy.buffer;
  }
}

class FakeWritable {
  private buffer: Uint8Array;
  private position = 0;
  private closed = false;

  constructor(
    private readonly fileHandle: FakeFileHandle,
    keepExistingData: boolean,
  ) {
    this.buffer = keepExistingData ? new Uint8Array(fileHandle.contents) : new Uint8Array(0);
  }

  async write(data: BufferSource): Promise<void> {
    if (this.closed) throw new Error('writable closed');
    const bytes =
      data instanceof Uint8Array
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data as ArrayBuffer);
    const required = this.position + bytes.byteLength;
    if (required > this.buffer.byteLength) {
      const grown = new Uint8Array(required);
      grown.set(this.buffer, 0);
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.position);
    this.position += bytes.byteLength;
  }

  async seek(position: number): Promise<void> {
    if (this.closed) throw new Error('writable closed');
    this.position = position;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fileHandle.contents = this.buffer;
  }
}

class FakeFileHandle {
  contents: Uint8Array = new Uint8Array(0);
  async getFile(): Promise<FakeFile> {
    return new FakeFile(this.contents);
  }
  async createWritable(options?: { keepExistingData?: boolean }): Promise<FakeWritable> {
    return new FakeWritable(this, options?.keepExistingData ?? false);
  }
}

class FakeDirectoryHandle {
  private readonly files = new Map<string, FakeFileHandle>();
  private readonly dirs = new Map<string, FakeDirectoryHandle>();

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    if (this.dirs.has(name)) throw new TypeMismatchError(`${name} is a directory`);
    const existing = this.files.get(name);
    if (existing !== undefined) return existing;
    if (options?.create !== true) throw new NotFoundError(name);
    const created = new FakeFileHandle();
    this.files.set(name, created);
    return created;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeDirectoryHandle> {
    if (this.files.has(name)) throw new TypeMismatchError(`${name} is a file`);
    const existing = this.dirs.get(name);
    if (existing !== undefined) return existing;
    if (options?.create !== true) throw new NotFoundError(name);
    const created = new FakeDirectoryHandle();
    this.dirs.set(name, created);
    return created;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    if (this.dirs.has(name)) {
      const dir = this.dirs.get(name)!;
      if (!options?.recursive && (dir.files.size > 0 || dir.dirs.size > 0)) {
        throw new Error(`InvalidModificationError: directory ${name} not empty`);
      }
      this.dirs.delete(name);
      return;
    }
    throw new NotFoundError(name);
  }
}

// Singleton root for a given test. Replaced in beforeEach so each test
// gets a fresh "origin".
let fakeRoot: FakeDirectoryHandle;

function installShim(): void {
  fakeRoot = new FakeDirectoryHandle();
  // Define a navigator.storage on globalThis with our shim. The cast goes
  // wide because the real type is fully specced and we are only honouring
  // the slice OPFSStorage consumes.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      storage: {
        getDirectory: async (): Promise<FakeDirectoryHandle> => fakeRoot,
      },
    },
  });
}

function uninstallShim(): void {
  // Restore by deletion. Subsequent tests that need a shim re-install it.
  delete (globalThis as { navigator?: unknown }).navigator;
}

// -----------------------------------------------------------------------
// Tests — mirror storage-node.test.ts
// -----------------------------------------------------------------------

describe('OPFSStorage', () => {
  let storage: OPFSStorage;

  beforeEach(() => {
    installShim();
    storage = new OPFSStorage();
  });

  afterEach(() => {
    uninstallShim();
  });

  it('returns null when reading a non-existent key', async () => {
    expect(await storage.read('missing')).toBeNull();
  });

  it('returns null when reading inside a non-existent directory', async () => {
    // Distinct from "file missing in existing directory" — exercises the
    // walk-with-create=false short-circuit.
    expect(await storage.read('saves/slot-1/log.ndjson')).toBeNull();
  });

  it('round-trips bytes through write and read', async () => {
    const payload = new TextEncoder().encode('hello, world');
    await storage.write('greeting', payload);
    const out = await storage.read('greeting');
    expect(out).not.toBeNull();
    expect(new TextDecoder().decode(out!)).toBe('hello, world');
  });

  it('overwrites on repeated write', async () => {
    await storage.write('k', new TextEncoder().encode('first'));
    await storage.write('k', new TextEncoder().encode('second'));
    const out = await storage.read('k');
    expect(new TextDecoder().decode(out!)).toBe('second');
  });

  it('overwrite truncates: a shorter payload does not retain old tail', async () => {
    await storage.write('k', new TextEncoder().encode('aaaaaaaaaa'));
    await storage.write('k', new TextEncoder().encode('bb'));
    const out = await storage.read('k');
    expect(new TextDecoder().decode(out!)).toBe('bb');
  });

  it('appends to existing content', async () => {
    await storage.write('log', new TextEncoder().encode('a\n'));
    await storage.append('log', new TextEncoder().encode('b\n'));
    await storage.append('log', new TextEncoder().encode('c\n'));
    const out = await storage.read('log');
    expect(new TextDecoder().decode(out!)).toBe('a\nb\nc\n');
  });

  it('append creates the file if missing', async () => {
    await storage.append('fresh', new TextEncoder().encode('first line\n'));
    const out = await storage.read('fresh');
    expect(new TextDecoder().decode(out!)).toBe('first line\n');
  });

  it('write creates intermediate directories for nested keys', async () => {
    await storage.write('saves/slot-1/log.ndjson', new TextEncoder().encode('x'));
    expect(await storage.exists('saves/slot-1/log.ndjson')).toBe(true);
  });

  it('append creates intermediate directories for nested keys', async () => {
    await storage.append('saves/slot-2/log.ndjson', new TextEncoder().encode('x'));
    expect(await storage.exists('saves/slot-2/log.ndjson')).toBe(true);
  });

  it('delete is idempotent on missing keys', async () => {
    await expect(storage.delete('was-never-here')).resolves.toBeUndefined();
  });

  it('delete is idempotent when the parent directory does not exist', async () => {
    await expect(storage.delete('nope/also-nope')).resolves.toBeUndefined();
  });

  it('delete removes an existing key', async () => {
    await storage.write('temp', new TextEncoder().encode('x'));
    expect(await storage.exists('temp')).toBe(true);
    await storage.delete('temp');
    expect(await storage.exists('temp')).toBe(false);
  });

  it('rejects keys that escape the root', async () => {
    await expect(storage.write('../escape', new TextEncoder().encode('x'))).rejects.toThrow(
      /escapes root/,
    );
    await expect(
      storage.write('subdir/../../escape', new TextEncoder().encode('x')),
    ).rejects.toThrow(/escapes root/);
  });

  it('rejects absolute-style keys', async () => {
    await expect(storage.write('/absolute', new TextEncoder().encode('x'))).rejects.toThrow(
      /escapes root/,
    );
  });

  it('rejects empty and NUL-terminator keys', async () => {
    await expect(storage.write('', new TextEncoder().encode('x'))).rejects.toThrow(/invalid key/);
    await expect(storage.write('a\0b', new TextEncoder().encode('x'))).rejects.toThrow(
      /invalid key/,
    );
  });

  it('rejects keys with empty path segments', async () => {
    // `a//b` and `a/` both contain an empty segment after split.
    await expect(storage.write('a//b', new TextEncoder().encode('x'))).rejects.toThrow(
      /invalid key/,
    );
    await expect(storage.write('a/', new TextEncoder().encode('x'))).rejects.toThrow(/invalid key/);
  });

  it('exists returns false for missing keys, true for present', async () => {
    expect(await storage.exists('nope')).toBe(false);
    await storage.write('yep', new TextEncoder().encode('x'));
    expect(await storage.exists('yep')).toBe(true);
  });

  it('exists returns false when the parent directory is missing', async () => {
    expect(await storage.exists('nope/also-nope')).toBe(false);
  });

  it('pathFor returns the normalised key (no IO performed)', () => {
    expect(storage.pathFor('saves/run-42')).toBe('saves/run-42');
  });

  it('pathFor includes the configured root subdirectory when set', () => {
    const scoped = new OPFSStorage({ root: 'bobivolve' });
    expect(scoped.pathFor('saves/run-42')).toBe('bobivolve/saves/run-42');
  });

  it('joinKey concatenates non-empty parts with /', () => {
    expect(OPFSStorage.joinKey('saves', 'slot-1', 'log.ndjson')).toBe('saves/slot-1/log.ndjson');
    expect(OPFSStorage.joinKey('saves', '', 'log')).toBe('saves/log');
  });

  describe('with a configured sub-root', () => {
    let scoped: OPFSStorage;
    beforeEach(() => {
      scoped = new OPFSStorage({ root: 'bobivolve' });
    });

    it('reads and writes are isolated from the origin root', async () => {
      await scoped.write('a', new TextEncoder().encode('inside'));
      // The origin-root storage instance must not see a key written under
      // the sub-root.
      expect(await storage.read('a')).toBeNull();
      // But it should see the sub-root's directory entry.
      expect(await storage.exists('bobivolve/a')).toBe(true);
      expect(new TextDecoder().decode((await scoped.read('a'))!)).toBe('inside');
    });
  });
});
