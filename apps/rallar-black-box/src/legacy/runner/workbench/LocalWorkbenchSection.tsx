import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandQueueRow } from '../runner-contracts.ts';
import { ReportPanel } from '../advanced/ReportPanel.tsx';
import { BootstrapPanel } from './BootstrapPanel.tsx';
import { CommandQueuePanel } from './CommandQueuePanel.tsx';
import { ConfigurationPanel } from './ConfigurationPanel.tsx';
import { ControlPanel } from './ControlPanel.tsx';
import { WorkbenchPanel } from './WorkbenchPanel.tsx';

export function LocalWorkbenchSection({
    state,
    bootstrap,
    control,
    authSession,
    busy,
    runState,
    loadedFixtureId,
    lastError,
    queueRows,
    selectedCommandId,
    onSelectCommand,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    authSession?: AuthSession;
    busy: boolean;
    runState: string;
    loadedFixtureId?: string;
    lastError?: string;
    queueRows: readonly CommandQueueRow[];
    selectedCommandId?: string;
    onSelectCommand(commandId: string | undefined): void;
}) {
    return (
        <>
            <WorkbenchPanel
                busy={busy}
                runState={runState}
                loadedFixtureId={loadedFixtureId}
                lastError={lastError}
            />
            <ControlPanel state={state} control={control} />
            <BootstrapPanel bootstrap={bootstrap} />
            <ConfigurationPanel state={state} />
            <CommandQueuePanel
                rows={queueRows}
                selectedCommandId={selectedCommandId}
                onSelect={onSelectCommand}
            />
            <ReportPanel
                state={state}
                authSession={authSession}
            />
        </>
    );
}
