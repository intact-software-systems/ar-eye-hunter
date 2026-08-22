import type { DistributedRunPerformanceAnalysis } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { tuneMilliseconds, tuneNumber } from './tune-format.ts';
import type { TuneInspection } from './tune-inspection.ts';
import styles from './TuneEvidence.module.css';
import { TuneSlowAgents } from './TuneSlowAgents.tsx';

export function TuneCommandTiming({
    performance,
    onInspect
}: Readonly<{
    performance?: DistributedRunPerformanceAnalysis;
    onInspect(selection: TuneInspection, trigger: HTMLButtonElement): void;
}>) {
    const timing = performance?.commandTiming;
    const metrics = [
        ['Min', tuneMilliseconds(timing?.minMs)],
        ['P50', tuneMilliseconds(timing?.p50Ms)],
        ['P95', tuneMilliseconds(timing?.p95Ms)],
        ['P99', tuneMilliseconds(timing?.p99Ms)],
        ['Max', tuneMilliseconds(timing?.maxMs)]
    ] as const;
    return (
        <section className={styles.section} data-tune-command-timing>
            <header className={styles.sectionHeader}>
                <div>
                    <p className={styles.eyebrow}>Command latency</p>
                    <h2>Command timing</h2>
                </div>
                <span>{timing?.count ?? 0} samples</span>
            </header>
            {timing && timing.count > 0
                ? (
                    <>
                        <ul className={styles.metricGrid}>
                            {metrics.map(([label, value]) => (
                                <li key={label}>
                                    <strong>{`${label} ${value}`}</strong>
                                </li>
                            ))}
                        </ul>
                        <p className={styles.detailLine}>
                            Average {tuneMilliseconds(timing.averageMs)} · Spread {tuneNumber(timing.spreadRatio)}× ·
                            {' '}
                            {timing.outlierCount} outliers
                        </p>
                        {performance
                            ? (
                                <TuneSlowAgents
                                    channel="command"
                                    onInspect={onInspect}
                                    performance={performance}
                                />
                            )
                            : null}
                    </>
                )
                : <p className={styles.empty}>Command timing is unavailable for this source.</p>}
        </section>
    );
}
