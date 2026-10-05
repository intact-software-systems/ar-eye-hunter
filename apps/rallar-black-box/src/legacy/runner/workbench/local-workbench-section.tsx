import type { RallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import type { RallarBlackBoxControlSnapshot } from '@shared-test/rallar-bb-test/control-client.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { ReportPanel } from '../advanced/report-panel.tsx';
import type { CommandQueueRow } from '../runner-contracts.ts';
import { BootstrapPanel } from './BootstrapPanel.tsx';
import { CommandQueuePanel } from './CommandQueuePanel.tsx';
import { ConfigurationPanel } from './ConfigurationPanel.tsx';
import { ControlPanel } from './ControlPanel.tsx';
import { WorkbenchPanel } from './WorkbenchPanel.tsx';

export interface LocalWorkbenchSectionProps {
    readonly active: boolean;
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly control: RallarBlackBoxControlSnapshot;
    readonly authSession?: AuthSession;
    readonly busy: boolean;
    readonly runState: string;
    readonly loadedFixtureId?: string;
    readonly lastError?: string;
    readonly queueRows: readonly CommandQueueRow[];
    readonly selectedCommandId?: string;
    onSelectCommand(commandId: string | undefined): void;
}

export function LocalWorkbenchSection({
    active,
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
    onSelectCommand
}: LocalWorkbenchSectionProps) {
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
                active={active}
                state={state}
                authSession={authSession}
            />
        </>
    );
}
