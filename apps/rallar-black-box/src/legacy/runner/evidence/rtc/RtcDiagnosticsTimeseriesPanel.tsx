import type { RtcDiagnosticsTimeseriesSeries } from '../../../../rtc-diagnostics.ts';

function timeseriesPolyline(series: RtcDiagnosticsTimeseriesSeries): string {
    const points = series.points;
    if (points.length === 0) {
        return '';
    }

    const width = 220;
    const height = 64;
    const max = Math.max(1, series.max);
    const lastIndex = Math.max(1, points.length - 1);
    return points
        .map((point, index) => {
            const x = (index / lastIndex) * width;
            const y = height - (point.value / max) * height;
            return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
        })
        .join(' ');
}

export function RtcDiagnosticsTimeseriesPanel({
    series
}: {
    series: readonly RtcDiagnosticsTimeseriesSeries[];
}) {
    return (
        <section
            className="rtc-timeseries-panel"
            aria-label="RTC diagnostics time-series"
        >
            <div className="section-heading">
                <h3>Time Series</h3>
                <span>{series[0]?.points.length ?? 0} buckets</span>
            </div>
            <div className="rtc-timeseries-grid">
                {series.map((entry) => (
                    <article
                        className={`rtc-timeseries-card ${entry.tone}`}
                        key={entry.seriesId}
                    >
                        <div>
                            <strong>{entry.label}</strong>
                            <small>
                                latest {entry.latest} {entry.unit} - max {entry.max} {entry.unit}
                            </small>
                        </div>
                        <svg
                            className="rtc-timeseries-chart"
                            viewBox="0 0 220 64"
                            preserveAspectRatio="none"
                            role="img"
                            aria-label={`${entry.label} over time`}
                        >
                            <line x1="0" x2="220" y1="64" y2="64" />
                            <polyline points={timeseriesPolyline(entry)} />
                        </svg>
                    </article>
                ))}
            </div>
        </section>
    );
}
