import type { RallarBlackBoxTestRuntimeEventInput } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { assertValidRallarRouteId, assertValidRallarWsUserTopicId } from '@shared/api/rallar-validation.ts';
import type { RallarBlackBoxProviderMode } from './client-defaults.ts';

export type DirectRallarOperationKind =
    | 'status.check'
    | 'group.create'
    | 'group.join'
    | 'ws.subscribe'
    | 'ws.send';

export type DirectRallarOperationStatus = 'completed' | 'failed';

export type DirectRallarOperationContext = Readonly<{
    providerMode: RallarBlackBoxProviderMode;
    apiBaseUrl: string;
    applicationId: string;
    workspaceId: string;
    roomId?: string;
    actor?: string;
    connection?: string;
    authSession?: AuthSession;
    timeoutMs?: number;
}>;

export type DirectRallarOperationResult = Readonly<{
    kind: DirectRallarOperationKind;
    status: DirectRallarOperationStatus;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    durationMs: number;
    value?: Record<string, unknown>;
    error?: Readonly<{
        code: string;
        message: string;
        details?: unknown;
    }>;
    events: readonly RallarBlackBoxTestRuntimeEventInput[];
}>;

export type DirectRallarWsSendInput = Readonly<{
    scope?: 'room' | 'world' | 'all';
    typeId: string;
    topicId?: string;
    contextId?: string;
    resourceId?: string;
    payload: unknown;
    minSnapshotVersion?: number;
}>;

export type DirectRallarMessage = Record<string, unknown>;

export type DirectRallarMessageHandler = (
    message: DirectRallarMessage
) => void | Promise<void>;

export type DirectRallarMessageUnsubscribe = () => void;

export type DirectRallarWsSubscribeResult =
    & DirectRallarOperationResult
    & Readonly<{
        unsubscribe?: DirectRallarMessageUnsubscribe;
    }>;

export type DirectRallarFacade = Readonly<{
    configure(config: { apiBaseUrl?: string; }): void;
    setDefaults(defaults?: Record<string, unknown>): void;
    defaults?(): unknown;
    connect?(options?: Record<string, unknown>): Promise<unknown>;
    start(options?: Record<string, unknown>): Promise<{
        session?: AuthSession;
        connected: boolean;
        roomState?: unknown;
        peopleState?: unknown;
    }>;
    status(): string;
    isConnected(): boolean;
    session(): AuthSession | undefined;
    auth: Readonly<{
        restore(): AuthSession | undefined;
    }>;
    rooms: Readonly<{
        current(): unknown;
        list(): readonly unknown[];
        create(input: string | Record<string, unknown>): Promise<unknown>;
        join(roomId: string, options?: Record<string, unknown>): Promise<unknown>;
    }>;
    people: Readonly<{
        list(): readonly unknown[];
    }>;
    messages: Readonly<{
        ws: Readonly<{
            send(input: Record<string, unknown>): Promise<unknown>;
            onMessage(
                selector: Record<string, unknown>,
                handler: DirectRallarMessageHandler
            ): DirectRallarMessageUnsubscribe;
        }>;
    }>;
    ws: Readonly<{
        status(): unknown;
    }>;
    rtc: Readonly<{
        status(): unknown;
    }>;
}>;

export type DirectRallarFacadeLoader = () => Promise<DirectRallarFacade>;

const DIRECT_BACKEND_REQUIRED_ERROR_CODE = 'RALLAR_DIRECT_BACKEND_REQUIRED';

function sessionDiagnostic(session: AuthSession | undefined): Record<string, unknown> | undefined {
    if (!session) {
        return undefined;
    }

    return {
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        expiresAtEpochMs: session.expiresAtEpochMs
    };
}

export function createDirectRallarRuntimeEvent(
    input: Readonly<{
        topic: string;
        context: DirectRallarOperationContext;
        kind?: RallarBlackBoxTestRuntimeEventInput['kind'];
        transport?: RallarBlackBoxTestRuntimeEventInput['transport'];
        severity?: RallarBlackBoxTestRuntimeEventInput['severity'];
        payload?: unknown;
    }>
): RallarBlackBoxTestRuntimeEventInput {
    return {
        kind: input.kind ?? 'diagnostic',
        topic: input.topic,
        connection: input.context.connection,
        actor: input.context.actor ?? input.context.authSession?.username,
        transport: input.transport,
        severity: input.severity ?? 'info',
        payload: {
            providerMode: input.context.providerMode,
            apiBaseUrl: input.context.apiBaseUrl,
            applicationId: input.context.applicationId,
            workspaceId: input.context.workspaceId,
            roomId: input.context.roomId,
            ...(
                input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
                    ? input.payload as Record<string, unknown>
                    : { data: input.payload }
            )
        }
    };
}

function directEvent(input: Parameters<typeof createDirectRallarRuntimeEvent>[0]): RallarBlackBoxTestRuntimeEventInput {
    return createDirectRallarRuntimeEvent(input);
}

function directError(error: unknown, code = 'RALLAR_DIRECT_OPERATION_FAILED'): DirectRallarOperationResult['error'] {
    if (error instanceof Error) {
        return {
            code,
            message: error.message,
            details: {
                name: error.name,
                stack: error.stack
            }
        };
    }

    return {
        code,
        message: String(error)
    };
}

export async function loadDirectRallarFacade(): Promise<DirectRallarFacade> {
    return (await import('@shared-web/browser/rallar.ts')).rallar as DirectRallarFacade;
}

function directRoomRef(context: DirectRallarOperationContext): Record<string, unknown> | undefined {
    const roomId = context.roomId?.trim();
    if (!roomId) {
        return undefined;
    }

    return {
        applicationId: context.applicationId,
        workspaceId: context.workspaceId,
        groupId: roomId
    };
}

function directScope(context: DirectRallarOperationContext): Record<string, unknown> {
    return {
        applicationId: context.applicationId,
        workspaceId: context.workspaceId
    };
}

export function configureDirectRallarFacade(
    facade: DirectRallarFacade,
    context: DirectRallarOperationContext
): void {
    const roomRef = directRoomRef(context);
    facade.configure({ apiBaseUrl: context.apiBaseUrl });
    facade.setDefaults({
        applicationId: context.applicationId,
        workspaceId: context.workspaceId,
        operations: {
            timeoutMs: context.timeoutMs
        },
        ...(roomRef
            ? {
                room: {
                    roomId: context.roomId,
                    roomRef
                }
            }
            : {})
    });
}

function directSession(
    facade: DirectRallarFacade,
    context: DirectRallarOperationContext
): AuthSession | undefined {
    return facade.session() ?? facade.auth.restore() ?? context.authSession;
}

function requireDirectSession(
    facade: DirectRallarFacade,
    context: DirectRallarOperationContext
): AuthSession {
    const session = directSession(facade, context);
    if (!session) {
        throw new Error('Direct Rallar operation requires a logged-in browser session.');
    }

    return session;
}

async function startDirectRallarFacade(
    facade: DirectRallarFacade,
    context: DirectRallarOperationContext
): Promise<{
    session: AuthSession;
    connected: boolean;
    roomState?: unknown;
    peopleState?: unknown;
}> {
    const restoredSession = requireDirectSession(facade, context);
    const startResult = await facade.start({
        connect: true,
        refreshRooms: false,
        refreshPeople: false,
        timeoutMs: context.timeoutMs
    });

    return {
        ...startResult,
        session: startResult.session ?? facade.session() ?? restoredSession,
        connected: startResult.connected || facade.isConnected()
    };
}

function groupIdFromSnapshot(snapshot: unknown): string | undefined {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return undefined;
    }

    const record = snapshot as Record<string, unknown>;
    const group = record.group && typeof record.group === 'object' && !Array.isArray(record.group)
        ? record.group as Record<string, unknown>
        : {};
    const value = record.groupId ?? record.id ?? group.groupId ?? group.id;
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function groupDisplayNameFromSnapshot(snapshot: unknown): string | undefined {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return undefined;
    }

    const record = snapshot as Record<string, unknown>;
    const group = record.group && typeof record.group === 'object' && !Array.isArray(record.group)
        ? record.group as Record<string, unknown>
        : {};
    const value = record.displayName ?? record.name ?? group.displayName ?? group.name;
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function backendRequiredError(context: DirectRallarOperationContext): DirectRallarOperationResult['error'] {
    return {
        code: DIRECT_BACKEND_REQUIRED_ERROR_CODE,
        message: 'Direct Rallar operations require provider=browser-rallar and a real backend.',
        details: {
            providerMode: context.providerMode
        }
    };
}

function backendRequiredResult(
    kind: DirectRallarOperationKind,
    startedAtEpochMs: number,
    started: RallarBlackBoxTestRuntimeEventInput,
    context: DirectRallarOperationContext,
    topicBase: string
): DirectRallarOperationResult {
    const endedAtEpochMs = Date.now();
    const error = backendRequiredError(context);
    const failed = directEvent({
        topic: `${topicBase}.failed`,
        context,
        severity: 'error',
        payload: {
            action: kind,
            error
        }
    });

    return {
        kind,
        status: 'failed',
        startedAtEpochMs,
        endedAtEpochMs,
        durationMs: endedAtEpochMs - startedAtEpochMs,
        error,
        events: [started, failed]
    };
}

function validateRoomId(context: DirectRallarOperationContext, action: string): string {
    const roomId = context.roomId?.trim();
    if (!roomId) {
        throw new Error(`${action} requires a group.`);
    }

    return assertValidRallarRouteId(roomId, '$.roomId', 'Room ID');
}

function validateRallarServerUserTopic(topicId: string, action: string): string {
    const trimmed = topicId.trim();
    if (!trimmed) {
        throw new Error(`${action} requires a Topic ID.`);
    }

    return assertValidRallarWsUserTopicId(trimmed, '$.topicId');
}

function effectiveWsTopicId(input: DirectRallarWsSendInput): string {
    return input.topicId?.trim() || input.typeId.trim();
}

function directWsSendPayload(
    context: DirectRallarOperationContext,
    input: DirectRallarWsSendInput
): Record<string, unknown> {
    const scope = input.scope ?? (context.roomId ? 'room' : 'all');
    const roomRef = scope === 'room' ? directRoomRef(context) : undefined;
    return {
        applicationId: context.applicationId,
        workspaceId: context.workspaceId,
        scope,
        typeId: input.typeId,
        ...(input.topicId ? { topicId: input.topicId } : {}),
        ...(input.contextId ? { contextId: input.contextId } : {}),
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        ...(scope === 'room' && context.roomId
            ? {
                roomId: context.roomId,
                groupId: context.roomId,
                roomRef
            }
            : {}),
        ...(input.minSnapshotVersion !== undefined
            ? { minSnapshotVersion: input.minSnapshotVersion }
            : {}),
        payload: input.payload
    };
}

export async function runDirectRallarStatusCheck(
    context: DirectRallarOperationContext,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarOperationResult> {
    const startedAtEpochMs = Date.now();
    const started = directEvent({
        topic: 'rallar.direct.status.started',
        context,
        payload: {
            action: 'status.check'
        }
    });

    if (context.providerMode !== 'browser-rallar') {
        return backendRequiredResult(
            'status.check',
            startedAtEpochMs,
            started,
            context,
            'rallar.direct.status'
        );
    }

    try {
        const facade = await loadFacade();
        configureDirectRallarFacade(facade, context);
        const startResult = await startDirectRallarFacade(facade, context);
        const value = {
            action: 'status.check',
            connected: startResult.connected,
            connectStatus: facade.status(),
            session: sessionDiagnostic(startResult.session),
            defaults: facade.defaults?.(),
            wsStatus: facade.ws.status(),
            rtcStatus: facade.rtc.status(),
            currentRoom: facade.rooms.current(),
            roomCount: facade.rooms.list().length,
            peopleCount: facade.people.list().length
        };
        const endedAtEpochMs = Date.now();
        const completed = directEvent({
            topic: 'rallar.direct.status.completed',
            context,
            payload: value
        });

        return {
            kind: 'status.check',
            status: 'completed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            value,
            events: [started, completed]
        };
    }
    catch (error) {
        const endedAtEpochMs = Date.now();
        const directOperationError = directError(error);
        const failed = directEvent({
            topic: 'rallar.direct.status.failed',
            context,
            severity: 'error',
            payload: {
                action: 'status.check',
                error: directOperationError
            }
        });

        return {
            kind: 'status.check',
            status: 'failed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            error: directOperationError,
            events: [started, failed]
        };
    }
}

export async function runDirectRallarGroupCreate(
    context: DirectRallarOperationContext,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarOperationResult> {
    const startedAtEpochMs = Date.now();
    const started = directEvent({
        topic: 'rallar.direct.group.create.started',
        context,
        payload: {
            action: 'group.create'
        }
    });

    if (context.providerMode !== 'browser-rallar') {
        return backendRequiredResult(
            'group.create',
            startedAtEpochMs,
            started,
            context,
            'rallar.direct.group.create'
        );
    }

    try {
        const groupName = validateRoomId(context, 'Group create');
        const facade = await loadFacade();
        configureDirectRallarFacade(facade, context);
        const startResult = await startDirectRallarFacade(facade, context);
        const snapshot = await facade.rooms.create({
            groupId: groupName,
            displayName: groupName,
            scope: directScope(context),
            timeoutMs: context.timeoutMs
        });
        const groupId = groupIdFromSnapshot(snapshot);
        const value = {
            action: 'group.create',
            requestedGroup: groupName,
            groupId,
            displayName: groupDisplayNameFromSnapshot(snapshot) ?? groupName,
            connected: startResult.connected,
            session: sessionDiagnostic(startResult.session),
            snapshot
        };
        const endedAtEpochMs = Date.now();
        const completed = directEvent({
            topic: 'rallar.direct.group.create.completed',
            context: {
                ...context,
                roomId: groupId ?? context.roomId
            },
            payload: value
        });

        return {
            kind: 'group.create',
            status: 'completed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            value,
            events: [started, completed]
        };
    }
    catch (error) {
        const endedAtEpochMs = Date.now();
        const directOperationError = directError(error);
        const failed = directEvent({
            topic: 'rallar.direct.group.create.failed',
            context,
            severity: 'error',
            payload: {
                action: 'group.create',
                error: directOperationError
            }
        });

        return {
            kind: 'group.create',
            status: 'failed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            error: directOperationError,
            events: [started, failed]
        };
    }
}

export async function runDirectRallarGroupJoin(
    context: DirectRallarOperationContext,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarOperationResult> {
    const startedAtEpochMs = Date.now();
    const started = directEvent({
        topic: 'rallar.direct.group.join.started',
        context,
        payload: {
            action: 'group.join'
        }
    });

    if (context.providerMode !== 'browser-rallar') {
        return backendRequiredResult(
            'group.join',
            startedAtEpochMs,
            started,
            context,
            'rallar.direct.group.join'
        );
    }

    try {
        const roomId = validateRoomId(context, 'Group join');
        const facade = await loadFacade();
        configureDirectRallarFacade(facade, context);
        const startResult = await startDirectRallarFacade(facade, context);
        const snapshot = await facade.rooms.join(roomId, {
            timeoutMs: context.timeoutMs,
            scope: directScope(context)
        });
        const value = {
            action: 'group.join',
            groupId: groupIdFromSnapshot(snapshot) ?? roomId,
            displayName: groupDisplayNameFromSnapshot(snapshot),
            connected: startResult.connected,
            session: sessionDiagnostic(startResult.session),
            snapshot
        };
        const endedAtEpochMs = Date.now();
        const completed = directEvent({
            topic: 'rallar.direct.group.join.completed',
            context,
            payload: value
        });

        return {
            kind: 'group.join',
            status: 'completed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            value,
            events: [started, completed]
        };
    }
    catch (error) {
        const endedAtEpochMs = Date.now();
        const directOperationError = directError(error);
        const failed = directEvent({
            topic: 'rallar.direct.group.join.failed',
            context,
            severity: 'error',
            payload: {
                action: 'group.join',
                error: directOperationError
            }
        });

        return {
            kind: 'group.join',
            status: 'failed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            error: directOperationError,
            events: [started, failed]
        };
    }
}

export async function runDirectRallarWsSubscribe(
    context: DirectRallarOperationContext,
    selector: Record<string, unknown>,
    handler: DirectRallarMessageHandler,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarWsSubscribeResult> {
    const startedAtEpochMs = Date.now();
    const started = directEvent({
        topic: 'rallar.direct.ws.subscribe.started',
        context,
        transport: 'ws',
        payload: {
            action: 'ws.subscribe',
            selector
        }
    });

    if (context.providerMode !== 'browser-rallar') {
        return backendRequiredResult(
            'ws.subscribe',
            startedAtEpochMs,
            started,
            context,
            'rallar.direct.ws.subscribe'
        );
    }

    let unsubscribe: DirectRallarMessageUnsubscribe | undefined;
    try {
        const roomId = validateRoomId(context, 'WS subscribe');
        if (typeof selector.topicId === 'string' && selector.topicId.trim()) {
            validateRallarServerUserTopic(selector.topicId, 'WS subscribe');
        }
        const facade = await loadFacade();
        configureDirectRallarFacade(facade, context);
        unsubscribe = facade.messages.ws.onMessage(selector, handler);
        const startResult = await startDirectRallarFacade(facade, context);
        const snapshot = await facade.rooms.join(roomId, {
            timeoutMs: context.timeoutMs,
            scope: directScope(context)
        });
        const value = {
            action: 'ws.subscribe',
            selector,
            groupId: groupIdFromSnapshot(snapshot) ?? roomId,
            displayName: groupDisplayNameFromSnapshot(snapshot),
            connected: startResult.connected,
            session: sessionDiagnostic(startResult.session),
            wsStatus: facade.ws.status()
        };
        const endedAtEpochMs = Date.now();
        const completed = directEvent({
            topic: 'rallar.direct.ws.subscribe.completed',
            context,
            transport: 'ws',
            payload: value
        });

        return {
            kind: 'ws.subscribe',
            status: 'completed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            value,
            events: [started, completed],
            unsubscribe
        };
    }
    catch (error) {
        unsubscribe?.();
        const endedAtEpochMs = Date.now();
        const directOperationError = directError(error);
        const failed = directEvent({
            topic: 'rallar.direct.ws.subscribe.failed',
            context,
            transport: 'ws',
            severity: 'error',
            payload: {
                action: 'ws.subscribe',
                selector,
                error: directOperationError
            }
        });

        return {
            kind: 'ws.subscribe',
            status: 'failed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            error: directOperationError,
            events: [started, failed]
        };
    }
}

export async function runDirectRallarWsSend(
    context: DirectRallarOperationContext,
    input: DirectRallarWsSendInput,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarOperationResult> {
    const startedAtEpochMs = Date.now();
    const started = directEvent({
        topic: 'rallar.direct.ws.send.started',
        context,
        transport: 'ws',
        payload: {
            action: 'ws.send',
            scope: input.scope ?? 'room',
            typeId: input.typeId,
            topicId: input.topicId,
            contextId: input.contextId
        }
    });

    if (context.providerMode !== 'browser-rallar') {
        return backendRequiredResult(
            'ws.send',
            startedAtEpochMs,
            started,
            context,
            'rallar.direct.ws.send'
        );
    }

    try {
        if (!input.typeId.trim()) {
            throw new Error('WS send requires a Type ID.');
        }
        validateRallarServerUserTopic(effectiveWsTopicId(input), 'WS send');
        if ((input.scope ?? 'room') === 'room') {
            validateRoomId(context, 'WS send');
        }
        const facade = await loadFacade();
        configureDirectRallarFacade(facade, context);
        const startResult = await startDirectRallarFacade(facade, context);
        const sendInput = directWsSendPayload(context, input);
        const sendResult = await facade.messages.ws.send(sendInput);
        const value = {
            action: 'ws.send',
            groupId: context.roomId,
            selector: {
                typeId: input.typeId,
                topicId: input.topicId,
                contextId: input.contextId
            },
            connected: startResult.connected,
            session: sessionDiagnostic(startResult.session),
            wsStatus: facade.ws.status(),
            sendInput,
            sendResult
        };
        const endedAtEpochMs = Date.now();
        const completed = directEvent({
            topic: 'rallar.direct.ws.send.completed',
            context,
            transport: 'ws',
            payload: value
        });

        return {
            kind: 'ws.send',
            status: 'completed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            value,
            events: [started, completed]
        };
    }
    catch (error) {
        const endedAtEpochMs = Date.now();
        const directOperationError = directError(error);
        const failed = directEvent({
            topic: 'rallar.direct.ws.send.failed',
            context,
            transport: 'ws',
            severity: 'error',
            payload: {
                action: 'ws.send',
                error: directOperationError
            }
        });

        return {
            kind: 'ws.send',
            status: 'failed',
            startedAtEpochMs,
            endedAtEpochMs,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            error: directOperationError,
            events: [started, failed]
        };
    }
}
