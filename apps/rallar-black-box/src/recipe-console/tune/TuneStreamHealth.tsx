import type { DistributedRunPerformanceAnalysis } from
    '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { tuneHertz, tuneMilliseconds } from './tune-format.ts';
import type { TuneInspection } from './tune-inspection.ts';
import { TuneSlowAgents } from './TuneSlowAgents.tsx';
import styles from './TuneEvidence.module.css';

export function TuneStreamHealth({
    performance,
    onInspect,
}: Readonly<{
    performance?: DistributedRunPerformanceAnalysis;
    onInspect(selection: TuneInspection, trigger: HTMLButtonElement): void;
}>) {
    const stream = performance?.streamTiming;
    return (
        <section className={styles.section} data-tune-stream-health>
            <header className={styles.sectionHeader}>
                <div>
                    <p className={styles.eyebrow}>RTC delivery</p>
                    <h2>Stream health</h2>
                </div>
                <span>{stream?.streamCount ?? 0} streams</span>
            </header>
            {stream && performance ? (
                <>
                    <ul className={styles.metricGrid}>
                        {[
                            `${stream.plannedFrames} planned`,
                            `${stream.scheduledFrames} scheduled`,
                            `${stream.attemptedFrames} attempted`,
                            `${stream.completedFrames} completed`,
                            `${stream.failedFrames} failed`,
                            `${stream.droppedFrames} dropped`,
                            `${stream.inFlightLimitDropCount} in-flight drops`,
                            `${stream.lateFrameCount} late`,
                            `${stream.backpressureCount} backpressure`,
                        ].map(value => <li key={value}><strong>{value}</strong></li>)}
                    </ul>
                    <div className={styles.rateBand}>
                        <span>{tuneHertz(stream.requestedRateHz)} requested</span>
                        <span>{tuneHertz(stream.achievedScheduleHz)} scheduled</span>
                        <span>{tuneHertz(stream.achievedCompletionHz)} completed</span>
                        <span>{tuneMilliseconds(stream.maxStartDriftMs)} max drift</span>
                    </div>
                    <p className={styles.detailLine}>
                        {`P50 ${tuneMilliseconds(stream.duration.p50Ms)} · P95 ${tuneMilliseconds(stream.duration.p95Ms)} · P99 ${tuneMilliseconds(stream.duration.p99Ms)} · Max ${tuneMilliseconds(stream.duration.maxMs)}`}
                    </p>
                    <TuneSlowAgents
                        channel="stream"
                        onInspect={onInspect}
                        performance={performance}
                    />
                </>
            ) : (
                <p className={styles.empty}>
                    RTC frame disposition, cadence, drift, and backpressure are unavailable.
                </p>
            )}
        </section>
    );
}
