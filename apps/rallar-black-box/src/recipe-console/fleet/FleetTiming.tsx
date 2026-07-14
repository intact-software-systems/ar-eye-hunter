import type {
    FleetReportTimingGroup,
    FleetReportWindow,
} from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import styles from './FleetEvidence.module.css';

export function FleetTiming({
    recipeTiming,
    regionTiming,
}: Readonly<{
    recipeTiming: FleetReportWindow<FleetReportTimingGroup>;
    regionTiming: FleetReportWindow<FleetReportTimingGroup>;
}>) {
    return (
        <section aria-labelledby="fleet-timing-heading" className={styles.panel}>
            <header className={styles.heading}>
                <div>
                    <span className={styles.eyebrow}>Distribution evidence</span>
                    <h2 id="fleet-timing-heading">Region and recipe timing</h2>
                </div>
            </header>
            <div className={styles.split}>
                <TimingTable label="Region timing" window={regionTiming} />
                <TimingTable label="Recipe timing" window={recipeTiming} />
            </div>
        </section>
    );
}

function TimingTable({
    label,
    window,
}: Readonly<{
    label: string;
    window: FleetReportWindow<FleetReportTimingGroup>;
}>) {
    return (
        <div className={styles.tableScroll} tabIndex={0}>
            <table aria-label={label}>
                <caption>{label} · {window.items.length} of {window.total}</caption>
                <thead><tr>
                    <th scope="col">Group</th>
                    <th scope="col">Count</th>
                    <th scope="col">p50</th>
                    <th scope="col">p95</th>
                    <th scope="col">Max</th>
                </tr></thead>
                <tbody>{window.items.map(group => (
                    <tr key={group.id}>
                        <th scope="row">
                            {group.label === group.id
                                ? null
                                : <bdi dir="auto">{group.label}</bdi>}
                            <ExactIdentifier value={group.id} />
                        </th>
                        <td>{group.timing.count}</td>
                        <td>{ms(group.timing.p50Ms)}</td>
                        <td>{ms(group.timing.p95Ms)}</td>
                        <td>{ms(group.timing.maxMs)}</td>
                    </tr>
                ))}</tbody>
            </table>
        </div>
    );
}

function ms(value: number | undefined): string {
    return value === undefined ? '—' : `${value.toLocaleString('en-US')} ms`;
}
