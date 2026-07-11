import { useRef, useState } from 'react';
import type { TunePreviewModel } from '../data/recipe-console-models.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import { StatusMark } from '../ui/StatusMark.tsx';
import { TimingDistribution } from './TimingDistribution.tsx';
import styles from './TunePreview.module.css';

type TimingMetric = NonNullable<RecipeConsoleUrlState['timingMetric']>;

export type TunePreviewProps = Readonly<{
    model: TunePreviewModel;
    metric: TimingMetric;
    onMetricChange(metric: TimingMetric): void;
    onInspectAgent(agentId: string): void;
}>;

const TIMING_OPTIONS: readonly Readonly<{ value: TimingMetric; label: string }>[] = [
    { value: 'command-duration', label: 'Command' },
    { value: 'stream-send-duration', label: 'Send duration' },
    { value: 'stream-drift', label: 'Drift' },
    { value: 'stream-cadence', label: 'Cadence' },
];

function formatMs(value: number | undefined): string {
    return value === undefined ? 'Unavailable' : `${value.toLocaleString('en-US')} ms`;
}

export function TunePreview({ model, metric, onMetricChange, onInspectAgent }: TunePreviewProps) {
    const [activeIndex, setActiveIndex] = useState(0);
    const agentRefs = useRef<Array<HTMLButtonElement | null>>([]);

    function moveFocus(index: number, delta: number): void {
        const nextIndex = (index + delta + model.agentMeans.length) % model.agentMeans.length;
        setActiveIndex(nextIndex);
        agentRefs.current[nextIndex]?.focus();
    }

    return (
        <div className={styles.tune} data-landscape-split data-preview-view="tune">
            <section className={styles.matrixPane} data-landscape-matrix>
                <header className={styles.paneHeader}>
                    <div><h2>Agent × phase</h2><span>Three seeded command-duration lanes</span></div>
                    <StatusMark label="Passed" status="passed" />
                </header>
                <div aria-label="Tune agent timing matrix" className={styles.matrixScroller} role="grid">
                    <div className={styles.matrixHeader} role="row">
                        <span role="columnheader">Agent</span><span role="columnheader">Mean</span>
                        {['Expected', 'Observed', 'Ready', 'Active', 'Stale', 'Missing'].map(label =>
                            <span key={label} role="columnheader">{label}</span>
                        )}
                    </div>
                    {model.agentMeans.map((agent, index) => {
                        const cells = model.matrixCells.filter(cell => cell.laneId === agent.agentId);
                        return (
                            <button
                                aria-label={`${agent.agentId} · ${agent.meanMs.toLocaleString('en-US')} ms`}
                                className={styles.agentRow}
                                data-tune-agent={agent.agentId}
                                key={agent.agentId}
                                onClick={() => onInspectAgent(agent.agentId)}
                                onFocus={() => setActiveIndex(index)}
                                onKeyDown={(event) => {
                                    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                                        event.preventDefault();
                                        moveFocus(index, 1);
                                    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                                        event.preventDefault();
                                        moveFocus(index, -1);
                                    } else if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        onInspectAgent(agent.agentId);
                                    }
                                }}
                                ref={element => { agentRefs.current[index] = element; }}
                                role="gridcell"
                                tabIndex={activeIndex === index ? 0 : -1}
                                type="button"
                            >
                                <strong>{agent.agentId}</strong>
                                <span>{formatMs(agent.meanMs)}</span>
                                {cells.map(cell => (
                                    <span data-metric={cell.metric} key={`${cell.laneId}:${cell.metric}`}>
                                        {cell.value}
                                    </span>
                                ))}
                            </button>
                        );
                    })}
                </div>
            </section>
            <div aria-hidden="true" data-landscape-divider />
            <section className={styles.timingPane} data-landscape-timing>
                <header className={styles.paneHeader}>
                    <div><h2>Timing</h2><span>Command-duration only · RTC timeline unavailable</span></div>
                </header>
                <SegmentedControl
                    label="Timing metric"
                    onChange={onMetricChange}
                    options={TIMING_OPTIONS}
                    value={metric}
                />
                {metric === 'command-duration' ? (
                    <>
                        <dl className={styles.percentiles}>
                            <div><dt>P50</dt><dd>{formatMs(model.percentiles.p50Ms)}</dd></div>
                            <div><dt>P95</dt><dd>{formatMs(model.percentiles.p95Ms)}</dd></div>
                            <div><dt>P99</dt><dd>{formatMs(model.percentiles.p99Ms)}</dd></div>
                            <div><dt>Max</dt><dd>{formatMs(model.percentiles.maxMs)}</dd></div>
                        </dl>
                        <TimingDistribution histogram={model.histogram} points={model.points} />
                    </>
                ) : (
                    <div className={styles.unavailable} data-timing-unavailable>
                        <strong>Unavailable in this command-duration seed</strong>
                        <span>
                            RTC timeline evidence is not available. {model.emptyReasons.join(' ')}
                        </span>
                    </div>
                )}
            </section>
        </div>
    );
}
