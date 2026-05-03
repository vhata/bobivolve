import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeStorage } from './storage-node.js';

describe('NodeStorage', () => {
  let root: string;
  let storage: NodeStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-storage-'));
    storage = new NodeStorage({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null when reading a non-existent key', async () => {
    expect(await storage.read('missing')).toBeNull();
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

  it('delete is idempotent on missing keys', async () => {
    await expect(storage.delete('was-never-here')).resolves.toBeUndefined();
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

  it('rejects empty and null-terminator keys', async () => {
    await expect(storage.write('', new TextEncoder().encode('x'))).rejects.toThrow(/invalid key/);
    await expect(storage.write('a\0b', new TextEncoder().encode('x'))).rejects.toThrow(
      /invalid key/,
    );
  });

  it('exists returns false for missing keys, true for present', async () => {
    expect(await storage.exists('nope')).toBe(false);
    await storage.write('yep', new TextEncoder().encode('x'));
    expect(await storage.exists('yep')).toBe(true);
  });

  it('pathFor reports the absolute resolved path without IO', () => {
    const p = storage.pathFor('saves/run-42');
    expect(p.startsWith(root)).toBe(true);
    expect(p.endsWith(join('saves', 'run-42'))).toBe(true);
  });

  describe('reapDirectory', () => {
    it('returns 0 on a missing directory (idempotent on never-existed slot)', async () => {
      expect(await storage.reapDirectory('runs/no-such-run/snapshots')).toBe(0);
    });

    it('returns 0 on an empty directory', async () => {
      // Force the directory into existence by writing a file then deleting
      // it — leaves the parent dir behind.
      await storage.write('runs/empty-run/snapshots/0.snap', new TextEncoder().encode('x'));
      await storage.delete('runs/empty-run/snapshots/0.snap');
      expect(await storage.reapDirectory('runs/empty-run/snapshots')).toBe(0);
    });

    it('removes every file in the target directory and reports the count', async () => {
      await storage.write('runs/r/snapshots/0.snap', new TextEncoder().encode('a'));
      await storage.write('runs/r/snapshots/500.snap', new TextEncoder().encode('b'));
      await storage.write('runs/r/snapshots/1000.snap', new TextEncoder().encode('c'));

      const reaped = await storage.reapDirectory('runs/r/snapshots');
      expect(reaped).toBe(3);
      expect(await storage.exists('runs/r/snapshots/0.snap')).toBe(false);
      expect(await storage.exists('runs/r/snapshots/500.snap')).toBe(false);
      expect(await storage.exists('runs/r/snapshots/1000.snap')).toBe(false);
    });

    it('does not touch siblings outside the target directory', async () => {
      await storage.write('runs/r/snapshots/0.snap', new TextEncoder().encode('a'));
      await storage.write('runs/r/log.ndjson', new TextEncoder().encode('log'));
      await storage.write('runs/other/snapshots/0.snap', new TextEncoder().encode('other'));

      await storage.reapDirectory('runs/r/snapshots');

      expect(await storage.exists('runs/r/log.ndjson')).toBe(true);
      expect(await storage.exists('runs/other/snapshots/0.snap')).toBe(true);
    });

    it('skips sub-directories — only flat files are reaped', async () => {
      await storage.write('runs/r/snapshots/0.snap', new TextEncoder().encode('a'));
      // Force a sub-directory to exist alongside the snap files.
      await storage.write('runs/r/snapshots/nested/inner', new TextEncoder().encode('x'));

      const reaped = await storage.reapDirectory('runs/r/snapshots');
      expect(reaped).toBe(1);
      expect(await storage.exists('runs/r/snapshots/0.snap')).toBe(false);
      expect(await storage.exists('runs/r/snapshots/nested/inner')).toBe(true);
    });

    it('is idempotent on a second call', async () => {
      await storage.write('runs/r/snapshots/0.snap', new TextEncoder().encode('a'));
      expect(await storage.reapDirectory('runs/r/snapshots')).toBe(1);
      expect(await storage.reapDirectory('runs/r/snapshots')).toBe(0);
    });
  });

  describe('listEntries', () => {
    it('returns [] on a missing directory', async () => {
      expect(await storage.listEntries('runs')).toEqual([]);
    });

    it('lists immediate children with kind discrimination', async () => {
      await storage.write('runs/alpha/log.ndjson', new TextEncoder().encode('a'));
      await storage.write('runs/alpha/snapshots/0.snap', new TextEncoder().encode('s'));
      await storage.write('runs/beta/log.ndjson', new TextEncoder().encode('b'));

      const entries = await storage.listEntries('runs');
      const byName = new Map(entries.map((e) => [e.name, e.kind]));
      expect(byName.get('alpha')).toBe('directory');
      expect(byName.get('beta')).toBe('directory');
      // The runs directory itself contains only sub-directories at this
      // layout level — no stray files should appear.
      for (const e of entries) {
        expect(e.kind).toBe('directory');
      }
    });
  });

  describe('getMtimeMs', () => {
    it('returns null on a missing key', async () => {
      expect(await storage.getMtimeMs('runs/no-such/log.ndjson')).toBe(null);
    });

    it('returns the file mtime in millis since epoch', async () => {
      const before = Date.now();
      await storage.write('runs/r/log.ndjson', new TextEncoder().encode('hello'));
      const after = Date.now();
      const mtime = await storage.getMtimeMs('runs/r/log.ndjson');
      expect(mtime).not.toBe(null);
      // Allow a 1s slack on either side to avoid CI clock-skew flake.
      expect(mtime!).toBeGreaterThanOrEqual(before - 1000);
      expect(mtime!).toBeLessThanOrEqual(after + 1000);
    });
  });

  describe('removeDirectory', () => {
    it('is idempotent on a missing directory', async () => {
      await expect(storage.removeDirectory('runs/no-such-run')).resolves.toBeUndefined();
    });

    it('recursively removes the directory and everything in it', async () => {
      await storage.write('runs/r/log.ndjson', new TextEncoder().encode('log'));
      await storage.write('runs/r/snapshots/0.snap', new TextEncoder().encode('s0'));
      await storage.write('runs/r/snapshots/500.snap', new TextEncoder().encode('s5'));
      await storage.write('runs/other/log.ndjson', new TextEncoder().encode('keep'));

      await storage.removeDirectory('runs/r');

      expect(await storage.exists('runs/r/log.ndjson')).toBe(false);
      expect(await storage.exists('runs/r/snapshots/0.snap')).toBe(false);
      expect(await storage.exists('runs/r/snapshots/500.snap')).toBe(false);
      // Sibling slot must remain.
      expect(await storage.exists('runs/other/log.ndjson')).toBe(true);
    });
  });
});
