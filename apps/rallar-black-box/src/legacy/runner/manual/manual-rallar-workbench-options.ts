import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export interface ManualRallarWorkbenchOptions {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly authSession: AuthSession | undefined;
    readonly globalValues: CommandCenterGlobalValues | undefined;
    readonly globalValuesEdited: boolean | undefined;
    onSelectCommand(commandId: string): void;
    readonly onGlobalValueChange: CommandCenterGlobalValueChange | undefined;
}

type CommandCenterGlobalValueChange = <K extends keyof CommandCenterGlobalValues>(
    key: K,
    value: CommandCenterGlobalValues[K]
) => void;
