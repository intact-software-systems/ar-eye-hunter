import type { RallarBlackBoxControlSnapshot } from '../../control-client.ts';
import { Metric } from '../shared/Metric.tsx';

export function RunnerModeBoundaryPanel({
    control,
}: {
    control: RallarBlackBoxControlSnapshot;
}) {
    return (
        <section
            className="panel runner-mode-boundary-panel"
            aria-label="Runner mode boundary"
        >
            <div className="panel-heading">
                <h2>Runner Workspace</h2>
                <span className="pill active">recipes and artifacts</span>
            </div>
            <div className="direct-rallar-grid">
                <Metric label="Control" value={control.state} />
                <Metric label="Mode" value="black-box-runner" />
                <Metric label="Direct facade" value="not used" tone="muted" />
                <Metric
                    label="Primary tabs"
                    value="Shared Test / Local Workbench / Flow Builder / Run Manager"
                />
            </div>
        </section>
    );
}
