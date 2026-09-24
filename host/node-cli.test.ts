import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('CLI run recovery', () => {
  let root: string;
  let io: CapturedIO;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-cli-resume-'));
    io = captureProcessIo();
  });
  afterEach(() => {
    io.restore();
    rmSync(root, { recursive: true, force: true });
  });
  function persistentArgs(ticks: string): string[] {
    return ['--ticks', ticks, '--no-heartbeat', '--save-dir', root, '--run-id', 'default'];
  }
  function domainEvents(output: string): string[] {
    return output
      .trim()
      .split('\n')
      .filter((line) => {
        const event = JSON.parse(line) as { kind: string };
        return event.kind !== 'commandAck';
      });
  }

  it('continues a logged run without a named save and matches uninterrupted events', async () => {
    expect(await runCli(['--seed', '42', ...persistentArgs('75')])).toBe(0);
    expect(existsSync(join(root, 'saves', 'default.save'))).toBe(false);
    const first = domainEvents(io.stdout);
    io.stdout = '';
    expect(await runCli(['--resume', ...persistentArgs('150')])).toBe(0);
    const resumed = domainEvents(io.stdout);
    io.stdout = '';
    expect(await runCli(['--seed', '42', '--ticks', '150', '--no-heartbeat'])).toBe(0);
    expect([...first, ...resumed]).toEqual(domainEvents(io.stdout));
    expect(io.stderr).toBe('');
  });

  it('records quiet endpoints and resumes repeatedly at the exact tick', async () => {
    expect(await runCli(['--seed', '42', ...persistentArgs('1')])).toBe(0);
    io.stdout = '';
    expect(await runCli(['--resume', ...persistentArgs('2')])).toBe(0);
    expect(io.stdout).toContain('"simTick":"1"');
    io.stdout = '';
    expect(await runCli(['--resume', ...persistentArgs('2')])).toBe(0);
    expect(io.stdout).toContain('"simTick":"2"');
    expect(io.stderr).toBe('');
  });

  it('fails for a missing run instead of returning success without advancing', async () => {
    expect(await runCli(['--resume', ...persistentArgs('10')])).toBe(1);
    expect(io.stderr).toContain('no persisted run');
    expect(existsSync(join(root, 'runs'))).toBe(false);
  });

  it('rejects a resume target before the persisted endpoint', async () => {
    expect(await runCli(['--seed', '42', ...persistentArgs('10')])).toBe(0);
    expect(await runCli(['--resume', ...persistentArgs('5')])).toBe(1);
    expect(io.stderr).toContain('precedes persisted tick 10');
  });

  it('returns failure when a corrupt run cannot acknowledge restoration', async () => {
    expect(await runCli(['--seed', '42', ...persistentArgs('10')])).toBe(0);
    const logPath = join(root, 'runs', 'default', 'log.ndjson');
    writeFileSync(logPath, '{bad json\n');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runCli(['--resume', ...persistentArgs('20')])).toBe(1);
      expect(io.stderr).toContain('cannot resume:');
      expect(io.stdout).toContain('"kind":"commandError"');
      expect(readFileSync(logPath, 'utf8')).toBe('{bad json\n');
    } finally {
      diagnostic.mockRestore();
    }
  });

  it.each(['-1', '0x10', '18446744073709551616', ''])(
    'rejects non-uint64 tick input %s',
    async (ticks) => {
      expect(await runCli(['--seed', '42', `--ticks=${ticks}`])).toBe(2);
      expect(io.stderr).toContain('decimal uint64');
    },
  );

  it.each(['../escape', '', '.', '..', 'nested/run', 'nested\\run'])(
    'rejects invalid run id %s',
    async (runId) => {
      expect(
        await runCli(['--seed', '42', '--ticks', '1', '--save-dir', root, '--run-id', runId]),
      ).toBe(2);
      expect(io.stderr).toContain('--run-id');
    },
  );
});

describe('CLI intervention scripts', () => {
  let root: string;
  let io: CapturedIO;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bobivolve-script-'));
    io = captureProcessIo();
  });
  afterEach(() => {
    io.restore();
    rmSync(root, { recursive: true, force: true });
  });
  function script(value: unknown): string {
    const path = join(root, 'script.json');
    writeFileSync(
      path,
      JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    return path;
  }

  it('matches the transport-driven intervention fixture event for event', async () => {
    const { INTERVENTIONS } = await import('../test/determinism/interventions.js');
    const { runDeterministically, serializeEvents } = await import('../test/determinism/runner.js');
    const expected = serializeEvents(
      runDeterministically({ seed: 42n, ticks: 300n, commands: INTERVENTIONS }),
    )
      .split('\n')
      .slice(1)
      .join('\n');
    expect(
      await runCli([
        '--seed',
        '42',
        '--ticks',
        '300',
        '--no-heartbeat',
        '--commands',
        script(INTERVENTIONS),
      ]),
    ).toBe(0);
    expect(io.stdout.split('\n').slice(1).join('\n')).toBe(expected);
    expect(io.stderr).toBe('');
  });

  it('rejects malformed scripts before resetting existing persisted history', async () => {
    const args = [
      '--seed',
      '42',
      '--ticks',
      '5',
      '--no-heartbeat',
      '--save-dir',
      root,
      '--run-id',
      'run',
    ];
    expect(await runCli(args)).toBe(0);
    const path = join(root, 'runs/run/log.ndjson');
    const before = readFileSync(path, 'utf8');
    expect(
      await runCli([...args, '--commands', script([{ tick: '0', command: { kind: 'load' } }])]),
    ).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('stops after a rejected intervention without executing later commands', async () => {
    const path = script([
      { tick: '0', command: { kind: 'quarantine', commandId: 'missing', lineageId: 'L999' } },
      { tick: '1', command: { kind: 'quarantine', commandId: 'later', lineageId: 'L0' } },
    ]);
    expect(
      await runCli(['--seed', '42', '--ticks', '5', '--no-heartbeat', '--commands', path]),
    ).toBe(1);
    expect(io.stderr).toContain('unknown lineage');
    expect(io.stdout).not.toContain('later');
  });

  it('resumes with continuation-only scripts and rejects already-completed ticks', async () => {
    const { INTERVENTIONS } = await import('../test/determinism/interventions.js');
    const common = ['--no-heartbeat', '--save-dir', root, '--run-id', 'run'];
    expect(
      await runCli([
        '--seed',
        '42',
        '--ticks',
        '20',
        ...common,
        '--commands',
        script(INTERVENTIONS.slice(0, 2)),
      ]),
    ).toBe(0);
    const first = io.stdout;
    io.stdout = '';
    expect(
      await runCli([
        '--resume',
        '--ticks',
        '300',
        ...common,
        '--commands',
        script(INTERVENTIONS.slice(2)),
      ]),
    ).toBe(0);
    const combined = first + io.stdout;
    io.stdout = '';
    expect(
      await runCli([
        '--seed',
        '42',
        '--ticks',
        '300',
        '--no-heartbeat',
        '--commands',
        script(INTERVENTIONS),
      ]),
    ).toBe(0);
    const domain = (output: string): string[] =>
      output
        .trim()
        .split('\n')
        .filter((line) => (JSON.parse(line) as { kind: string }).kind !== 'commandAck');
    expect(domain(combined)).toEqual(domain(io.stdout));
    expect(
      await runCli(['--resume', '--ticks', '400', ...common, '--commands', script(INTERVENTIONS)]),
    ).toBe(1);
    expect(io.stderr).toContain('continuation-only');
  });
});
