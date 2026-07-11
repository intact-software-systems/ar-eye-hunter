import type { ControlFleetTimingDistribution } from '../../../../control-run-manager.ts';
import { formatFleetDuration } from '../../shared/performance-format.ts';
import type { FleetTimingGroup } from '../fleet-types.ts';

export function FleetTimingGroupList({
    title,
    groups,
}: {
    title: string;
    groups: readonly FleetTimingGroup[];
}) {
    return (
        <section>
            <h4>{title}</h4>
            <div className="fleet-timing-list">
                {groups.map((group) => (
                    <div className="fleet-timing-row" key={group.id}>
                        <span>{group.label}</span>
                        <FleetTimingStrip timing={group.timing} />
                        <small>
                            {formatFleetDuration(group.timing.p50Ms)} /{' '}
                            {formatFleetDuration(group.timing.p95Ms)}
                        </small>
                    </div>
                ))}
                {groups.length === 0 && (
                    <div className="empty-state">No timing samples</div>
                )}
            </div>
        </section>
    );
}

function FleetTimingStrip({
    timing,
}: {
    timing: ControlFleetTimingDistribution;
}) {
    const min = timing.minMs ?? 0;
    const max = timing.maxMs ?? min + 1;
    const spread = Math.max(1, max - min);
    const position = (value: number | undefined): number => {
        if (value === undefined) {
            return 0;
        }
        return Math.max(0, Math.min(100, ((value - min) / spread) * 100));
    };
    const p50 = position(timing.p50Ms);
    const p95 = position(timing.p95Ms);
    return (
        <svg
            className="fleet-timing-strip"
            viewBox="0 0 100 16"
            role="img"
            aria-label={`timing ${timing.count} samples`}
        >
            <line x1="2" y1="8" x2="98" y2="8" />
            <rect x={Math.min(p50, p95)} y="4" width={Math.max(2, Math.abs(p95 - p50))} height="8" />
            <circle cx={p50} cy="8" r="3" />
            <circle cx={p95} cy="8" r="3" />
        </svg>
    );
}
