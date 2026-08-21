import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState, RallarBlackBoxTestTransport } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    type ManualWorkbenchAction,
    type ManualWorkbenchTransport,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import { rallarBlackBoxProviderModeFromConfig, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { recordValue } from '../../shared/record-value.ts';
import { stringValue } from '../../shared/string-value.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

function manualTransportFrom(
    transport: RallarBlackBoxTestTransport | undefined
): ManualWorkbenchTransport {
    return transport === 'messages.rtc' || transport === 'ws'
        ? transport
        : 'realtime';
}

function booleanValue(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function jsonTextValue(value: unknown, fallback = ''): string {
    if (typeof value === 'string') {
        return value;
    }

    if (value && typeof value === 'object') {
        try {
            return JSON.stringify(value);
        }
        catch {
            return fallback;
        }
    }

    return fallback;
}

function numberValue(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
}

export function manualValuesFromState(
    state: RallarBlackBoxTestState,
    bootstrap: RallarBlackBoxBootstrapConfig,
    authSession?: AuthSession,
    globalValues?: CommandCenterGlobalValues
): ManualWorkbenchValues {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const configRallar = recordValue(config?.rallar);
    const clientId = globalValues?.clientId ||
        authSession?.clientId ||
        authSession?.username ||
        config?.actor ||
        bootstrap.actor;
    return {
        ...DEFAULT_MANUAL_WORKBENCH_VALUES,
        environment: config?.environment ?? bootstrap.environment,
        apiBaseUrl: globalValues?.apiBaseUrl ??
            config?.apiBaseUrl ??
            bootstrap.apiBaseUrl,
        applicationId: globalValues?.applicationId ??
            stringValue(
                config?.defaults?.applicationId ?? configRallar.applicationId
            ) ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId: globalValues?.workspaceId ??
            stringValue(
                config?.defaults?.workspaceId ?? configRallar.workspaceId
            ) ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        actor: clientId,
        sessionId: globalValues?.sessionId ??
            authSession?.sessionId ??
            config?.sessionId ??
            bootstrap.sessionId,
        groupId: globalValues?.roomId ?? config?.roomId ?? bootstrap.roomId,
        scopeText: jsonTextValue(
            config?.defaults?.scope ?? configRallar.scope,
            DEFAULT_MANUAL_WORKBENCH_VALUES.scopeText
        ),
        roomRefText: jsonTextValue(
            config?.defaults?.roomRef ?? configRallar.roomRef,
            DEFAULT_MANUAL_WORKBENCH_VALUES.roomRefText
        ),
        minSnapshotVersion: numberValue(
            config?.defaults?.minSnapshotVersion ??
                configRallar.minSnapshotVersion,
            DEFAULT_MANUAL_WORKBENCH_VALUES.minSnapshotVersion
        ),
        connection: String(
            config?.defaults?.connection ??
                DEFAULT_MANUAL_WORKBENCH_VALUES.connection
        ),
        transport: manualTransportFrom(
            config?.transport ?? bootstrap.transport
        ),
        providerMode: config
            ? rallarBlackBoxProviderModeFromConfig(config)
            : bootstrap.providerMode,
        rallarUsername: bootstrap.rallarUsername ??
            authSession?.username ??
            stringValue(configRallar.username),
        rallarPassword: bootstrap.rallarPassword,
        rallarRegister: Boolean(bootstrap.rallarRegister) ||
            booleanValue(configRallar.register),
        rallarRestoreSession: bootstrap.rallarRestoreSession ||
            Boolean(authSession) ||
            booleanValue(configRallar.restoreSession),
        rallarLogoutOnClose: bootstrap.rallarLogoutOnClose ||
            booleanValue(configRallar.logoutOnClose),
        rallarLeaveRoomOnClose: booleanValue(
            configRallar.leaveRoomOnClose,
            bootstrap.rallarLeaveRoomOnClose
        )
    };
}

export function actionLabel(action: ManualWorkbenchAction): string {
    switch (action) {
        case 'configure':
            return 'Configure group';
        case 'join':
            return 'Create and join group';
        case 'connect':
            return 'Connect';
        case 'send':
            return 'Send payload';
        case 'health':
            return 'Health check';
        case 'close':
            return 'Close connections';
        case 'reset':
            return 'Reset runtime';
    }
}
