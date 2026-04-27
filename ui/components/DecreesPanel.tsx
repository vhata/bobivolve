// DecreesPanel — surfaces the player's queued conditional patches.
//
// Polls the host's decreeQueue every 1.5s and renders each decree with
// its trigger description, patch target, and a Revoke button. Empty
// states say so.

import { useEffect, useState } from 'react';
import type { DecreeQueueEntry, DecreeQueueResult } from '../../protocol/types.js';
import { useSimStore } from '../sim-store.js';

const REFRESH_INTERVAL_MS = 1500;

function describeTrigger(entry: DecreeQueueEntry, lineageName: (id: string) => string): string {
  switch (entry.trigger.kind) {
    case 'populationBelow':
      return `${lineageName(entry.trigger.lineageId)} population < ${entry.trigger.threshold}`;
  }
}

export function DecreesPanel(): React.JSX.Element {
  const transport = useSimStore((s) => s.transport);
  const lineages = useSimStore((s) => s.lineages);
  const revokeDecree = useSimStore((s) => s.revokeDecree);

  const [decrees, setDecrees] = useState<readonly DecreeQueueEntry[]>([]);

  useEffect(() => {
    if (transport === null) return;
    let cancelled = false;
    const fetch = async (): Promise<void> => {
      try {
        const result = (await transport.query({
          kind: 'decreeQueue',
          queryId: '',
        })) as DecreeQueueResult & { queryId: string };
        if (cancelled) return;
        setDecrees(result.decrees);
      } catch {
        // Swallow — leave the previous list visible until the next poll
        // succeeds. A panic display would dominate the panel.
      }
    };
    void fetch();
    const handle = setInterval(() => {
      void fetch();
    }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [transport]);

  const lineageName = (id: string): string => {
    const lineage = lineages.get(id);
    return lineage?.name ?? id;
  };

  return (
    <section className="panel decrees-panel">
      <header className="panel-header">
        <h2>Decrees</h2>
        <span className="panel-meta">{decrees.length.toString()} queued</span>
      </header>
      <div className="panel-body">
        {decrees.length === 0 ? (
          <p className="panel-empty">no queued decrees</p>
        ) : (
          <ul className="decree-list">
            {decrees.map((d) => (
              <li key={d.id} className="decree-row">
                <div className="decree-row-trigger">when {describeTrigger(d, lineageName)}</div>
                <div className="decree-row-patch">patch {lineageName(d.patchTargetLineageId)}</div>
                <button
                  type="button"
                  className="decree-revoke"
                  onClick={() => {
                    revokeDecree(d.id);
                  }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
