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
                <li><strong>Core bundle</strong><span>distributed-run.json, manifest.json, and control-run.json are the required core files.</span></li>
                <li><strong>Evidence bundle</strong><span>report.json, results.jsonl, events.jsonl, failures.json, and metadata.json provide optional evidence.</span></li>
                <li><strong>Partial bundle</strong><span>Missing evidence stays explicit and never becomes a passing signal.</span></li>
            </ul>
        </div>
    );
}
