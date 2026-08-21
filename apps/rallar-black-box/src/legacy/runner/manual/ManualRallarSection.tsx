import type { RallarBlackBoxTestResult, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { CommandHistoryPanel } from '../advanced/CommandHistoryPanel.tsx';
import { ManualRallarWorkbenchPanel } from './ManualRallarWorkbenchPanel.tsx';
import { ReceivedDataInboxPanel } from './ReceivedDataInboxPanel.tsx';

export function ManualRallarSection({
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
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    globalValuesEdited?: boolean;
    busy: boolean;
    history: readonly RallarBlackBoxTestResult[];
    selectedCommandId?: string;
    onSelectCommand(commandId: string): void;
    onGlobalValueChange?<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K]
    ): void;
}) {
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
    );
}
