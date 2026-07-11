import { StatePanel } from '../ui/StatePanel.tsx';
import styles from '../views/PreviewState.module.css';

export function AnalyzePreview() {
    return (
        <div className={styles.preview} data-preview-view="analyze">
            <StatePanel kind="empty" title="Seeded artifact readiness">
                <p className={styles.intro}>
                    No artifact is loaded in this offline preview. Iteration 6 adds the verified import workflow.
                </p>
            </StatePanel>
            <ul aria-label="Supported artifact bundle states" className={styles.ledger}>
                <li><strong>Core bundle</strong><span>Manifest, distributed run, control run, and report are present.</span></li>
                <li><strong>Evidence bundle</strong><span>Results, events, failures, and metadata are available for analysis.</span></li>
                <li><strong>Partial bundle</strong><span>Missing evidence stays explicit and never becomes a passing signal.</span></li>
            </ul>
        </div>
    );
}
