import type { DistributedRunPerformanceAnalysis } from
    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { tuneMilliseconds } from './tune-format.ts';
import type { TuneInspection } from './tune-inspection.ts';
import styles from './TuneEvidence.module.css';

export function TuneSlowAgents({
    channel,
    performance,
    onInspect,
}: Readonly<{
    channel: 'command' | 'stream';
    performance: DistributedRunPerformanceAnalysis;
    onInspect(selection: TuneInspection, trigger: HTMLButtonElement): void;
}>) {
    const rows = channel === 'command'
        ? performance.slowestAgents.map(agent => ({
            channel: 'command' as const,
            agentId: agent.agentId,
            detail: `Command average ${tuneMilliseconds(agent.averageMs)} · max ${tuneMilliseconds(agent.maxMs)}`,
        }))
        : (performance.streamTiming?.slowestAgents ?? []).map(agent => ({
            channel: 'stream' as const,
            agentId: agent.agentId,
            detail: `Stream P95 ${tuneMilliseconds(agent.p95Ms)} · P99 ${tuneMilliseconds(agent.p99Ms)} · max ${tuneMilliseconds(agent.maxMs)}`,
        }));
    if (rows.length === 0) {
        return <p className={styles.empty}>No per-agent timing rows are available.</p>;
    }
    return (
        <div
            className={styles.agentLedger}
            data-tune-slow-agents={channel}
        >
            <h3>{channel === 'command'
                ? 'Slowest command agents'
                : 'Slowest stream agents'}</h3>
            {rows.map(row => (
                <button
                    key={`${row.channel}:${row.agentId}`}
                    onClick={event => onInspect({
                        kind: 'agent',
                        agentId: row.agentId,
                        channel: row.channel,
                    }, event.currentTarget)}
                    type="button"
                >
                    <strong>{row.agentId}</strong>
                    <span>{row.detail}</span>
                    <em>Inspect</em>
                </button>
            ))}
        </div>
    );
}
