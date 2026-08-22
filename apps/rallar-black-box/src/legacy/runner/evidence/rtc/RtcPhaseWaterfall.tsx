import type { RtcPerformancePhaseSpan } from '../../../../rtc-diagnostics.ts';
import { formatDuration } from '../../../shared/time-format.ts';

export function RtcPhaseWaterfall({
    spans
}: {
    spans: readonly RtcPerformancePhaseSpan[];
}) {
    const max = Math.max(1, ...spans.map((span) => span.endMs));
    return (
        <div
            className="rtc-waterfall"
            role="img"
            aria-label="RTC phase waterfall"
        >
            {spans.map((span) => (
                <div className="rtc-waterfall-row" key={span.stageId}>
                    <span>{span.label}</span>
                    <div>
                        <i
                            className={span.tone}
                            style={{
                                marginLeft: `${(span.startMs / max) * 100}%`,
                                width: `${Math.max(2, (span.durationMs / max) * 100)}%`
                            }}
                        />
                    </div>
                    <strong title={span.valueLabel}>
                        {span.timingKind === 'duration'
                            ? formatDuration(span.durationMs)
                            : formatDuration(span.endMs)}
                    </strong>
                </div>
            ))}
        </div>
    );
}
