import { StatePanel } from '../ui/StatePanel.tsx';
import styles from '../views/PreviewState.module.css';

export function FleetPreview() {
    return (
        <div className={styles.preview} data-preview-view="fleet">
            <StatePanel kind="error" title="Fleet live data unavailable in offline preview">
                <p className={styles.intro}>No control connection is available in offline preview.</p>
            </StatePanel>
            <p className={styles.intro}>
                Regions, agents, routes, and map layers appear only after validated control evidence is connected.
            </p>
        </div>
    );
}
