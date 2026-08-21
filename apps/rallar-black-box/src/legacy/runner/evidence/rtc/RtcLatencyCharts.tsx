import type { RtcPerformanceHistogramBucket, RtcPerformanceScatterPoint } from '../../../../rtc-diagnostics.ts';
import { formatDuration } from '../../../shared/time-format.ts';

function scatterCircleClass(point: RtcPerformanceScatterPoint): string {
    if (!point.ok || point.status === 'failed') {
        return 'bad';
    }
    if (point.transport === 'ws') {
        return 'active';
    }
    if (point.transport === 'rtc') {
        return 'good';
    }
    return 'muted';
}

type RtcPercentileMarkers = Readonly<{
    p50Ms?: number;
    p95Ms?: number;
    p99Ms?: number;
}>;

function rtcPercentileMarkerEntries(
    percentiles: RtcPercentileMarkers
): readonly Readonly<{ label: string; value: number; }>[] {
    return [
        percentiles.p50Ms !== undefined ? { label: 'P50', value: percentiles.p50Ms } : undefined,
        percentiles.p95Ms !== undefined ? { label: 'P95', value: percentiles.p95Ms } : undefined,
        percentiles.p99Ms !== undefined ? { label: 'P99', value: percentiles.p99Ms } : undefined
    ].filter((entry): entry is { label: string; value: number; } => entry !== undefined);
}

export function RtcLatencyScatterChart({
    points,
    percentiles
}: {
    points: readonly RtcPerformanceScatterPoint[];
    percentiles: RtcPercentileMarkers;
}) {
    const width = 280;
    const height = 150;
    const padding = 24;
    const maxDuration = Math.max(1, ...points.map((point) => point.durationMs));
    const lastSequence = Math.max(1, points.length - 1);
    const markers = rtcPercentileMarkerEntries(percentiles);

    return (
        <svg
            className="rtc-chart rtc-scatter-chart"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Latency scatter plot"
        >
            <line
                x1={padding}
                x2={width - padding}
                y1={height - padding}
                y2={height - padding}
            />
            <line
                x1={padding}
                x2={padding}
                y1={padding}
                y2={height - padding}
            />
            <text x={padding} y={14}>duration ms</text>
            <text x={padding + 3} y={height - padding - 4}>0</text>
            <text x={padding + 3} y={padding + 4}>{Math.round(maxDuration)}ms</text>
            <text x={width - 88} y={height - 6}>sequence</text>
            {markers.map((marker) => {
                const y = height - padding -
                    (marker.value / maxDuration) * (height - padding * 2);
                return (
                    <g className="rtc-percentile-marker" key={marker.label}>
                        <line
                            x1={padding}
                            x2={width - padding}
                            y1={y}
                            y2={y}
                        />
                        <text x={width - padding - 42} y={Math.max(18, y - 3)}>
                            {marker.label} {Math.round(marker.value)}ms
                        </text>
                    </g>
                );
            })}
            {points.map((point, index) => {
                const x = padding +
                    (index / lastSequence) * (width - padding * 2);
                const y = height - padding -
                    (point.durationMs / maxDuration) * (height - padding * 2);
                const radius = point.source === 'distributed-agent'
                    ? 5.6
                    : point.transport === 'rtc'
                    ? 4.8
                    : 3.8;
                return (
                    <g key={point.commandId}>
                        <circle
                            className={`${scatterCircleClass(point)} ${
                                point.source === 'distributed-agent' ? 'distributed' : ''
                            }`}
                            cx={x}
                            cy={y}
                            r={radius}
                        />
                        <title>
                            {point.commandId}: {point.durationMs} ms ({point.transport}, {point.source})
                        </title>
                    </g>
                );
            })}
        </svg>
    );
}

export function RtcLatencyHistogram({
    buckets,
    percentiles
}: {
    buckets: readonly RtcPerformanceHistogramBucket[];
    percentiles: RtcPercentileMarkers;
}) {
    const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
    const markers = rtcPercentileMarkerEntries(percentiles);
    return (
        <div
            className="rtc-histogram-wrap"
            role="img"
            aria-label="Latency distribution histogram"
        >
            <div className="rtc-histogram">
                {buckets.map((bucket) => (
                    <div className="rtc-histogram-column" key={bucket.label}>
                        <span
                            style={{
                                height: `${Math.max(8, (bucket.count / max) * 100)}%`
                            }}
                        />
                        <small>{bucket.label}</small>
                        <strong>{bucket.count}</strong>
                    </div>
                ))}
            </div>
            {markers.length > 0 && (
                <div className="rtc-histogram-percentiles">
                    {markers.map((marker) => (
                        <span key={marker.label}>
                            {marker.label} {formatDuration(marker.value)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
