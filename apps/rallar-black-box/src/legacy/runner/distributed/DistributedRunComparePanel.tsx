import type { ControlDistributedRunSnapshot } from '../../../control-run-manager.ts';
import type { DistributedRunCompareSummary } from '../../../distributed-recipes.ts';
import { Metric } from '../../shared/Metric.tsx';
import {
    formatSignedDuration,
    formatSignedNumber,
} from '../../shared/time-format.ts';

export function DistributedRunComparePanel({
    runs,
    leftId,
    rightId,
    summary,
    onLeftChange,
    onRightChange,
}: {
    runs: readonly ControlDistributedRunSnapshot[];
    leftId: string;
    rightId: string;
    summary: DistributedRunCompareSummary | undefined;
    onLeftChange(value: string): void;
    onRightChange(value: string): void;
}) {
    const options = [...runs].sort(
        (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
    );
    return (
        <section className="distributed-subpanel distributed-compare-panel">
            <div className="section-heading">
                <h3>Compare Runs</h3>
                <span>
                    {summary
                        ? `${summary.leftId} -> ${summary.rightId}`
                        : 'select two'}
                </span>
            </div>
            <div className="distributed-compare-selectors">
                <label className="field">
                    <span>Left</span>
                    <select
                        value={leftId}
                        onChange={(event) => onLeftChange(event.target.value)}
                    >
                        <option value="">Select run</option>
                        {options.map((option) => (
                            <option
                                key={option.distributedRunId}
                                value={option.distributedRunId}
                            >
                                {option.distributedRunId}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>Right</span>
                    <select
                        value={rightId}
                        onChange={(event) => onRightChange(event.target.value)}
                    >
                        <option value="">Select run</option>
                        {options.map((option) => (
                            <option
                                key={option.distributedRunId}
                                value={option.distributedRunId}
                            >
                                {option.distributedRunId}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {!summary && (
                <div className="empty-state">
                    Choose two distributed runs to compare
                </div>
            )}
            {summary && (
                <>
                    <div className="distributed-monitor-metrics">
                        <Metric
                            label="Left failures"
                            value={String(summary.failureDelta.leftCount)}
                        />
                        <Metric
                            label="Right failures"
                            value={String(summary.failureDelta.rightCount)}
                        />
                        <Metric
                            label="Duration delta"
                            value={formatSignedDuration(
                                summary.timingDelta.durationDeltaMs,
                            )}
                        />
                        <Metric
                            label="Message delta"
                            value={formatSignedNumber(
                                summary.receivedMessageDelta.delta,
                            )}
                        />
                    </div>
                    <div className="distributed-compare-grid">
                        <DistributedCompareList
                            title="Recipes Left Only"
                            values={summary.recipeDelta.leftOnly}
                        />
                        <DistributedCompareList
                            title="Recipes Right Only"
                            values={summary.recipeDelta.rightOnly}
                        />
                        <DistributedCompareList
                            title="Profile Changes"
                            values={summary.recipeDelta.changedProfiles}
                        />
                        <DistributedCompareList
                            title="Participants Left Only"
                            values={summary.participantDelta.leftOnly}
                        />
                        <DistributedCompareList
                            title="Participants Right Only"
                            values={summary.participantDelta.rightOnly}
                        />
                        <DistributedCompareList
                            title="Failures Right Only"
                            values={summary.failureDelta.rightOnly}
                            tone="bad"
                        />
                        <DistributedCompareList
                            title="Messages Left Only"
                            values={summary.receivedMessageDelta.leftOnly}
                        />
                        <DistributedCompareList
                            title="Messages Right Only"
                            values={summary.receivedMessageDelta.rightOnly}
                        />
                    </div>
                </>
            )}
        </section>
    );
}

function DistributedCompareList({
    title,
    values,
    tone = 'muted',
}: {
    title: string;
    values: readonly string[];
    tone?: string;
}) {
    return (
        <section>
            <h3>{title}</h3>
            <div className="distributed-monitor-list compact">
                {values.slice(0, 8).map((value) => (
                    <div className="distributed-monitor-row" key={value}>
                        <span className={`pill ${tone}`}>{value}</span>
                    </div>
                ))}
                {values.length === 0 && (
                    <div className="empty-state">No delta</div>
                )}
            </div>
        </section>
    );
}
