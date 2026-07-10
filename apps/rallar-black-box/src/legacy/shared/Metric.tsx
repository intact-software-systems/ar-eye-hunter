export function Metric({
    label,
    value,
    tone = 'muted',
}: {
    label: string;
    value: string;
    tone?: string;
}) {
    return (
        <div className="metric">
            <span>{label}</span>
            <strong className={tone}>{value}</strong>
        </div>
    );
}
