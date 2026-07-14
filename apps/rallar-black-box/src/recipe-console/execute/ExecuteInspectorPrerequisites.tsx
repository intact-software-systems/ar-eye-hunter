import { ExecuteWindowedList } from './ExecuteWindowedList.tsx';
import { createExecuteWindowRevision } from './execute-window-revision.ts';
import styles from './ExecuteRecipeInspector.module.css';

export function ExecuteInspectorPrerequisites({
    contextKey,
    prerequisites,
}: Readonly<{
    contextKey: string;
    prerequisites: readonly string[];
}>) {
    return <div className={styles.prerequisites}>
        <h3>Catalog prerequisites</h3>
        <ExecuteWindowedList
            contentId="execute-inspector-prerequisites-window"
            contextKey={contextKey}
            itemKey={(_prerequisite, index) => String(index)}
            itemLabel="prerequisites"
            items={prerequisites}
            label="Inspector prerequisites"
            renderItem={prerequisite => (
                <li data-execute-inspector-prerequisite>{prerequisite}</li>
            )}
            revisionKey={createExecuteWindowRevision(
                prerequisites,
                prerequisite => prerequisite,
            )}
            section="inspectorPrerequisites"
        />
    </div>;
}
