import {
    selectRallarBlackBoxFailures,
    selectRallarBlackBoxLatestStats,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { Metric } from '../../shared/Metric.tsx';
import { formatDuration, formatTime } from '../../shared/time-format.ts';

export function StatsPanel({ state }: { state: RallarBlackBoxTestState }) {
    const stats = selectRallarBlackBoxLatestStats(state);
    const failures = selectRallarBlackBoxFailures(state);
    const latency = stats?.commandLatency;

    return (
        <section className="panel stats-panel">
            <div className="panel-heading">
                <h2>Stats</h2>
                <span>{formatTime(stats?.atEpochMs)}</span>
            </div>
            <div className="stats-grid">
                <Metric
                    label="Commands"
                    value={String(stats?.counters.commands ?? 0)}
                />
                <Metric
                    label="Events"
                    value={String(stats?.counters.events ?? 0)}
                />
                <Metric
                    label="Messages"
                    value={String(stats?.counters.messages ?? 0)}
                />
                <Metric
                    label="Diagnostics"
                    value={String(stats?.counters.diagnostics ?? 0)}
                />
                <Metric
                    label="Failures"
                    value={String(failures.length)}
                    tone={failures.length ? 'bad' : 'good'}
                />
                <Metric
                    label="Reconnects"
                    value={String(stats?.counters.reconnects ?? 0)}
                />
                <Metric
                    label="Last command"
                    value={stats?.lastCommandId ?? '-'}
                />
                <Metric
                    label="Peer count"
                    value={String(stats?.rallar?.peerCount ?? 0)}
                />
                <Metric
                    label="Lane health"
                    value={String(stats?.rallar?.laneHealth ?? 'unknown')}
                />
                <Metric
                    label="Avg latency"
                    value={formatDuration(latency?.averageMs)}
                />
                <Metric
                    label="Max latency"
                    value={formatDuration(latency?.maxMs)}
                />
            </div>
        </section>
    );
}
