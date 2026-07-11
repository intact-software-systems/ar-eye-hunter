import type { TunePreviewModel } from '../data/recipe-console-models.ts';
import styles from './TunePreview.module.css';

export type TimingDistributionProps = Readonly<{
    points: TunePreviewModel['points'];
    histogram: TunePreviewModel['histogram'];
}>;

const PLOT_LEFT = 48;
const PLOT_WIDTH = 372;

export function TimingDistribution({ points, histogram }: TimingDistributionProps) {
    const minMs = histogram[0]?.minMs ?? 0;
    const maxMs = histogram.at(-1)?.maxMs ?? Math.max(1, ...points.map(point => point.durationMs));
    const durationRange = Math.max(1, maxMs - minMs);
    const pointX = (durationMs: number) =>
        PLOT_LEFT + ((durationMs - minMs) / durationRange) * PLOT_WIDTH;
    const maxCount = Math.max(1, ...histogram.map(bucket => bucket.count));

    return (
        <svg
            aria-labelledby="tune-distribution-title tune-distribution-description"
            className={styles.distribution}
            role="img"
            viewBox="0 0 460 240"
        >
            <title id="tune-distribution-title">Command duration distribution</title>
            <desc id="tune-distribution-description">
                Histogram and per-agent command-duration means from the high-latency RTC seed.
            </desc>
            <line className={styles.axis} x1={PLOT_LEFT} x2="420" y1="184" y2="184" />
            <line className={styles.axis} x1={PLOT_LEFT} x2={PLOT_LEFT} y1="28" y2="184" />
            <text className={styles.axisLabel} x="234" y="226">Duration (ms)</text>
            <text className={styles.axisLabel} transform="rotate(-90 14 112)" x="14" y="112">Count</text>
            {histogram.map((bucket, index) => {
                const height = (bucket.count / maxCount) * 76;
                return (
                    <g data-histogram-bar key={bucket.label}>
                        <rect
                            className={styles.bar}
                            height={height}
                            width="82"
                            x={PLOT_LEFT + index * 92 + 5}
                            y={184 - height}
                        />
                        <text className={styles.bucketLabel} x={PLOT_LEFT + index * 92 + 46} y="201">
                            {bucket.label.replace(' ms', '')}
                        </text>
                    </g>
                );
            })}
            {points.map((point, index) => {
                const x = pointX(point.durationMs);
                const labelOnLeft = x > PLOT_LEFT + PLOT_WIDTH * 0.62;
                return (
                    <g data-duration-point key={point.agentId ?? point.commandId}>
                        <circle className={styles.point} cx={x} cy={48 + index * 30} r="5" />
                        <text
                            className={styles.pointLabel}
                            textAnchor={labelOnLeft ? 'end' : 'start'}
                            x={x + (labelOnLeft ? -9 : 9)}
                            y={52 + index * 30}
                        >
                            {point.agentId ?? point.commandId} · {point.durationMs.toLocaleString('en-US')} ms
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}
