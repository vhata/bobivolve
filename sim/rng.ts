// xoshiro256** PRNG, seeded via splitmix64.
//
// Determinism is the contract here, not speed: every implementation of the
// sim, present and future (the Rust port included), must produce byte-for-byte
// identical sequences from the same seed. See ARCHITECTURE.md.
//
// References:
//   xoshiro256**: https://prng.di.unimi.it/xoshiro256starstar.c
//   splitmix64:   https://prng.di.unimi.it/splitmix64.c

const MASK64 = 0xffffffffffffffffn;

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (64n - k))) & MASK64;
}

export type Xoshiro256State = readonly [bigint, bigint, bigint, bigint];

export class Xoshiro256ss {
  private s0: bigint;
  private s1: bigint;
  private s2: bigint;
  private s3: bigint;

  private constructor(state: Xoshiro256State) {
    if (state[0] === 0n && state[1] === 0n && state[2] === 0n && state[3] === 0n) {
      throw new Error('xoshiro256** state must not be all zero');
    }
    this.s0 = state[0] & MASK64;
    this.s1 = state[1] & MASK64;
    this.s2 = state[2] & MASK64;
    this.s3 = state[3] & MASK64;
  }

  static fromSeed(seed: bigint): Xoshiro256ss {
    return new Xoshiro256ss(splitmix64Expand(seed));
  }

  static fromState(state: Xoshiro256State): Xoshiro256ss {
    return new Xoshiro256ss(state);
  }

  state(): Xoshiro256State {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  nextU64(): bigint {
    const result = (rotl((this.s1 * 5n) & MASK64, 7n) * 9n) & MASK64;
    const t = (this.s1 << 17n) & MASK64;

    this.s2 = (this.s2 ^ this.s0) & MASK64;
    this.s3 = (this.s3 ^ this.s1) & MASK64;
    this.s1 = (this.s1 ^ this.s2) & MASK64;
    this.s0 = (this.s0 ^ this.s3) & MASK64;

    this.s2 = (this.s2 ^ t) & MASK64;
    this.s3 = rotl(this.s3, 45n);

    return result;
  }
}

// SplitMix64. Used to expand a single u64 seed into four u64s of state for
// xoshiro256**, as recommended by the algorithm's authors.
export function splitmix64Expand(seed: bigint): Xoshiro256State {
  let x = seed & MASK64;
  const next = (): bigint => {
    x = (x + 0x9e3779b97f4a7c15n) & MASK64;
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  };
  return [next(), next(), next(), next()];
}
