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
});
