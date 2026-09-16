import type {
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestState,
    RallarBlackBoxTestTransport
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
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

export interface ManualWorkbenchValuesInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly authSession: AuthSession | undefined;
    readonly globalValues: CommandCenterGlobalValues | undefined;
}

export function toManualWorkbenchValues(input: ManualWorkbenchValuesInput): ManualWorkbenchValues {
    const config = selectRallarBlackBoxCurrentConfig(input.state);
    return {
        ...DEFAULT_MANUAL_WORKBENCH_VALUES,
        ...toManualTargetValues(input, config),
        transport: toManualTransport(config?.transport ?? input.bootstrap.transport),
        providerMode: config
            ? rallarBlackBoxProviderModeFromConfig(config)
            : input.bootstrap.providerMode,
        ...toManualRallarSessionValues(input, recordValue(config?.rallar))
    };
}

export function toManualActionLabel(action: ManualWorkbenchAction): string {
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

type ManualTargetValues = Pick<
    ManualWorkbenchValues,
    | 'environment'
    | 'apiBaseUrl'
    | 'applicationId'
    | 'workspaceId'
    | 'actor'
    | 'sessionId'
    | 'groupId'
    | 'scopeText'
    | 'roomRefText'
    | 'minSnapshotVersion'
    | 'connection'
>;
type ManualRallarSessionValues = Pick<
    ManualWorkbenchValues,
    | 'rallarUsername'
    | 'rallarPassword'
    | 'rallarRegister'
    | 'rallarRestoreSession'
    | 'rallarLogoutOnClose'
    | 'rallarLeaveRoomOnClose'
>;

function toManualTargetValues(
    { bootstrap, authSession, globalValues }: ManualWorkbenchValuesInput,
    config: RallarBlackBoxTestConfig | undefined
): ManualTargetValues {
    const configRallar = recordValue(config?.rallar);
    return {
        environment: config?.environment ?? bootstrap.environment,
        apiBaseUrl: globalValues?.apiBaseUrl ?? config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        applicationId: globalValues?.applicationId ??
            stringValue(config?.defaults?.applicationId ?? configRallar.applicationId) ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId: globalValues?.workspaceId ??
            stringValue(config?.defaults?.workspaceId ?? configRallar.workspaceId) ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        actor: globalValues?.clientId || authSession?.clientId || authSession?.username || config?.actor ||
            bootstrap.actor,
        sessionId: globalValues?.sessionId ?? authSession?.sessionId ?? config?.sessionId ?? bootstrap.sessionId,
        groupId: globalValues?.roomId ?? config?.roomId ?? bootstrap.roomId,
        scopeText: decodeJsonText(
            config?.defaults?.scope ?? configRallar.scope,
            DEFAULT_MANUAL_WORKBENCH_VALUES.scopeText
        ),
        roomRefText: decodeJsonText(
            config?.defaults?.roomRef ?? configRallar.roomRef,
            DEFAULT_MANUAL_WORKBENCH_VALUES.roomRefText
        ),
        minSnapshotVersion: decodeFiniteNumber(
            config?.defaults?.minSnapshotVersion ?? configRallar.minSnapshotVersion,
            DEFAULT_MANUAL_WORKBENCH_VALUES.minSnapshotVersion
        ),
        connection: String(config?.defaults?.connection ?? DEFAULT_MANUAL_WORKBENCH_VALUES.connection)
    };
}

function toManualRallarSessionValues(
    { bootstrap, authSession }: ManualWorkbenchValuesInput,
    configRallar: Readonly<Record<string, unknown>>
): ManualRallarSessionValues {
    return {
        rallarUsername: bootstrap.rallarUsername ?? authSession?.username ?? stringValue(configRallar.username),
        rallarPassword: bootstrap.rallarPassword,
        rallarRegister: Boolean(bootstrap.rallarRegister) || decodeBoolean(configRallar.register, false),
        rallarRestoreSession: bootstrap.rallarRestoreSession || Boolean(authSession) ||
            decodeBoolean(configRallar.restoreSession, false),
        rallarLogoutOnClose: bootstrap.rallarLogoutOnClose || decodeBoolean(configRallar.logoutOnClose, false),
        rallarLeaveRoomOnClose: decodeBoolean(configRallar.leaveRoomOnClose, bootstrap.rallarLeaveRoomOnClose)
    };
}

function toManualTransport(
    transport: RallarBlackBoxTestTransport | undefined
): ManualWorkbenchTransport {
    return transport === 'messages.rtc' || transport === 'ws'
        ? transport
        : 'realtime';
}

function decodeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function decodeJsonText(value: unknown, fallback: string): string {
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

function decodeFiniteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
}
