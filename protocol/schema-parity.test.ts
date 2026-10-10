// Parity between `protocol/schema.proto` and `protocol/types.ts`.
//
// Codegen is deferred, so the schema is maintained by hand. This test walks
// a fully populated sample of every message kind (`test-samples.ts`, which
// the type checker keeps exhaustive against `types.ts`) through a minimal
// parse of the schema, and fails when a kind, a field, or a field's broad
// type differs between the two.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_SAMPLES,
  EVENT_SAMPLES,
  QUERY_RESULT_SAMPLES,
  QUERY_SAMPLES,
} from './test-samples.js';

interface ProtoField {
  readonly jsonName: string;
  readonly type: string;
  // Value type when the field is a map<string, V>.
  readonly mapValue: string | null;
  readonly repeated: boolean;
  readonly optional: boolean;
  readonly inOneof: boolean;
}

function camel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

// Top-level messages only; the schema has no nested message declarations.
function parseSchema(source: string): Map<string, readonly ProtoField[]> {
  const text = source.replace(/\/\/.*$/gm, '');
  const messages = new Map<string, readonly ProtoField[]>();
  const header = /\bmessage\s+(\w+)\s*\{/g;
  for (let match = header.exec(text); match !== null; match = header.exec(text)) {
    const name = match[1] as string;
    let depth = 1;
    let i = header.lastIndex;
    for (; depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    const body = text.slice(header.lastIndex, i - 1);
    const fields: ProtoField[] = [];
    let inOneof = false;
    for (const line of body.split('\n').map((l) => l.trim())) {
      if (/^oneof\s+\w+\s*\{$/.test(line)) inOneof = true;
      else if (line === '}') inOneof = false;
      const field =
        /^(optional\s+|repeated\s+)?(?:map<\s*\w+\s*,\s*(\w+)\s*>|(\w+))\s+(\w+)\s*=\s*\d+\s*;$/.exec(
          line,
        );
      if (field === null) continue;
      const mapValue = field[2] ?? null;
      fields.push({
        jsonName: camel(field[4] as string),
        type: mapValue === null ? (field[3] as string) : 'map',
        mapValue,
        repeated: field[1]?.trim() === 'repeated',
        optional: field[1]?.trim() === 'optional',
        inOneof,
      });
    }
    messages.set(name, fields);
    header.lastIndex = i;
  }
  return messages;
}

const schema = parseSchema(
  readFileSync(new URL('./schema.proto', import.meta.url), { encoding: 'utf8' }),
);

const SCALARS: Readonly<Record<string, readonly string[]>> = {
  bigint: ['uint64'],
  string: ['string'],
  boolean: ['bool'],
  number: ['uint32', 'double'],
};

function checkValue(value: unknown, type: string, path: string, errors: string[]): void {
  if (schema.has(type)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      checkMessage(value as Record<string, unknown>, type, path, errors);
    } else {
      errors.push(`${path}: TypeScript ${typeof value}, schema message ${type}`);
    }
    return;
  }
  const allowed = SCALARS[typeof value] ?? [];
  if (!allowed.includes(type)) {
    errors.push(`${path}: TypeScript ${typeof value}, schema ${type}`);
  }
}

function checkField(value: unknown, field: ProtoField, path: string, errors: string[]): void {
  if (value === null) {
    if (!field.optional && !schema.has(field.type)) {
      errors.push(`${path}: null in TypeScript but not optional in the schema`);
    }
    return;
  }
  if (field.mapValue !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      checkValue(entry, field.mapValue, `${path}.${key}`, errors);
    }
    return;
  }
  if (field.repeated) {
    if (!Array.isArray(value)) {
      errors.push(`${path}: repeated in the schema but not an array in TypeScript`);
      return;
    }
    value.forEach((item, i) => checkValue(item, field.type, `${path}[${i}]`, errors));
    return;
  }
  checkValue(value, field.type, path, errors);
}

// A TypeScript `kind` discriminant selects the schema oneof member whose
// JSON name equals it; that member's fields join the enclosing message's.
function checkMessage(
  value: Record<string, unknown>,
  name: string,
  path: string,
  errors: string[],
): void {
  const all = schema.get(name) ?? [];
  const fields = new Map(all.filter((f) => !f.inOneof).map((f) => [f.jsonName, f]));
  const oneofMembers = all.filter((f) => f.inOneof);
  let consumedKind = false;
  if (oneofMembers.length > 0) {
    const member = oneofMembers.find((f) => f.jsonName === value['kind']);
    if (member === undefined) {
      errors.push(`${path}: schema ${name} has no oneof member for kind ${String(value['kind'])}`);
      return;
    }
    consumedKind = true;
    for (const f of schema.get(member.type) ?? []) fields.set(f.jsonName, f);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'kind' && consumedKind) continue;
    const field = fields.get(key);
    if (field === undefined) {
      errors.push(`${path}.${key}: in TypeScript but missing from schema ${name}`);
      continue;
    }
    checkField(entry, field, `${path}.${key}`, errors);
  }
  for (const key of fields.keys()) {
    if (!(key in value)) errors.push(`${path}.${key}: in schema ${name} but not in TypeScript`);
  }
}

const ENVELOPES = [
  ['Command', COMMAND_SAMPLES],
  ['SimEvent', EVENT_SAMPLES],
  ['Query', QUERY_SAMPLES],
  ['QueryResult', QUERY_RESULT_SAMPLES],
] as const;

describe('schema.proto parity with protocol/types.ts', () => {
  it('parses the schema envelopes', () => {
    for (const [envelope] of ENVELOPES) {
      expect(schema.get(envelope)?.some((f) => f.inOneof)).toBe(true);
    }
  });

  it.each(ENVELOPES)('declares exactly the TypeScript %s kinds', (envelope, samples) => {
    const members = (schema.get(envelope) ?? []).filter((f) => f.inOneof).map((f) => f.jsonName);
    expect([...members].sort()).toStrictEqual(Object.keys(samples).sort());
  });

  it.each(ENVELOPES)('matches every %s field and its type', (envelope, samples) => {
    const errors: string[] = [];
    for (const [kind, sample] of Object.entries(samples)) {
      checkMessage(sample as Record<string, unknown>, envelope, `${envelope}<${kind}>`, errors);
    }
    expect(errors).toStrictEqual([]);
  });
});
