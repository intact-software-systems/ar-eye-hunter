import type { FleetReportWindow } from
    '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import type { ControlFleetRegionSummary } from
    '@shared-test/rallar-bb-test/fleet-report.ts';
import { fleetRegionProviderKey } from './fleet-region-key.ts';
import styles from './FleetEvidence.module.css';

export function FleetRegions({
    onSelectRegion,
    regions,
    selectedRegion,
}: Readonly<{
    onSelectRegion(region: string | undefined, trigger: HTMLButtonElement): void;
    regions: FleetReportWindow<ControlFleetRegionSummary>;
    selectedRegion?: string;
}>) {
    return (
        <section aria-labelledby="fleet-regions-heading" className={styles.panel}>
            <header className={styles.heading}>
                <div>
                    <span className={styles.eyebrow}>Repeated regional truth</span>
                    <h2 id="fleet-regions-heading">Regions</h2>
                </div>
                <p>{windowTruth(regions.items.length, regions.total, 'regions')}</p>
            </header>
            {regions.items.length === 0 ? <p className={styles.empty}>No regional evidence.</p> : (
                <div className={styles.cards}>{regions.items.map(region => {
                    const selected = region.region === selectedRegion;
                    return (
                        <button
                            aria-pressed={selected}
                            className={styles.cardButton}
                            data-fleet-region={region.region}
                            key={fleetRegionProviderKey(
                                region.region,
                                region.provider,
                            )}
                            onClick={(event) => onSelectRegion(
                                selected ? undefined : region.region,
                                event.currentTarget,
                            )}
                            type="button"
                        >
                            <bdi className={styles.cardTitle} dir="auto">
                                {region.region}
                            </bdi>
                            <bdi dir="auto">{region.provider ?? 'Unknown provider'}</bdi>
                            <strong>{percent(region.passRate)} pass</strong>
                            <span>{region.failed} failed · {region.missing} missing · {region.stale} stale</span>
                            <span>p95 {milliseconds(region.timing.p95Ms)}</span>
                        </button>
                    );
                })}</div>
            )}
        </section>
    );
}

function windowTruth(visible: number, total: number, label: string): string {
    return `${visible.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${label}`;
}

function percent(value: number): string {
    return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

function milliseconds(value: number | undefined): string {
    return value === undefined ? 'unavailable' : `${value.toLocaleString('en-US')} ms`;
}
