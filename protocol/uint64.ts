// Decimal uint64 values cross the protocol as strings so JSON transports
// retain their full precision. Keep parsing rules shared by host and UI.
export const U64_MAX = (1n << 64n) - 1n;

export function parseUint64Decimal(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    const value = BigInt(raw);
    return value <= U64_MAX ? value : null;
  } catch {
    return null;
  }
}
