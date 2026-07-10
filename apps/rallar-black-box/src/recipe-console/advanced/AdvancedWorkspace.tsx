import { AdvancedContextSummary } from './AdvancedContextSummary.tsx';
import { AdvancedSurfaceSections } from './AdvancedSurfaceSections.tsx';
import type { AdvancedWorkspaceProps } from './advanced-workspace-contract.ts';
import { createAdvancedWorkspaceModel } from './advanced-workspace-model.ts';
import styles from './AdvancedWorkspace.module.css';

export default function AdvancedWorkspace(props: AdvancedWorkspaceProps) {
    const model = createAdvancedWorkspaceModel(props);
    return (
        <div
            className={styles.workspace}
            data-advanced-workspace
            data-preview-view="advanced"
        >
            <AdvancedContextSummary model={model} />
            <AdvancedSurfaceSections sections={model.sections} />
        </div>
    );
}
