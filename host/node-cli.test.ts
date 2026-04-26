import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './node-cli.js';

// CLI smoke tests. The CLI itself is a thin wrapper around NodeTransport;
// these tests verify argument parsing, NDJSON emission, and the exit-code
// contract — the surface that breaks first if the wiring shifts.

interface CapturedIO {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureProcessIo(): CapturedIO {
  const captured: CapturedIO = {
    stdout: '',
    stderr: '',
    restore: () => undefined,
  };
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    captured.stdout += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    captured.stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  });
  captured.restore = () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  };
  return captured;
}

describe('node-cli', () => {
  let io: CapturedIO;
  beforeEach(() => {
    io = captureProcessIo();
  });
  afterEach(() => {
    io.restore();
  });

  it('emits NDJSON SimEvents for --seed 42 --ticks 100 --no-heartbeat', async () => {
    const code = await runCli(['--seed', '42', '--ticks', '100', '--no-heartbeat']);
    expect(code).toBe(0);
    const lines = io.stdout
      .trimEnd()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { kind: string; simTick: string };
      expect(typeof parsed.kind).toBe('string');
      // bigints are encoded as decimal strings (proto3 JSON convention).
      expect(typeof parsed.simTick).toBe('string');
      // Heartbeat suppressed via --no-heartbeat.
      expect(parsed.kind).not.toBe('tick');
    }
  });

  it('emits a final tick heartbeat without --no-heartbeat', async () => {
    const code = await runCli(['--seed', '42', '--ticks', '50']);
    expect(code).toBe(0);
    const lines = io.stdout
      .trimEnd()
      .split('\n')
      .filter((l) => l.length > 0);
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toContain('tick');
  });

  it('exits 2 with a stderr message when --seed is missing', async () => {
    const code = await runCli(['--ticks', '10']);
    expect(code).toBe(2);
    expect(io.stderr).toMatch(/seed/);
  });

  it('exits 2 when --ticks is not a decimal integer', async () => {
    const code = await runCli(['--seed', '42', '--ticks', 'banana']);
    expect(code).toBe(2);
    expect(io.stderr).toMatch(/ticks/);
  });

  it('two invocations with the same seed produce identical NDJSON output', async () => {
    const args = ['--seed', '42', '--ticks', '100', '--no-heartbeat'];
    const a = captureProcessIo();
    const codeA = await runCli(args);
    const stdoutA = a.stdout;
    a.restore();

    const b = captureProcessIo();
    const codeB = await runCli(args);
    const stdoutB = b.stdout;
    b.restore();

    // Re-restore the outer io.restore so the afterEach cleanup is a no-op.
    io.restore = () => undefined;

    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    expect(stdoutA).toBe(stdoutB);
  });

  // ── persistence flags ────────────────────────────────────────────────────

  it('exits 2 when --save-dir is given without --run-id', async () => {
    const code = await runCli(['--seed', '42', '--ticks', '10', '--save-dir', '/tmp/whatever']);
    expect(code).toBe(2);
    expect(io.stderr).toMatch(/run-id/);
  });

  it('exits 2 when --resume is given without --save-dir', async () => {
    const code = await runCli(['--ticks', '10', '--resume']);
    expect(code).toBe(2);
    expect(io.stderr).toMatch(/resume requires/);
  });

  it('exits 2 when --seed and --resume are both given', async () => {
    const code = await runCli([
      '--seed',
      '42',
      '--ticks',
      '10',
      '--resume',
      '--save-dir',
      '/tmp/whatever',
      '--run-id',
      'foo',
    ]);
    expect(code).toBe(2);
    expect(io.stderr).toMatch(/mutually exclusive/);
  });

  it('writes a log file under save-dir when --save-dir + --run-id are given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bobivolve-cli-'));
    try {
      const code = await runCli([
        '--seed',
        '42',
        '--ticks',
        '500',
        '--no-heartbeat',
        '--save-dir',
        dir,
        '--run-id',
        'cli-run',
      ]);
      expect(code).toBe(0);
      expect(existsSync(join(dir, 'runs', 'cli-run', 'log.ndjson'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
