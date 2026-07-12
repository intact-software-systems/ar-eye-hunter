import type { ReactNode } from 'react';
import type { ExecutePreviewModel } from '../data/recipe-console-models.ts';
import { ControlOverview } from '../control/ControlOverview.tsx';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import { ExecutePreview } from './ExecutePreview.tsx';
import styles from './ExecuteWorkspace.module.css';

export function ExecuteWorkspace({
    connection,
    model,
    selection,
    onInspectorChange,
    onSelectAgent,
    onSelectControlRun,
    onTargetAvailabilityChange,
}: Readonly<{
    connection: RecipeConsoleControlConnection;
    model: ExecutePreviewModel;
    selection: RecipeConsoleControlSelection;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectAgent(agentId: string): void;
    onSelectControlRun(controlRunId: string): void;
    onTargetAvailabilityChange(available: boolean): void;
}>) {
    return (
        <div className={styles.workspace} data-execute-workspace>
            <ControlOverview
                connection={connection}
                onSelectAgent={onSelectAgent}
                onSelectControlRun={onSelectControlRun}
                selection={selection}
            />
            <ExecutePreview
                model={model}
                onInspectorChange={onInspectorChange}
                onTargetAvailabilityChange={onTargetAvailabilityChange}
            />
        </div>
    );
}
