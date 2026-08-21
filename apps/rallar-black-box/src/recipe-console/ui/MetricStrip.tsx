import styles from './primitives.module.css';

export type MetricStripItem = Readonly<{
    label: string;
    value: string | number;
}>;

export function MetricStrip({ items, label = 'Metrics' }: Readonly<{
    items: readonly MetricStripItem[];
    label?: string;
}>) {
    return (
        <dl aria-label={label} className={styles.metricStrip}>
            {items.map((item) => (
                <div className={styles.metric} key={item.label}>
                    <dt className={styles.metricLabel}>{item.label}</dt>
                    <dd className={styles.metricValue}>{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}
