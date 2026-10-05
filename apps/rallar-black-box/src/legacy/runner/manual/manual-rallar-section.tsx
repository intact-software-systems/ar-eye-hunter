import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { CommandHistoryPanel } from '../advanced/CommandHistoryPanel.tsx';
import { ManualRallarWorkbenchPanel, type ManualRallarWorkbenchPanelProps } from './manual-rallar-workbench-panel.tsx';
import { ReceivedDataInboxPanel } from './received-data-inbox-panel.tsx';

export interface ManualRallarSectionProps extends ManualRallarWorkbenchPanelProps {
    readonly active: boolean;
    readonly history: readonly RallarBlackBoxTestResult[];
    /** Absent until the operator selects a command in the history. */
    readonly selectedCommandId: string | undefined;
}

export function ManualRallarSection({
    active,
    state,
    bootstrap,
    authSession,
    globalValues,
    globalValuesEdited,
    busy,
    history,
    selectedCommandId,
    onSelectCommand,
    onGlobalValueChange
}: ManualRallarSectionProps) {
    return (
        <>
            <ManualRallarWorkbenchPanel
                state={state}
                bootstrap={bootstrap}
                authSession={authSession}
                globalValues={globalValues}
                globalValuesEdited={globalValuesEdited}
                busy={busy}
                onSelectCommand={onSelectCommand}
                onGlobalValueChange={onGlobalValueChange}
            />
            {active && (
                <>
                    <ReceivedDataInboxPanel
                        state={state}
                        onSelectCommand={onSelectCommand}
                    />
                    <CommandHistoryPanel
                        history={history}
                        selectedCommandId={selectedCommandId}
                        onSelect={onSelectCommand}
                    />
                </>
            )}
        </>
    );
}
