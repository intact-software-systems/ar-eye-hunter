import styles from './primitives.module.css';

export type SegmentedOption<Value extends string> = Readonly<{
    value: Value;
    label: string;
}>;

export function SegmentedControl<Value extends string>({
    label,
    options,
    value,
    onChange,
}: Readonly<{
    label: string;
    options: readonly SegmentedOption<Value>[];
    value: Value;
    onChange(value: Value): void;
}>) {
    return (
        <div aria-label={label} className={styles.segmentedControl} role="group">
            {options.map(option => (
                <button
                    aria-pressed={option.value === value}
                    className={styles.segment}
                    key={option.value}
                    onClick={() => onChange(option.value)}
                    type="button"
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
