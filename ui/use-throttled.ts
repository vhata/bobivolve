// useThrottled — mirror an upstream value into local state, but only
// update the mirror at most once per intervalMs. The component
// re-renders when the mirror updates, not on every upstream change.
//
// Use case: the sim store updates `populationByLineage` and
// `populationHistory` on every heartbeat (a fresh Map / array
// reference each time), so any useMemo that depends on them
// invalidates at heartbeat rate. Wrapping these in `useThrottled` lets
// expensive panels (lineage tree, phylogeny) recompute on a slower
// cadence than the heartbeat without distorting the values.

import { useEffect, useRef, useState } from 'react';

export function useThrottled<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState<T>(value);
  const lastUpdateRef = useRef<number>(0);
  const latestValueRef = useRef<T>(value);
  latestValueRef.current = value;
  useEffect(() => {
    const now = performance.now();
    const elapsed = now - lastUpdateRef.current;
    if (elapsed >= intervalMs) {
      setThrottled(value);
      lastUpdateRef.current = now;
      return;
    }
    const handle = setTimeout(() => {
      setThrottled(latestValueRef.current);
      lastUpdateRef.current = performance.now();
    }, intervalMs - elapsed);
    return () => {
      clearTimeout(handle);
    };
  }, [value, intervalMs]);
  return throttled;
}
