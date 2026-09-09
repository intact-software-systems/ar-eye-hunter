// deno-lint-ignore-file no-explicit-any
import {
    createRtcProviderFromClientFactory,
    type RtcClient,
    type RtcProvider
} from '../black-box-runner/rtc-provider.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestTransport
} from './types.ts';

// The eight ALM kinds only exist inside a browser agent: this client owns an RTC connection, not a
// Rallar page runtime, so translating one of them into an rtc.send would hide the gap.
const BROWSER_ONLY_COMMAND_KINDS: ReadonlySet<string> = new Set([
    'messages.send',
    'messages.observe',
    'messages.cancel',
    'messages.received',
    'messages.receipts',
    'fault.inject',
    'storage.counters',
    'agent.reload'
]);

export function toBrowserOnlyCommandOutcome(
    request: RallarBlackBoxTestRecord
): RallarBlackBoxTestCommandOutcome | undefined {
    const kind = resolveBrowserOnlyCommandKind(request);
    return kind === undefined ? undefined : {
        status: 'failed',
        error: {
            code: 'browser-only-command',
            message: `${kind} requires a browser agent`
        }
    };
}

function resolveBrowserOnlyCommandKind(request: RallarBlackBoxTestRecord): string | undefined {
    const named = typeof request.kind === 'string' ? request.kind : request.action;
    return typeof named === 'string' && BROWSER_ONLY_COMMAND_KINDS.has(named) ? named : undefined;
}

export type RallarBlackBoxRtcClientAdapterOptions = Readonly<{
    commandIdPrefix?: string;
}>;

function asRecord(value: any): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}

function firstDefined(...values: any[]): any {
    return values.find((value) => value !== undefined);
}

function toRallarScope(request: any): Record<string, unknown> | undefined {
    const rallar = asRecord(request.rallar);
    const scope = asRecord(firstDefined(request.scope, rallar.scope));
    const roomRef = asRecord(firstDefined(request.roomRef, rallar.roomRef));
    const applicationId = firstDefined(
        request.applicationId,
        rallar.applicationId,
        scope.applicationId,
        roomRef.applicationId
    );
    if (applicationId === undefined) {
        return undefined;
    }

    const workspaceId = firstDefined(
        request.workspaceId,
        rallar.workspaceId,
        scope.workspaceId,
        roomRef.workspaceId
    );

    return {
        applicationId: String(applicationId),
        ...(workspaceId !== undefined ? { workspaceId: String(workspaceId) } : {})
    };
}

function toRallarRoomRef(request: any): Record<string, unknown> | undefined {
    const rallar = asRecord(request.rallar);
    const explicitRoomRef = asRecord(firstDefined(request.roomRef, rallar.roomRef));
    if (explicitRoomRef.applicationId && explicitRoomRef.groupId) {
        return {
            applicationId: String(explicitRoomRef.applicationId),
            ...(explicitRoomRef.workspaceId !== undefined
                ? { workspaceId: String(explicitRoomRef.workspaceId) }
                : {}),
            groupId: String(explicitRoomRef.groupId)
        };
    }

    const roomId = firstDefined(request.roomId, rallar.roomId);
    const scope = toRallarScope(request);
    if (!roomId || !scope?.applicationId) {
        return undefined;
    }

    return {
        applicationId: scope.applicationId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        groupId: String(roomId)
    };
}

function toRallarScopeFields(request: any): Record<string, unknown> {
    const rallar = asRecord(request.rallar);
    const scope = toRallarScope(request);
    const roomRef = toRallarRoomRef(request);
    const minSnapshotVersion = firstDefined(
        request.minSnapshotVersion,
        rallar.minSnapshotVersion
    );

    return {
        ...(scope?.applicationId ? { applicationId: scope.applicationId } : {}),
        ...(scope?.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope ? { scope } : {}),
        ...(roomRef ? { roomRef } : {}),
        ...(minSnapshotVersion !== undefined ? { minSnapshotVersion } : {})
    };
}

function toConnectionName(request: any): string {
    return String(firstDefined(
        request.connection,
        request.connectionId,
        request.actor,
        request.peerId,
        request.clientId,
        'default'
    ));
}

type RtcSendTransport = Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
type RtcConnectTransport = Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc' | 'messages.ws'>;

const RTC_SEND_TRANSPORTS: readonly RtcSendTransport[] = ['realtime', 'messages.rtc'];
const RTC_CONNECT_TRANSPORTS: readonly RtcConnectTransport[] = ['realtime', 'messages.rtc', 'messages.ws'];

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

function toCommandId(
    prefix: string,
    connection: string,
    action: string,
    sequence: number,
    request: any
): string {
    return String(firstDefined(
        request.commandId,
        request.rallarCommandId,
        [
            prefix,
            connection,
            action,
            request.scenarioExecutionNumber,
            request.interactionExecutionNumber,
            request.repeatIndex,
            sequence
        ].filter((value) => value !== undefined && value !== '').join('-')
    ));
}

function assertCommandSucceeded(result: RallarBlackBoxTestResult): void {
    if (result.ok) {
        return;
    }

    throw new Error(
        result.error?.message ??
            'Rallar black-box command failed: ' + result.commandId
    );
}

function eventBelongsToConnection(
    event: RallarBlackBoxTestEvent,
    connection: string
): boolean {
    return !event.connection || event.connection === connection;
}

function eventPayloadRecord(event: RallarBlackBoxTestEvent): Record<string, any> {
    return asRecord(event.payload);
}

function toRtcMessage(event: RallarBlackBoxTestEvent): unknown {
    const payload = eventPayloadRecord(event);
    return Object.prototype.hasOwnProperty.call(payload, 'data')
        ? payload.data
        : event.payload;
}

function isCloseEvent(event: RallarBlackBoxTestEvent): boolean {
    return event.kind === 'event' && event.topic.includes('close');
}

interface RtcClientEventSubscriptionInput {
    readonly runtime: RallarBlackBoxTestRuntime;
    readonly connection: string;
    readonly seenEventIds: Set<string>;
    readonly matches: (event: RallarBlackBoxTestEvent) => boolean;
    readonly deliver: (event: RallarBlackBoxTestEvent) => void;
}

function subscribeToRtcClientEvents(input: RtcClientEventSubscriptionInput): () => void {
    input.runtime.state().events.forEach((event) => {
        input.seenEventIds.add(event.eventId);
    });
    return input.runtime.subscribe((state) => {
        state.events.forEach((event) => {
            if (
                input.seenEventIds.has(event.eventId) ||
                !input.matches(event) ||
                !eventBelongsToConnection(event, input.connection)
            ) {
                return;
            }

            input.seenEventIds.add(event.eventId);
            input.deliver(event);
        });
    });
}

function toConnectCommand(
    request: any,
    connection: string,
    commandId: string
): RallarBlackBoxTestCommand {
    const rallar = asRecord(request.rallar);
    const scopeFields = toRallarScopeFields(request);
    const apiBaseUrl = firstDefined(
        rallar.apiBaseUrl,
        request.apiBaseUrl,
        request.rallarApiBaseUrl
    );
    const transport = decodeRtcConnectTransport(firstDefined(rallar.transport, request.transport));

    return {
        kind: 'rtc.connect',
        commandId,
        connection,
        actor: request.actor,
        roomId: request.roomId,
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

function toSendCommand(
    request: any,
    connection: string,
    commandId: string,
    message: unknown,
    interaction: any
): RallarBlackBoxTestCommand {
    const rallar = asRecord(request.rallar);
    const scopeFields = toRallarScopeFields(request);
    const send = message && typeof message === 'object' && !Array.isArray(message)
        ? {
            ...message,
            ...Object.fromEntries(
                Object.entries(scopeFields).filter(([key]) => !(key in message))
            )
        }
        : Object.keys(scopeFields).length > 0
        ? {
            data: message,
            ...scopeFields
        }
        : message;
    return {
        kind: 'rtc.send',
        commandId,
        connection,
        send,
        expect: interaction?.response,
        ...scopeFields,
        transport: decodeRtcSendTransport(firstDefined(rallar.transport, request.transport)),
        metadata: {
            ...(request.parity ? { parity: request.parity } : {}),
            blackBoxRunner: request
        }
    };
}

export function createRallarBlackBoxRtcClient(
    runtime: RallarBlackBoxTestRuntime,
    request: any,
    options: RallarBlackBoxRtcClientAdapterOptions = {}
): RtcClient {
    const connection = toConnectionName(request);
    const commandIdPrefix = options.commandIdPrefix ?? 'rallar-bb';
    let sequence = 1;
    let unsubscribeMessages: (() => void) | undefined;
    let unsubscribeClose: (() => void) | undefined;
    const seenMessageEventIds = new Set<string>();
    const seenCloseEventIds = new Set<string>();

    return {
        async connect(): Promise<void> {
            const result = await runtime.execute(toConnectCommand(
                request,
                connection,
                toCommandId(commandIdPrefix, connection, 'connect', sequence++, request)
            ));
            assertCommandSucceeded(result);
        },

        async send(
            message: unknown,
            interaction?: any
        ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
            const sendRequest = interaction?.request ?? request;
            const browserOnly = toBrowserOnlyCommandOutcome(asRecord(sendRequest));
            if (browserOnly) {
                return browserOnly;
            }

            const result = await runtime.execute(toSendCommand(
                sendRequest,
                connection,
                toCommandId(commandIdPrefix, connection, 'send', sequence++, sendRequest),
                message,
                interaction
            ));
            assertCommandSucceeded(result);
        },

        async close(interaction?: any): Promise<void> {
            const closeRequest = interaction?.request ?? request;
            const result = await runtime.execute({
                kind: 'close',
                commandId: toCommandId(
                    commandIdPrefix,
                    connection,
                    'close',
                    sequence++,
                    closeRequest
                ),
                metadata: {
                    ...(closeRequest.parity ? { parity: closeRequest.parity } : {}),
                    connection,
                    blackBoxRunner: closeRequest
                }
            });
            assertCommandSucceeded(result);
            unsubscribeMessages?.();
            unsubscribeClose?.();
        },

        onMessage(handler: (message: unknown) => void): void {
            unsubscribeMessages?.();
            unsubscribeMessages = subscribeToRtcClientEvents({
                runtime,
                connection,
                seenEventIds: seenMessageEventIds,
                matches: (event) => event.kind === 'message',
                deliver: (event) => handler(toRtcMessage(event))
            });
        },

        onClose(handler: (event: unknown) => void): void {
            unsubscribeClose?.();
            unsubscribeClose = subscribeToRtcClientEvents({
                runtime,
                connection,
                seenEventIds: seenCloseEventIds,
                matches: isCloseEvent,
                deliver: (event) => handler(event.payload ?? event)
            });
        }
    };
}

export function createRallarBlackBoxRtcProvider(
    runtime: RallarBlackBoxTestRuntime,
    options: RallarBlackBoxRtcClientAdapterOptions = {}
): RtcProvider {
    return createRtcProviderFromClientFactory({
        createClient: (request) =>
            createRallarBlackBoxRtcClient(
                runtime,
                request,
                options
            )
    });
}
