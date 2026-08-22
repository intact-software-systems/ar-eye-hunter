import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { DEFAULT_MANUAL_WORKBENCH_VALUES } from '../../manual-workbench.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../runtime-store.ts';
import type { LegacyDiagnosticContext } from '../diagnostics/context/legacy-diagnostic-context.ts';
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
    diagnosticContext?: LegacyDiagnosticContext
): CommandCenterGlobalValues {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const configRallar = optionalRecord(config?.rallar);
    return {
        apiBaseUrl: config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        applicationId: diagnosticContext?.contextApplicationId ??
            stringValue(
                config?.defaults?.applicationId ?? configRallar.applicationId
            ) ?? DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId: diagnosticContext?.contextWorkspaceId ??
            stringValue(
                config?.defaults?.workspaceId ?? configRallar.workspaceId
            ) ?? DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        clientId: authSession?.clientId ??
            authSession?.username ??
            config?.actor ??
            bootstrap.actor,
        sessionId: authSession?.sessionId ?? config?.sessionId ?? bootstrap.sessionId,
        roomId: diagnosticContext?.contextGroupId ??
            config?.roomId ??
            bootstrap.roomId
    };
}

export function sameCommandCenterGlobalValues(
    left: CommandCenterGlobalValues,
    right: CommandCenterGlobalValues
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

export function reconcileDiagnosticGlobalScope(
    current: CommandCenterGlobalValues,
    defaults: CommandCenterGlobalValues,
    diagnosticContextChanged: boolean
): CommandCenterGlobalValues {
    if (!diagnosticContextChanged) {
        return current;
    }
    return {
        ...current,
        applicationId: defaults.applicationId,
        workspaceId: defaults.workspaceId,
        roomId: defaults.roomId
    };
}

export function bootstrapPatchFromGlobalValues(
    values: CommandCenterGlobalValues
): Partial<RallarBlackBoxBootstrapConfig> {
    return {
        apiBaseUrl: values.apiBaseUrl,
        actor: values.clientId,
        sessionId: values.sessionId,
        roomId: values.roomId
    };
}
