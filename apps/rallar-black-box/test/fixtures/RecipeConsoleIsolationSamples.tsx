import { MetricStrip } from '../../src/recipe-console/ui/MetricStrip.tsx';
import { StatusMark, type OperationalStatus } from '../../src/recipe-console/ui/StatusMark.tsx';
import styles from '../../src/recipe-console/ui/primitives.module.css';

const STATUSES: readonly OperationalStatus[] = [
    'running', 'passed', 'failed', 'warning', 'stale', 'partial', 'disabled',
];

export function RecipeConsoleIsolationSamples() {
    return (
        <main className="recipe-console" style={{ minHeight: '100vh', padding: 24 }}>
            <section className={styles.surface} data-isolation-recipe-surface style={{ padding: 16 }}>
                <h1>Recipe Console samples</h1>
                <p>Scoped controls remain stable beside the legacy system.</p>
                <button className={styles.primaryButton} data-isolation-recipe-button type="button">
                    Start Preview
                </button>
                <MetricStrip items={[
                    { label: 'Targets', value: '2/2' },
                    { label: 'Commands', value: 5 },
                ]} />
                <div aria-label="Operational statuses">
                    {STATUSES.map(status => <StatusMark key={status} status={status} />)}
                </div>
                <label>
                    Recipe search
                    <input defaultValue="RTC Realtime Stability" />
                </label>
                <table>
                    <thead><tr><th>Agent</th><th>State</th></tr></thead>
                    <tbody><tr><td>seed-agent-a</td><td>Matched</td></tr></tbody>
                </table>
            </section>
        </main>
    );
}
