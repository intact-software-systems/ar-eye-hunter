import { resolveRallarBlackBoxConfigProviderMode } from '@shared-test/rallar-bb-test/browser-control-agent/validate-rallar-black-box-provider-config.ts';
import type {
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestState,
    RallarBlackBoxTestTransport
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    decodeBoolean,
    decodeFiniteNumber
} from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { getRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/test-state-accessors.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    type ManualWorkbenchTransport,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { recordValue } from '../../shared/record-value.ts';
import { stringValue } from '../../shared/string-value.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export interface ManualWorkbenchValuesInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    /** Absent while the browser is signed out; the values then come from the configuration and bootstrap. */
    readonly authSession: AuthSession | undefined;
    readonly globalValues: CommandCenterGlobalValues;
}

export function toManualWorkbenchValues(input: ManualWorkbenchValuesInput): ManualWorkbenchValues {
    const config = getRallarBlackBoxCurrentConfig(input.state);
    return {
        ...DEFAULT_MANUAL_WORKBENCH_VALUES,
        ...toManualTargetValues(input, config),
        transport: toManualTransport(config?.transport ?? input.bootstrap.transport),
        providerMode: config
            ? resolveRallarBlackBoxConfigProviderMode(config)
            : input.bootstrap.providerMode,
        ...toManualRallarSessionValues(input, recordValue(config?.rallar))
    };
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
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        actor: globalValues.clientId || authSession?.clientId || authSession?.username || config?.actor ||
            bootstrap.actor,
        sessionId: globalValues.sessionId,
        groupId: globalValues.roomId,
        scopeText: decodeJsonText(config?.defaults?.scope ?? configRallar.scope) ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.scopeText,
        roomRefText: decodeJsonText(config?.defaults?.roomRef ?? configRallar.roomRef) ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.roomRefText,
        minSnapshotVersion:
            decodeFiniteNumber(config?.defaults?.minSnapshotVersion ?? configRallar.minSnapshotVersion) ??
                DEFAULT_MANUAL_WORKBENCH_VALUES.minSnapshotVersion,
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
        rallarRegister: Boolean(bootstrap.rallarRegister) || (decodeBoolean(configRallar.register) ?? false),
        rallarRestoreSession: bootstrap.rallarRestoreSession || Boolean(authSession) ||
            (decodeBoolean(configRallar.restoreSession) ?? false),
        rallarLogoutOnClose: bootstrap.rallarLogoutOnClose || (decodeBoolean(configRallar.logoutOnClose) ?? false),
        rallarLeaveRoomOnClose: decodeBoolean(configRallar.leaveRoomOnClose) ?? bootstrap.rallarLeaveRoomOnClose
    };
}

function toManualTransport(
    transport: RallarBlackBoxTestTransport | undefined
): ManualWorkbenchTransport {
    return transport === 'messages.rtc' || transport === 'ws'
        ? transport
        : 'realtime';
}

function decodeJsonText(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
