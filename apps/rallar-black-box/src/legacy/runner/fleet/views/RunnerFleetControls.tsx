import type { ControlFleetRunReport } from '../../../../control-run-manager.ts';
import { formatTime } from '../../../shared/time-format.ts';
import type { FleetFilterState } from '../fleet-types.ts';

export function RunnerFleetControls({
    controlBaseUrl,
    setControlBaseUrl,
    controlToken,
    setControlToken,
    filters,
    updateFilter,
    busy,
    refreshFleet,
    copyShareLink,
    lastRefresh,
    reports,
    error
}: {
    controlBaseUrl: string;
    setControlBaseUrl(value: string): void;
    controlToken: string;
    setControlToken(value: string): void;
    filters: FleetFilterState;
    updateFilter<K extends keyof FleetFilterState>(
        key: K,
        value: FleetFilterState[K]
    ): void;
    busy: string | undefined;
    refreshFleet(options?: Readonly<{ rebuild?: boolean; quiet?: boolean; }>): Promise<void>;
    copyShareLink(): Promise<void>;
    lastRefresh: number | undefined;
    reports: readonly ControlFleetRunReport[];
    error: string | undefined;
}) {
    return (
        <>
            <div className="fleet-toolbar">
                <label className="field">
                    <span>Control HTTP</span>
                    <input
                        value={controlBaseUrl}
                        onChange={(event) => setControlBaseUrl(event.target.value)}
                    />
                </label>
                <label className="field compact-field">
                    <span>Token</span>
                    <input
                        type="password"
                        autoComplete="off"
                        value={controlToken}
                        onChange={(event) => setControlToken(event.target.value)}
                    />
                </label>
                <label className="field compact-field">
                    <span>Window</span>
                    <select
                        value={filters.window}
                        onChange={(event) =>
                            updateFilter(
                                'window',
                                event.target.value as FleetFilterState['window']
                            )}
                    >
                        <option value="1h">Last hour</option>
                        <option value="24h">Last 24h</option>
                        <option value="7d">Last 7d</option>
                        <option value="all">All</option>
                    </select>
                </label>
                <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void refreshFleet()}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void refreshFleet({ rebuild: true })}
                >
                    Rebuild index
                </button>
                <button type="button" onClick={() => void copyShareLink()}>
                    Copy share link
                </button>
            </div>
            <div className="fleet-filter-row">
                <label className="field">
                    <span>Region</span>
                    <input
                        placeholder="eu-north"
                        value={filters.region}
                        onChange={(event) => updateFilter('region', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Provider</span>
                    <input
                        placeholder="hetzner"
                        value={filters.provider}
                        onChange={(event) => updateFilter('provider', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Recipe</span>
                    <input
                        placeholder="recipe id"
                        value={filters.recipeId}
                        onChange={(event) => updateFilter('recipeId', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>Group</span>
                    <input
                        placeholder="group id"
                        value={filters.groupId}
                        onChange={(event) => updateFilter('groupId', event.target.value)}
                    />
                </label>
                <label className="field">
                    <span>State</span>
                    <select
                        value={filters.state}
                        onChange={(event) => updateFilter('state', event.target.value)}
                    >
                        <option value="">Any</option>
                        <option value="passed">Passed</option>
                        <option value="failed">Failed</option>
                        <option value="timed-out">Timed out</option>
                        <option value="cancelled">Cancelled</option>
                    </select>
                </label>
            </div>
            <div className="runner-distributed-freshness">
                <span>
                    {lastRefresh
                        ? `Fresh ${formatTime(lastRefresh)}`
                        : 'Not refreshed yet'}
                </span>
                <span>{busy ?? `${reports.length} reports`}</span>
            </div>
            {error && (
                <div className="workbench-error" role="status">
                    {error}
                </div>
            )}
        </>
    );
}
