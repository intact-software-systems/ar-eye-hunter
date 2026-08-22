import { useMemo, useState } from 'react';
import { RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG } from '../../../shared-test-handoff-fixtures.ts';
import { Metric } from '../../shared/Metric.tsx';
import { uniqueValues } from '../../shared/unique-values.ts';
import { APP_LOCAL_RECIPE_CATALOG, catalogEntryMatches, catalogRequirements } from './shared-test-catalog.ts';

export function SharedTestCatalogPanel() {
    const catalog = RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG;
    const profileOptions = useMemo(
        () => uniqueValues(catalog.entries.flatMap((entry) => entry.profiles)),
        [catalog.entries]
    );
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const [selectedEntryId, setSelectedEntryId] = useState(
        catalog.entries[0]?.id ?? ''
    );
    const filteredEntries = useMemo(
        () => catalog.entries.filter((entry) => catalogEntryMatches(entry, query.trim(), profile)),
        [catalog.entries, profile, query]
    );
    const selectedEntry = catalog.entries.find((entry) => entry.id === selectedEntryId) ??
        filteredEntries[0] ??
        catalog.entries[0];
    const liveCount = catalog.entries.filter(
        (entry) => entry.support.live
    ).length;
    const replayCount = catalog.entries.filter(
        (entry) => entry.support.replayArtifacts
    ).length;

    const copyText = (value: string): void => {
        void navigator.clipboard?.writeText(value);
    };

    return (
        <section className="panel shared-test-catalog-panel">
            <div className="panel-heading">
                <h2>Recipe Catalog</h2>
                <span>{filteredEntries.length} visible</span>
            </div>
            <div className="shared-test-summary-grid">
                <Metric label="Catalog" value={catalog.generatedFrom} />
                <Metric
                    label="Recipes"
                    value={String(catalog.entries.length)}
                />
                <Metric
                    label="Live gated"
                    value={String(liveCount)}
                    tone={liveCount > 0 ? 'active' : 'muted'}
                />
                <Metric
                    label="Replay"
                    value={String(replayCount)}
                    tone={replayCount > 0 ? 'good' : 'muted'}
                />
            </div>
            <div className="shared-test-filter-grid">
                <label className="field">
                    <span>Search</span>
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="recipe, provider, profile"
                    />
                </label>
                <label className="field">
                    <span>Profile</span>
                    <select
                        value={profile}
                        onChange={(event) => setProfile(event.target.value)}
                    >
                        <option value="">All profiles</option>
                        {profileOptions.map((entry) => (
                            <option key={entry} value={entry}>
                                {entry}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <div className="shared-test-catalog-grid">
                <section className="shared-test-subpanel">
                    <div className="section-heading">
                        <h3>App-local Recipes</h3>
                        <span>{APP_LOCAL_RECIPE_CATALOG.length} recipes</span>
                    </div>
                    <div className="shared-test-card-list">
                        {APP_LOCAL_RECIPE_CATALOG.map((entry) => (
                            <article
                                className="shared-test-recipe-row"
                                key={entry.id}
                            >
                                <div>
                                    <strong>{entry.title}</strong>
                                    <small>{entry.path}</small>
                                </div>
                                <p>{entry.description}</p>
                                <div className="badge-list">
                                    <span className="pill active">
                                        {entry.providerMode}
                                    </span>
                                    <span className="pill good">
                                        {entry.expectedResult}
                                    </span>
                                </div>
                                <details>
                                    <summary>Requirements</summary>
                                    <ul>
                                        {entry.requirements.map(
                                            (requirement) => (
                                                <li key={requirement}>
                                                    {requirement}
                                                </li>
                                            )
                                        )}
                                    </ul>
                                </details>
                                <button
                                    type="button"
                                    onClick={() => copyText(entry.path)}
                                >
                                    Copy Path
                                </button>
                            </article>
                        ))}
                    </div>
                </section>
                <section className="shared-test-subpanel">
                    <div className="section-heading">
                        <h3>Shared-test Recipes</h3>
                        <span>{filteredEntries.length} entries</span>
                    </div>
                    <div className="shared-test-card-list">
                        {filteredEntries.length === 0 && (
                            <div className="empty-state">
                                No shared-test recipes match the filters
                            </div>
                        )}
                        {filteredEntries.map((entry) => (
                            <button
                                type="button"
                                key={entry.id}
                                className={`shared-test-catalog-row ${
                                    selectedEntry?.id === entry.id ? 'selected' : ''
                                }`}
                                onClick={() => setSelectedEntryId(entry.id)}
                            >
                                <span>
                                    <strong>{entry.title}</strong>
                                    <small>{entry.recipePath}</small>
                                </span>
                                <span className="badge-list">
                                    {entry.category === 'rallar-crdt' && <span className="pill good">CRDT</span>}
                                    <span className="pill active">
                                        {entry.providerMode}
                                    </span>
                                    {entry.profiles.includes('live-crdt') && (
                                        <span className="pill warn">
                                            live-crdt
                                        </span>
                                    )}
                                    <span
                                        className={`pill ${entry.liveSupport === 'gated-live' ? 'warn' : 'good'}`}
                                    >
                                        {entry.liveSupport}
                                    </span>
                                </span>
                            </button>
                        ))}
                    </div>
                </section>
                <section className="shared-test-subpanel shared-test-detail-panel">
                    <div className="section-heading">
                        <h3>Selected Recipe</h3>
                        <span>{selectedEntry?.expectedResult ?? '-'}</span>
                    </div>
                    {selectedEntry
                        ? (
                            <>
                                <dl className="config-list shared-test-detail-list">
                                    <div>
                                        <dt>ID</dt>
                                        <dd>{selectedEntry.id}</dd>
                                    </div>
                                    <div>
                                        <dt>Provider</dt>
                                        <dd>{selectedEntry.providerMode}</dd>
                                    </div>
                                    <div>
                                        <dt>Category</dt>
                                        <dd>{selectedEntry.category}</dd>
                                    </div>
                                    <div>
                                        <dt>Mode</dt>
                                        <dd>{selectedEntry.executionMode}</dd>
                                    </div>
                                    <div>
                                        <dt>Artifact</dt>
                                        <dd>{selectedEntry.artifactName}</dd>
                                    </div>
                                    <div>
                                        <dt>Surface</dt>
                                        <dd>
                                            {selectedEntry.uiHints
                                                .recommendedSurface}
                                        </dd>
                                    </div>
                                </dl>
                                <p className="shared-test-description">
                                    {selectedEntry.description}
                                </p>
                                <div className="badge-list shared-test-badges">
                                    {selectedEntry.uiHints.badges.map((badge) => (
                                        <span className="pill muted" key={badge}>
                                            {badge}
                                        </span>
                                    ))}
                                </div>
                                <div className="shared-test-requirements">
                                    <h3>Prerequisites</h3>
                                    {catalogRequirements(selectedEntry).length ===
                                            0
                                        ? (
                                            <div className="empty-state">
                                                No live prerequisites
                                            </div>
                                        )
                                        : (
                                            <ul>
                                                {catalogRequirements(selectedEntry).map(
                                                    (requirement) => (
                                                        <li key={requirement}>
                                                            {requirement}
                                                        </li>
                                                    )
                                                )}
                                            </ul>
                                        )}
                                </div>
                                <div className="shared-test-command-list">
                                    <h3>Commands</h3>
                                    {selectedEntry.commands.map((command) => (
                                        <article
                                            className="shared-test-command-row"
                                            key={command.label}
                                        >
                                            <div>
                                                <strong>{command.label}</strong>
                                                <small>{command.description}</small>
                                            </div>
                                            <pre className="mini-json">
                                            {command.command}
                                            </pre>
                                            <button
                                                type="button"
                                                onClick={() => copyText(command.command)}
                                            >
                                                Copy Command
                                            </button>
                                        </article>
                                    ))}
                                </div>
                            </>
                        )
                        : <div className="empty-state">No recipe selected</div>}
                </section>
            </div>
        </section>
    );
}
