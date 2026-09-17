import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';
import { decodeFiniteNumber, decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

export interface RunnerCommandIdInput {
    readonly prefix: string;
    readonly connection: string;
    readonly action: 'connect' | 'send' | 'close';
    readonly sequence: number;
    readonly request: RallarBlackBoxTestRecord;
}

export interface RunnerSendCommandInput {
    readonly request: RallarBlackBoxTestRecord;
    readonly connection: string;
    readonly commandId: string;
    readonly message: RallarBlackBoxTestJsonValue;
    /** Absent when the runner sends outside a recorded interaction. */
    readonly interaction: RallarBlackBoxTestRecord | undefined;
}

interface RallarScopeFields {
    /** Absent when neither the request nor its scope or room names an application. */
    readonly applicationId?: string;
    /** Absent when neither the request nor its scope or room names a workspace. */
    readonly workspaceId?: string;
    /** Absent when the request names no application. */
    readonly scope?: RallarBlackBoxTestRecord;
    /** Absent when the request names neither a complete room reference nor a room in an application. */
    readonly roomRef?: RallarBlackBoxTestRecord;
    /** Absent when the request names no minimum snapshot version. */
    readonly minSnapshotVersion?: number;
}

type RtcSendTransport = Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
type RtcConnectTransport = Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc' | 'messages.ws'>;

const RTC_SEND_TRANSPORTS: readonly RtcSendTransport[] = ['realtime', 'messages.rtc'];
const RTC_CONNECT_TRANSPORTS: readonly RtcConnectTransport[] = ['realtime', 'messages.rtc', 'messages.ws'];

export function toRunnerCommandId(input: RunnerCommandIdInput): string {
    const { request } = input;
    const generated = [
        input.prefix,
        input.connection,
        input.action,
        request.scenarioExecutionNumber,
        request.interactionExecutionNumber,
        request.repeatIndex,
        input.sequence
    ].filter((part) => part !== undefined && part !== '').join('-');
    return String(request.commandId ?? generated);
}

function toRallarScope(request: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord | undefined {
    const rallar = decodeRecord(request.rallar);
    const scope = decodeRecord(request.scope ?? rallar.scope);
    const roomRef = decodeRecord(request.roomRef ?? rallar.roomRef);
    const applicationId = request.applicationId ?? rallar.applicationId ?? scope.applicationId ?? roomRef.applicationId;
    if (applicationId === undefined || applicationId === null) {
        return undefined;
    }

    const workspaceId = request.workspaceId ?? rallar.workspaceId ?? scope.workspaceId ?? roomRef.workspaceId;
    return {
        applicationId: String(applicationId),
        ...(workspaceId === undefined || workspaceId === null ? {} : { workspaceId: String(workspaceId) })
    };
}

function toRallarRoomRef(
    request: RallarBlackBoxTestRecord,
    scope: RallarBlackBoxTestRecord | undefined
): RallarBlackBoxTestRecord | undefined {
    const rallar = decodeRecord(request.rallar);
    const explicitRoomRef = decodeRecord(request.roomRef ?? rallar.roomRef);
    if (explicitRoomRef.applicationId && explicitRoomRef.groupId) {
        return {
            applicationId: String(explicitRoomRef.applicationId),
            ...(explicitRoomRef.workspaceId === undefined ? {} : { workspaceId: String(explicitRoomRef.workspaceId) }),
            groupId: String(explicitRoomRef.groupId)
        };
    }

    const roomId = request.roomId ?? rallar.roomId;
    return roomId && scope?.applicationId
        ? {
            applicationId: scope.applicationId,
            ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
            groupId: String(roomId)
        }
        : undefined;
}

function toRallarScopeFields(request: RallarBlackBoxTestRecord): RallarScopeFields {
    const scope = toRallarScope(request);
    const roomRef = toRallarRoomRef(request, scope);
    const minSnapshotVersion = decodeFiniteNumber(
        request.minSnapshotVersion ?? decodeRecord(request.rallar).minSnapshotVersion
    );
    return {
        ...(typeof scope?.applicationId === 'string' && scope.applicationId.length > 0
            ? { applicationId: scope.applicationId }
            : {}),
        ...(typeof scope?.workspaceId === 'string' ? { workspaceId: scope.workspaceId } : {}),
        ...(scope ? { scope } : {}),
        ...(roomRef ? { roomRef } : {}),
        ...(minSnapshotVersion === undefined ? {} : { minSnapshotVersion })
    };
}

export function toConnectCommand(
    request: RallarBlackBoxTestRecord,
    connection: string,
    commandId: string
): RallarBlackBoxTestCommand {
    const rallar = decodeRecord(request.rallar);
    const scopeFields = toRallarScopeFields(request);
    const apiBaseUrl = rallar.apiBaseUrl ?? request.apiBaseUrl ?? request.rallarApiBaseUrl;
    const transport = decodeRtcConnectTransport(rallar.transport ?? request.transport);
    return {
        kind: 'rtc.connect',
        commandId,
        connection,
        actor: typeof request.actor === 'string' ? request.actor : undefined,
        roomId: typeof request.roomId === 'string' ? request.roomId : undefined,
        ...scopeFields,
        transport,
        rallar: {
            ...rallar,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            ...(transport ? { transport } : {}),
            ...scopeFields
        },
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request
        }
    };
}

/** A record message gains the request's scope facts it does not name itself; any other message is wrapped as data. */
export function toSendCommand(input: RunnerSendCommandInput): RallarBlackBoxTestCommand {
    const { request, message } = input;
    const scopeFields = toRallarScopeFields(request);
    const scopeEntries = Object.entries(scopeFields);
    const send = isJsonRecordValue(message)
        ? { ...message, ...Object.fromEntries(scopeEntries.filter(([key]) => !(key in message))) }
        : scopeEntries.length > 0
        ? { data: message, ...scopeFields }
        : message;
    return {
        kind: 'rtc.send',
        commandId: input.commandId,
        connection: input.connection,
        send,
        expect: input.interaction?.response,
        ...scopeFields,
        transport: decodeRtcSendTransport(decodeRecord(request.rallar).transport ?? request.transport),
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request
        }
    };
}

function decodeRtcSendTransport(value: unknown): RtcSendTransport | undefined {
    return typeof value === 'string'
        ? RTC_SEND_TRANSPORTS.find((transport) => transport === value)
        : undefined;
}

function decodeRtcConnectTransport(value: unknown): RtcConnectTransport | undefined {
    return typeof value === 'string'
        ? RTC_CONNECT_TRANSPORTS.find((transport) => transport === value)
        : undefined;
}
