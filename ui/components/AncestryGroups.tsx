import { useMemo, useState } from 'react';
import { deriveAncestryGroups, MAX_ANCESTRY_GROUPS } from '../ancestry-groups.js';
import type { LineageNode } from '../sim-store.js';
import { useSimStore } from '../sim-store.js';
import { useThrottled } from '../use-throttled.js';

const MEMBERS_PER_PAGE = 20;

export function AncestryGroups(): React.JSX.Element {
  const ready = useSimStore((s) => s.ancestryPinsReady);
  const runId = useSimStore((s) => s.activeRunId);
  const error = useSimStore((s) => s.ancestryRestoreError);
  const retry = useSimStore((s) => s.rehydrateAfterLoad);
  return ready ? (
    <ReadyAncestryGroups key={runId} />
  ) : (
    <div className="ancestry-groups">
      {error === null ? (
        <p className="panel-empty">Restoring groups…</p>
      ) : (
        <>
          <p className="inspector-error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="lineage-action"
            onClick={() => {
              void retry();
            }}
          >
            Retry ancestry
          </button>
        </>
      )}
    </div>
  );
}

function ReadyAncestryGroups(): React.JSX.Element {
  const lineages = useSimStore((s) => s.lineages);
  const population = useSimStore((s) => s.populationByLineage);
  const pins = useSimStore((s) => s.ancestryPins);
  const storageError = useSimStore((s) => s.ancestryPinStorageError);
  const selectLineage = useSimStore((s) => s.selectLineage);
  const [selected, setSelected] = useState<string | null>(null);
  // Keep ancestry and population from the same sample; pin changes remain immediate.
  const sample = useThrottled(
    useMemo(() => ({ lineages, population }), [lineages, population]),
    750,
  );
  const result = useMemo(
    () => deriveAncestryGroups(sample.lineages, sample.population, pins),
    [sample, pins],
  );
  const selectedGroup = result.groups.find((group) => group.rootId === selected);
  const ungroupedSelected = selected === 'ungrouped';

  return (
    <section className="ancestry-groups" aria-label="Pinned ancestry groups">
      <div className="ancestry-heading">
        <h3 className="subhead">Pinned ancestry groups</h3>
        <span>
          {pins.length} / {MAX_ANCESTRY_GROUPS}
        </span>
      </div>
      <p className="ancestry-help">
        Follow a root and its descendants. Each probe counts under its nearest pinned ancestor;
        nested groups are excluded from their parent’s count.
      </p>
      {pins.length === 0 ? (
        <p className="panel-empty">Pin a lineage in the inspector to follow its ancestry.</p>
      ) : null}
      <ul className="ancestry-group-list">
        {result.groups.map((group) => (
          <li key={group.rootId} data-root-id={group.rootId}>
            <button
              type="button"
              className="ancestry-group-button"
              aria-pressed={selected === group.rootId}
              onClick={() => setSelected(selected === group.rootId ? null : group.rootId)}
            >
              <span className="ancestry-group-name">
                <span
                  className="lineage-swatch"
                  style={{ background: group.color }}
                  aria-hidden="true"
                />
                {group.name}
              </span>
              <span>
                <strong className="ancestry-population">{group.population.toString()}</strong>{' '}
                probes · {group.memberIds.length} living lineages
              </span>
              <span className="ancestry-root">
                root {group.rootId}
                {!sample.lineages.has(group.rootId)
                  ? ' · not on this timeline'
                  : (sample.population.get(group.rootId) ?? 0n) === 0n
                    ? ' · root extinct'
                    : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="ancestry-ungrouped lineage-action"
        aria-pressed={ungroupedSelected}
        onClick={() => setSelected(ungroupedSelected ? null : 'ungrouped')}
      >
        Ungrouped:{' '}
        <span className="ancestry-ungrouped-population">
          {result.ungroupedPopulation.toString()}
        </span>{' '}
        probes
      </button>
      {selectedGroup !== undefined || ungroupedSelected ? (
        <GroupMembers
          key={selectedGroup?.rootId ?? 'ungrouped'}
          name={selectedGroup?.name ?? 'Ungrouped'}
          rootId={selectedGroup?.rootId ?? null}
          ids={selectedGroup?.memberIds ?? result.ungroupedMemberIds}
          lineages={sample.lineages}
          population={sample.population}
          onSelect={selectLineage}
        />
      ) : null}
      {storageError !== null ? (
        <p className="inspector-error" role="status">
          {storageError}
        </p>
      ) : null}
    </section>
  );
}

function GroupMembers({
  name,
  rootId,
  ids,
  lineages,
  population,
  onSelect,
}: {
  name: string;
  rootId: string | null;
  ids: readonly string[];
  lineages: ReadonlyMap<string, LineageNode>;
  population: ReadonlyMap<string, bigint>;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const matches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return ids.filter((id) =>
      `${id} ${lineages.get(id)?.name ?? ''}`.toLocaleLowerCase().includes(query),
    );
  }, [ids, lineages, search]);
  const pages = Math.max(1, Math.ceil(matches.length / MEMBERS_PER_PAGE));
  const currentPage = Math.min(page, pages - 1);
  return (
    <section className="ancestry-members" aria-label={`Members of ${name}`}>
      <h4>{name} · living members</h4>
      {rootId !== null ? (
        <button
          type="button"
          className="lineage-action"
          disabled={!lineages.has(rootId)}
          onClick={() => onSelect(rootId)}
        >
          Inspect root {rootId}
        </button>
      ) : null}
      <p className="ancestry-help">
        Inspect individual genetic lineages below. Patches and quarantine affect only the selected
        lineage, not this group.
      </p>
      <label className="ancestry-search">
        Find a member
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          placeholder="Lineage name or ID"
        />
      </label>
      <ul className="ancestry-member-list" tabIndex={0} aria-label="Living group members">
        {matches
          .slice(currentPage * MEMBERS_PER_PAGE, (currentPage + 1) * MEMBERS_PER_PAGE)
          .map((id) => (
            <li key={id}>
              <button
                type="button"
                className="lineage-action"
                onClick={() => onSelect(id)}
                data-lineage-id={id}
              >
                <span>
                  {lineages.get(id)?.name ?? id} · {id}
                </span>
                <span>{(population.get(id) ?? 0n).toString()} probes</span>
              </button>
            </li>
          ))}
      </ul>
      {matches.length === 0 ? (
        <p className="panel-empty">
          {ids.length === 0 ? 'No living members.' : 'No matching members.'}
        </p>
      ) : null}
      <div className="ancestry-pagination">
        <button
          type="button"
          className="lineage-action"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous members
        </button>
        <span>
          Page {currentPage + 1} of {pages} · {matches.length} lineages
        </span>
        <button
          type="button"
          className="lineage-action"
          disabled={currentPage + 1 >= pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next members
        </button>
      </div>
    </section>
  );
}

export function AncestryPinControls({ lineageId }: { lineageId: string }): React.JSX.Element {
  const pins = useSimStore((s) => s.ancestryPins);
  const lineages = useSimStore((s) => s.lineages);
  const population = useSimStore((s) => s.populationByLineage);
  const ready = useSimStore((s) => s.ancestryPinsReady);
  const pin = useSimStore((s) => s.pinAncestry);
  const unpin = useSimStore((s) => s.unpinAncestry);
  const rename = useSimStore((s) => s.renameAncestry);
  const [error, setError] = useState<string | null>(null);
  const existing = pins.find((entry) => entry.rootId === lineageId);
  const groups = useMemo(
    () => deriveAncestryGroups(lineages, population, pins),
    [lineages, population, pins],
  );
  const owner = pins.find((entry) => entry.rootId === groups.ownerByLineage.get(lineageId));
  return (
    <section className="ancestry-pin-controls" aria-label="Ancestry group controls">
      {ready && owner !== undefined && existing === undefined ? (
        <p className="ancestry-membership ancestry-group-name">
          <span className="lineage-swatch" style={{ background: owner.color }} aria-hidden="true" />
          In {owner.name} · rooted at {owner.rootId}
        </p>
      ) : null}
      <div className="ancestry-pin-actions">
        {existing === undefined ? (
          <button
            type="button"
            className="lineage-action"
            disabled={!ready || pins.length >= MAX_ANCESTRY_GROUPS}
            onClick={() => setError(pin(lineageId))}
          >
            Pin ancestry group
          </button>
        ) : (
          <>
            <span className="ancestry-group-name">
              <span
                className="lineage-swatch"
                style={{ background: existing.color }}
                aria-hidden="true"
              />
              {existing.name}
            </span>
            <button
              type="button"
              className="lineage-action"
              disabled={!ready}
              onClick={() => {
                const name = window.prompt(
                  'Name this ancestry group (up to 40 characters)',
                  existing.name,
                );
                if (name !== null) setError(rename(lineageId, name));
              }}
            >
              Rename group
            </button>
            <button
              type="button"
              className="lineage-action"
              disabled={!ready}
              onClick={() => {
                unpin(lineageId);
                setError(null);
              }}
            >
              Unpin group
            </button>
          </>
        )}
      </div>
      <p className="ancestry-help">
        {pins.length >= MAX_ANCESTRY_GROUPS && existing === undefined
          ? 'Six groups pinned. Unpin one to follow another. '
          : ''}
        Groups follow ancestry, not shared firmware. Pins belong to this browser and run; loading a
        named save clears them.
      </p>
      {error !== null ? (
        <p className="inspector-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
