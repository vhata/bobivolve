import type { DirectiveSpec, DriftTelemetry } from '../../protocol/types.js';
import { formatMovementAttemptChance } from '../firmware-format.js';

function describe(directive: DirectiveSpec | undefined): string {
  if (directive === undefined) return '—';
  switch (directive.kind) {
    case 'gather':
      return `Gather ${directive.params['rate'] ?? '?'} energy/tick maximum`;
    case 'explore': {
      const threshold = directive.params['threshold'] ?? '0';
      return `Explore ${formatMovementAttemptChance(threshold) ?? '?'} per tick (threshold ${threshold})`;
    }
    case 'replicate':
      return `Replicate at ≥ ${directive.params['threshold'] ?? '?'} energy`;
    default:
      return directive.kind;
  }
}

export function PatchProvenance({
  drift,
}: {
  readonly drift: DriftTelemetry;
}): React.JSX.Element | null {
  if (drift.patches.length === 0) return null;
  return (
    <section className="patch-provenance" aria-label="Patch provenance">
      <h3 className="subhead">Patch ancestry and current firmware</h3>
      <p>
        Patch ancestry survives mutation and replacement patches. Saturation counts ancestry above
        50% of the population, not retained firmware.
      </p>
      {drift.patchProvenance === undefined ? (
        <p>Patch details unavailable from this host.</p>
      ) : (
        drift.patchProvenance.map((patch) => (
          <details key={patch.patchId}>
            <summary>
              {patch.patchId} · {patch.ancestryPopulation} living ancestry carriers ·{' '}
              {patch.exactMatchPopulation === null
                ? 'exact matches unknown'
                : `${patch.exactMatchPopulation} exact matches`}
            </summary>
            <p>
              Applied to {patch.targetLineageId} at tick {patch.appliedAtTick}. Counts cover living
              probes in all lineages carrying this patch ancestry, including this lineage.
            </p>
            {patch.authoredFirmware === null ? (
              <p>
                Authored firmware was not recorded in this older save. Exact matches and reference
                comparison are unavailable.
              </p>
            ) : (
              <>
                <p>
                  This lineage: {patch.selectedExactMatchPopulation} of{' '}
                  {drift.population.toString()} living probes match the entire authored firmware
                  exactly. Its current reference{' '}
                  {patch.referenceMatches === true ? 'matches' : 'differs from'} this patch.
                </p>
                <p>
                  Exact matches include directive order and every encoded value; they do not
                  establish equivalent behaviour in different environments.
                </p>
                <table className="patch-firmware-comparison">
                  <caption>
                    Ordered firmware: authored patch versus current lineage reference
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Position</th>
                      <th scope="col">Authored patch</th>
                      <th scope="col">Current reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(
                      {
                        length: Math.max(
                          patch.authoredFirmware.length,
                          drift.referenceFirmware.length,
                        ),
                      },
                      (_, index) => (
                        <tr key={index}>
                          <th scope="row">{index + 1}</th>
                          <td>{describe(patch.authoredFirmware?.[index])}</td>
                          <td>{describe(drift.referenceFirmware[index])}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </>
            )}
          </details>
        ))
      )}
    </section>
  );
}
