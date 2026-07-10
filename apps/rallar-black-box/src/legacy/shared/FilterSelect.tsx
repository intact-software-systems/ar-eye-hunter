import { useId } from 'react';

export function FilterSelect({
    label,
    value,
    values,
    onChange,
}: {
    label: string;
    value: string;
    values: readonly string[];
    onChange(value: string): void;
}) {
    const selectId = useId();

    return (
        <div className="field compact-field">
            <label htmlFor={selectId}>
                <span>{label}</span>
            </label>
            <select
                id={selectId}
                value={value}
                onChange={(event) => onChange(event.target.value)}
            >
                <option value="">All</option>
                {values.map((entry) => (
                    <option key={entry} value={entry}>
                        {entry}
                    </option>
                ))}
            </select>
        </div>
    );
}
