import type { AuthSession } from '@shared/api/api-config.ts';
import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { DEFAULT_MANUAL_WORKBENCH_VALUES } from '../../manual-workbench.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../runtime-store.ts';
import { recordValue as optionalRecord } from '../shared/record-value.ts';
import { stringValue } from '../shared/string-value.ts';

export type CommandCenterGlobalValues = Readonly<{
    apiBaseUrl: string;
    applicationId: string;
    workspaceId: string;
    clientId: string;
    sessionId: string;
    roomId: string;
}>;

export function commandCenterGlobalValuesFromState(
    state: RallarBlackBoxTestState,
    bootstrap: RallarBlackBoxBootstrapConfig,
    authSession?: AuthSession,
): CommandCenterGlobalValues {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const configRallar = optionalRecord(config?.rallar);
    return {
        apiBaseUrl: config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        applicationId:
            stringValue(
                config?.defaults?.applicationId ?? configRallar.applicationId,
            ) ?? DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId:
            stringValue(
                config?.defaults?.workspaceId ?? configRallar.workspaceId,
            ) ?? DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        clientId:
            authSession?.clientId ??
            authSession?.username ??
            config?.actor ??
            bootstrap.actor,
        sessionId:
            authSession?.sessionId ?? config?.sessionId ?? bootstrap.sessionId,
        roomId: config?.roomId ?? bootstrap.roomId,
    };
}

export function sameCommandCenterGlobalValues(
    left: CommandCenterGlobalValues,
    right: CommandCenterGlobalValues,
): boolean {
    return (
        left.apiBaseUrl === right.apiBaseUrl &&
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.clientId === right.clientId &&
        left.sessionId === right.sessionId &&
        left.roomId === right.roomId
    );
}

export function bootstrapPatchFromGlobalValues(
    values: CommandCenterGlobalValues,
): Partial<RallarBlackBoxBootstrapConfig> {
    return {
        apiBaseUrl: values.apiBaseUrl,
        actor: values.clientId,
        sessionId: values.sessionId,
        roomId: values.roomId,
    };
}
