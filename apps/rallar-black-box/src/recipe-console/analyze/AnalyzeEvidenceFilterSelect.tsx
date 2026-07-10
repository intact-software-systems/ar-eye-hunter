export function AnalyzeEvidenceFilterSelect({
    label,
    options,
    value: selected,
    onChange,
}: Readonly<{
    label: string;
    options: readonly string[];
    value?: string;
    onChange(value: string | undefined): void;
}>) {
    return (
        <label>
            <span>{label}</span>
            <select
                aria-label={`${label} filter`}
                onChange={event => onChange(event.target.value || undefined)}
                value={selected ?? ''}
            >
                <option value="">Any {label.toLowerCase()}</option>
                {options.map(option => (
                    <option key={option} value={option}>{option}</option>
                ))}
            </select>
        </label>
    );
}
