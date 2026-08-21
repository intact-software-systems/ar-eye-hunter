import type { DistributedRecipeCatalogEntryProjection } from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { createExecuteWindowRevision } from './execute-window-revision.ts';
import styles from './ExecuteRecipeInspector.module.css';
import { ExecuteWindowedList } from './ExecuteWindowedList.tsx';

type Command = DistributedRecipeCatalogEntryProjection[
    'item'
]['recipe']['commands'][number];

export function ExecuteInspectorSequence({
    commands,
    contextKey
}: Readonly<{
    commands: readonly Command[];
    contextKey: string;
}>) {
    return (
        <div className={styles.sequence}>
            <h3>Command sequence</h3>
            <ExecuteWindowedList
                contentId="execute-inspector-commands-window"
                contextKey={contextKey}
                itemKey={(_command, index) => String(index)}
                itemLabel="commands"
                items={commands}
                label="Inspector commands"
                ordered
                renderItem={(command, index) => (
                    <li data-execute-inspector-command>
                        <span className={styles.sequenceNumber}>{index + 1}</span>
                        <span>
                            <strong>{command.label ?? command.kind}</strong>
                            <ExactIdentifier value={command.commandId ?? command.kind} />
                        </span>
                    </li>
                )}
                revisionKey={createExecuteWindowRevision(commands, (command) => [
                    command.commandId ?? null,
                    command.kind,
                    command.label ?? null
                ])}
                section="inspectorCommands"
            />
        </div>
    );
}
