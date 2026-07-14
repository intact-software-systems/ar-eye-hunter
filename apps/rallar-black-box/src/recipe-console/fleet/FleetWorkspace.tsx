import styles from './FleetWorkspace.module.css';
import { FleetWorkspaceEvidence } from './FleetWorkspaceEvidence.tsx';
import type { FleetWorkspaceProps } from './fleet-workspace-contract.ts';
import { useFleetInspectionHost } from './use-fleet-inspection-host.tsx';
import { useFleetWorkspace } from './use-fleet-workspace.ts';
import { useFleetWorkspaceActions } from './use-fleet-workspace-actions.ts';

export default function FleetWorkspace(props: FleetWorkspaceProps) {
    const workspace = useFleetWorkspace(props);
    const actions = useFleetWorkspaceActions(props, workspace);
    useFleetInspectionHost(props, workspace, actions);
    return (
        <div
            aria-label="Fleet evidence"
            className={styles.workspace}
            data-fleet-workspace
            data-preview-view="fleet"
            role="region"
            tabIndex={0}
        >
            <FleetWorkspaceEvidence
                actions={actions}
                input={props}
                workspace={workspace}
            />
        </div>
    );
}
