import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export interface ManualRallarWorkbenchOptions {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    /** Absent while the browser is signed out; the workbench then keeps its configured identity. */
    readonly authSession: AuthSession | undefined;
    readonly globalValues: CommandCenterGlobalValues;
    /** True once the operator edited the shared context, which then overrides the workbench targets. */
    readonly globalValuesEdited: boolean;
    onSelectCommand(commandId: string): void;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(key: K, value: CommandCenterGlobalValues[K]): void;
}
