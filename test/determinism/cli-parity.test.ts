import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isEntrypoint } from '../../host/node-cli.js';
import { serializeCommandScript } from './interventions.js';
import {
  CLI_NEW_RUN_COMMAND_ID,
  GOLDEN_CASES,
  GOLDEN_DIR,
  RUNNER_NEW_RUN_COMMAND_ID,
  type GoldenCase,
} from './runner.js';

// Runs the real headless CLI as a child process and compares its stdout
// with the checked-in goldens. The only permitted difference is the newRun
// command ID on the first line (see runner.ts). Everything after that line
// must match byte for byte.

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIM_SCRIPT = join(REPO_ROOT, 'scripts', 'sim.sh');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_TIMEOUT_MS = 120_000;

function newRunAck(commandId: string): string {
  return `{"kind":"commandAck","simTick":"0","commandId":"${commandId}"}\n`;
}

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
}

async function run(file: string, args: readonly string[]): Promise<CliResult> {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: CLI_TIMEOUT_MS,
  });
  return { stdout, stderr };
}

function cliArgs(spec: GoldenCase, scriptDir: string): string[] {
  const args = ['--seed', spec.seed.toString(), '--ticks', spec.ticks.toString(), '--no-heartbeat'];
  if (spec.commands !== undefined) {
    const path = join(scriptDir, `${spec.name}.commands.json`);
    writeFileSync(path, serializeCommandScript(spec.commands));
    args.push('--commands', path);
  }
  return args;
}

// Splits into lines that keep their trailing "\n", so a truncated stream
// ends early instead of leaving an empty last element, and a missing final
// newline still counts as a difference.
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// First differing line, numbered as in the golden file (the ack is line 1),
// so a mismatch reports something readable instead of a multi-megabyte
// string diff.
function firstDifference(
  actual: string,
  expected: string,
): { goldenLine: number; actual: string; expected: string } | null {
  if (actual === expected) return null;
  const a = linesOf(actual);
  const e = linesOf(expected);
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      return {
        goldenLine: i + 2,
        actual: a[i] ?? '<end of output>',
        expected: e[i] ?? '<end of golden>',
      };
    }
  }
  return { goldenLine: 0, actual, expected };
}

function expectMatchesGolden(stdout: string, spec: GoldenCase): void {
  const golden = readFileSync(join(GOLDEN_DIR, `${spec.name}.ndjson`), 'utf8');
  const goldenAck = newRunAck(RUNNER_NEW_RUN_COMMAND_ID);
  const cliAck = newRunAck(CLI_NEW_RUN_COMMAND_ID);
  expect(golden.startsWith(goldenAck)).toBe(true);
  expect(stdout.slice(0, cliAck.length)).toBe(cliAck);
  const goldenBody = golden.slice(goldenAck.length);
  // Guards against a golden, or CLI output, that holds only the ack line.
  expect(goldenBody.length).toBeGreaterThan(0);
  expect(firstDifference(stdout.slice(cliAck.length), goldenBody)).toBeNull();
}

describe('CLI output matches the determinism goldens', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'bobivolve-cli-parity-'));
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each(GOLDEN_CASES)(
    'scripts/sim.sh reproduces $name',
    async (spec) => {
      const { stdout } = await run('bash', [SIM_SCRIPT, ...cliArgs(spec, scratch)]);
      expectMatchesGolden(stdout, spec);
    },
    CLI_TIMEOUT_MS,
  );

  // import.meta.url names the symlink-resolved file; process.argv[1] is the
  // raw path given to Node. A naive string comparison made the CLI exit 0
  // without running anything here. The realpath has no space or percent
  // sign; isEntrypoint's own tests below cover encoded real paths.
  it(
    'runs when invoked through a symlink whose path contains a space and a percent sign',
    async () => {
      const parent = join(scratch, 'checkout with space %20');
      const link = join(parent, 'repo');
      mkdirSync(parent);
      symlinkSync(REPO_ROOT, link, 'dir');
      const spec = GOLDEN_CASES.find((c) => c.name === 'seed-0-ticks-1000');
      if (spec === undefined) throw new Error('seed-0-ticks-1000 golden case is missing');
      const { stdout } = await run(process.execPath, [
        TSX_CLI,
        join(link, 'host', 'node-cli.ts'),
        ...cliArgs(spec, scratch),
      ]);
      expectMatchesGolden(stdout, spec);
    },
    CLI_TIMEOUT_MS,
  );
});

describe('isEntrypoint', () => {
  let scratch: string;
  let script: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'bobivolve-entrypoint-'));
    // A real directory whose name needs URL encoding, so the realpath itself
    // contains a space and a literal "%20".
    const dir = join(scratch, 'a b%20');
    mkdirSync(dir);
    script = join(dir, 'cli.ts');
    writeFileSync(script, '');
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('matches a script whose real path contains a space and a percent sign', () => {
    const url = pathToFileURL(script).href;
    expect(url).toContain('a%20b%2520');
    expect(isEntrypoint(url, script)).toBe(true);
  });

  it('matches the same script reached through a symlink', () => {
    const link = join(scratch, 'link to a b%20');
    symlinkSync(dirname(script), link, 'dir');
    expect(isEntrypoint(pathToFileURL(script).href, join(link, 'cli.ts'))).toBe(true);
  });

  it('rejects a different script, a missing path, and no script', () => {
    const other = join(dirname(script), 'other.ts');
    writeFileSync(other, '');
    const url = pathToFileURL(script).href;
    expect(isEntrypoint(url, other)).toBe(false);
    expect(isEntrypoint(url, join(scratch, 'missing.ts'))).toBe(false);
    expect(isEntrypoint(url, undefined)).toBe(false);
  });
});

describe('firstDifference', () => {
  it('reports the end of a truncated stream rather than an empty line', () => {
    expect(firstDifference('a\n', 'a\nb\n')).toEqual({
      goldenLine: 3,
      actual: '<end of output>',
      expected: 'b\n',
    });
  });

  it('reports a missing final newline', () => {
    expect(firstDifference('a\nb', 'a\nb\n')).toEqual({
      goldenLine: 3,
      actual: 'b',
      expected: 'b\n',
    });
  });
});
