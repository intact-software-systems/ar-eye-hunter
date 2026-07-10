import type { RtcPerformanceView } from '../../../../rtc-diagnostics.ts';

export function RtcAgentMatrix({
    cells,
}: {
    cells: RtcPerformanceView['agentMatrix'];
}) {
    const laneIds = [...new Set(cells.map((cell) => cell.laneId))].slice(0, 8);
    const metrics: readonly RtcPerformanceView['agentMatrix'][number]['metric'][] = [
        'expected',
        'observed',
        'ready',
        'active',
        'stale',
        'missing',
    ];
    const cellByKey = new Map(cells.map((cell) => [
        `${cell.laneId}:${cell.metric}`,
        cell,
    ]));

    if (laneIds.length === 0) {
        return <div className="empty-state">No peer lanes observed yet</div>;
    }

    return (
        <div className="rtc-agent-matrix" role="table" aria-label="RTC peer lane matrix">
            <div className="rtc-agent-matrix-head" role="row">
                <span role="columnheader">lane</span>
                {metrics.map((metric) => (
                    <span role="columnheader" key={metric}>{metric}</span>
                ))}
            </div>
            {laneIds.map((laneId) => (
                <div className="rtc-agent-matrix-row" role="row" key={laneId}>
                    <strong role="rowheader">{laneId}</strong>
                    {metrics.map((metric) => {
                        const cell = cellByKey.get(`${laneId}:${metric}`);
                        return (
                            <span
                                className={`rtc-agent-matrix-cell ${cell?.status ?? 'muted'}`}
                                role="cell"
                                key={metric}
                            >
                                {cell?.value ?? 'no'}
                            </span>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}
