import type { RallarBlackBoxTestRuntimeEventInput } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { BrowserRallarSubscriptionScope } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type {
    RallarFacade,
    RallarMessage,
    RallarMessageHandle,
    RallarMessageHandler,
    RallarMessageSelectorInput,
    RallarStartResult,
    RallarSubscriptionScope,
    RallarUnsubscribe,
    RallarWsSendInput
} from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupId, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    failRallarValidation,
    validateRallarRouteId,
    validateRallarWsUserTopicId,
    type RallarValidationIssue,
    type RallarValidationResult
} from '@shared/api/rallar-validation.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RallarBlackBoxProviderMode } from './client-defaults.ts';

export interface DirectRallarOperationContext {
    readonly providerMode: RallarBlackBoxProviderMode;
    readonly apiBaseUrl: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly roomId?: string;
    readonly actor?: string;
    readonly connection?: string;
    readonly authSession?: AuthSession;
    readonly timeoutMs?: number;
}

export interface DirectRallarWsSendInput {
    readonly scope?: 'room' | 'world' | 'all';
    readonly typeId: string;
    readonly topicId?: string;
    readonly contextId?: string;
    readonly resourceId?: string;
    readonly payload: RallarBlackBoxTestRuntimeEventInput['payload'];
    readonly minSnapshotVersion?: number;
}

export interface DirectRallarMessageHandler {
    (
        message: RallarMessage<RallarMessagePayload>
    ): void | Promise<void>;
}

export interface DirectRallarWsMessagesFacade {
    send<T extends RallarMessagePayload>(input: RallarWsSendInput<T>): Promise<RallarMessageHandle>;
    onMessage(
        selector: RallarMessageSelectorInput,
        handler: RallarMessageHandler<RallarMessagePayload>
    ): RallarUnsubscribe;
}

export interface DirectRallarMessagesFacade {
    readonly ws: DirectRallarWsMessagesFacade;
}

export interface DirectRallarFacade extends
    Pick<
        RallarFacade,
        | 'configure'
        | 'setDefaults'
        | 'defaults'
        | 'start'
        | 'status'
        | 'isConnected'
        | 'session'
    > {
    readonly auth: Pick<RallarFacade['auth'], 'restore'>;
    readonly rooms: Pick<RallarFacade['rooms'], 'current' | 'list' | 'create' | 'join'>;
    readonly people: Pick<RallarFacade['people'], 'list'>;
    readonly messages: DirectRallarMessagesFacade;
    readonly ws: Pick<RallarFacade['ws'], 'status'>;
    readonly rtc: Pick<RallarFacade['rtc'], 'status'>;
}

export interface DirectRallarFacadeLoader {
    (): Promise<DirectRallarFacade>;
}

export interface DirectRallarWsPayload extends RallarWsSendInput<RallarMessagePayload> {
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly groupId?: string;
}

export interface CreateDirectRallarRuntimeEventInput {
    readonly topic: string;
    readonly context: DirectRallarOperationContext;
    readonly kind?: RallarBlackBoxTestRuntimeEventInput['kind'];
    readonly transport?: RallarBlackBoxTestRuntimeEventInput['transport'];
    readonly severity?: RallarBlackBoxTestRuntimeEventInput['severity'];
    readonly payload?: RallarBlackBoxTestRuntimeEventInput['payload'];
}

export interface DirectRallarStartResult {
    readonly session: AuthSession;
    readonly connected: RallarStartResult['connected'];
    readonly roomState?: RallarStartResult['roomState'];
    readonly peopleState?: RallarStartResult['peopleState'];
}

export type DirectRallarOperationKind =
    | 'status.check'
    | 'group.create'
    | 'group.join'
    | 'ws.subscribe'
    | 'ws.send';

export type DirectRallarOperationStatus = 'completed' | 'failed';

export interface DirectRallarOperationError {
    readonly code: string;
    readonly message: string;
    readonly details?: { readonly issues: readonly RallarValidationIssue[]; } | {
        readonly name: string;
        readonly stack?: string;
    } | {
        readonly providerMode: RallarBlackBoxProviderMode;
    };
}

/** The session an operation observed, without the access token its diagnostics must not carry. */
export type DirectRallarSessionDiagnostic = Omit<AuthSession, 'accessToken'>;

export interface DirectRallarStatusCheckValue {
    readonly action: 'status.check';
    readonly connected: boolean;
    readonly connectStatus: ReturnType<DirectRallarFacade['status']>;
    /** Absent when neither the facade nor the caller's context holds a logged-in session. */
    readonly session: DirectRallarSessionDiagnostic | undefined;
    /** Absent when the facade build exposes no defaults reader. */
    readonly defaults: ReturnType<NonNullable<DirectRallarFacade['defaults']>> | undefined;
    readonly wsStatus: ReturnType<DirectRallarFacade['ws']['status']>;
    readonly rtcStatus: ReturnType<DirectRallarFacade['rtc']['status']>;
    readonly currentRoom: ReturnType<DirectRallarFacade['rooms']['current']>;
    readonly roomCount: number;
    readonly peopleCount: number;
}

export interface DirectRallarGroupCreateValue {
    readonly action: 'group.create';
    readonly requestedGroup: string;
    readonly groupId: GroupId;
    readonly displayName: string;
    readonly connected: boolean;
    /** Absent when neither the facade nor the caller's context holds a logged-in session. */
    readonly session: DirectRallarSessionDiagnostic | undefined;
    readonly snapshot: GroupSnapshot;
}

export interface DirectRallarGroupJoinValue {
    readonly action: 'group.join';
    readonly groupId: string;
    readonly displayName: string;
    readonly connected: boolean;
    /** Absent when neither the facade nor the caller's context holds a logged-in session. */
    readonly session: DirectRallarSessionDiagnostic | undefined;
    readonly snapshot: GroupSnapshot;
}

export interface DirectRallarWsSubscribeValue {
    readonly action: 'ws.subscribe';
    readonly selector: RallarMessageSelectorInput;
    readonly groupId: string;
    readonly displayName: string;
    readonly connected: boolean;
    /** Absent when neither the facade nor the caller's context holds a logged-in session. */
    readonly session: DirectRallarSessionDiagnostic | undefined;
    readonly wsStatus: ReturnType<DirectRallarFacade['ws']['status']>;
}

export interface DirectRallarWsSendValue {
    readonly action: 'ws.send';
    /** Absent when the caller addressed no room. */
    readonly groupId: string | undefined;
    readonly selector: DirectRallarWsSendSelector;
    readonly connected: boolean;
    /** Absent when neither the facade nor the caller's context holds a logged-in session. */
    readonly session: DirectRallarSessionDiagnostic | undefined;
    readonly wsStatus: ReturnType<DirectRallarFacade['ws']['status']>;
    readonly sendInput: DirectRallarWsPayload;
    readonly sendResult: DirectRallarWsSendReceipt;
}

export interface DirectRallarWsSendSelector {
    readonly typeId: string;
    /** Absent when the caller let the type id name the topic. */
    readonly topicId: string | undefined;
    /** Absent when the caller addressed no context. */
    readonly contextId: string | undefined;
}

export interface DirectRallarWsSendReceipt {
    readonly msgId: RallarMessageHandle['msgId'];
    readonly typeId: RallarMessageHandle['typeId'];
    readonly lifecycle: ReturnType<RallarMessageHandle['lifecycle']>;
}

/** What an operation observed, named by the action that observed it. */
export type DirectRallarOperationValue =
    | DirectRallarStatusCheckValue
    | DirectRallarGroupCreateValue
    | DirectRallarGroupJoinValue
    | DirectRallarWsSubscribeValue
    | DirectRallarWsSendValue;

export interface DirectRallarOperationResult {
    readonly kind: DirectRallarOperationKind;
    readonly status: DirectRallarOperationStatus;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly durationMs: number;
    /** Absent when the operation failed, so it observed nothing to report. */
    readonly value?: DirectRallarOperationValue;
    readonly error?: DirectRallarOperationError;
    readonly events: readonly RallarBlackBoxTestRuntimeEventInput[];
}

export interface DirectRallarWsSubscribeResult extends DirectRallarOperationResult {
    readonly unsubscribe?: RallarUnsubscribe;
}

const DIRECT_BACKEND_REQUIRED_ERROR_CODE = 'RALLAR_DIRECT_BACKEND_REQUIRED';
const DIRECT_OPERATION_FAILED_ERROR_CODE = 'RALLAR_DIRECT_OPERATION_FAILED';

function toSessionDiagnostic(session: AuthSession | undefined): Omit<AuthSession, 'accessToken'> | undefined {
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
    input: CreateDirectRallarRuntimeEventInput
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
                    ? input.payload
                    : { data: input.payload }
            )
        }
    };
}

/** The failure a caught value reports: an `Error` keeps its name and stack, anything else its text. */
function decodeDirectRallarError(error: unknown): DirectRallarOperationError {
    if (typeof error === 'object' && error !== null && error instanceof Error) {
        return {
            code: DIRECT_OPERATION_FAILED_ERROR_CODE,
            message: error.message,
            details: { name: error.name, stack: error.stack }
        };
    }
    return { code: DIRECT_OPERATION_FAILED_ERROR_CODE, message: String(error) };
}

export async function loadDirectRallarFacade(): Promise<DirectRallarFacade> {
    return (await import('@shared-web/browser/rallar.ts')).rallar;
}

function directRoomRef(context: DirectRallarOperationContext): GroupRef | undefined {
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

function directScope(context: DirectRallarOperationContext): StateScope {
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

function sessionRequiredError(): DirectRallarOperationError {
    return {
        code: DIRECT_OPERATION_FAILED_ERROR_CODE,
        message: 'Direct Rallar operation requires a logged-in browser session.'
    };
}

async function startDirectRallarFacade(
    facade: DirectRallarFacade,
    context: DirectRallarOperationContext,
    restoredSession: AuthSession
): Promise<DirectRallarStartResult> {
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

function backendRequiredError(context: DirectRallarOperationContext): DirectRallarOperationError {
    return {
        code: DIRECT_BACKEND_REQUIRED_ERROR_CODE,
        message: 'Direct Rallar operations require provider=browser-rallar and a real backend.',
        details: {
            providerMode: context.providerMode
        }
    };
}

interface DirectRallarOperationRunInput {
    readonly kind: DirectRallarOperationKind;
    readonly topicBase: string;
    readonly context: DirectRallarOperationContext;
    readonly transport?: RallarBlackBoxTestRuntimeEventInput['transport'];
    readonly startedPayload: RallarBlackBoxTestRuntimeEventInput['payload'];
    /** Absent for an operation whose failure event carries no selector beside the error. */
    readonly failureSelector?: RallarMessageSelectorInput;
    readonly run: () => Promise<Either<DirectRallarOperationError, DirectRallarOperationSuccess>>;
}

interface DirectRallarOperationSuccess {
    readonly value: DirectRallarOperationValue;
    readonly eventContext?: DirectRallarOperationContext;
    readonly unsubscribe?: RallarUnsubscribe;
}

interface DirectRallarOperationResultInput {
    readonly execution: DirectRallarOperationRunInput;
    readonly startedAtEpochMs: number;
    readonly started: RallarBlackBoxTestRuntimeEventInput;
}

interface DirectRallarCompletedOperationResultInput extends DirectRallarOperationResultInput {
    readonly success: DirectRallarOperationSuccess;
}

interface DirectRallarFailedOperationResultInput extends DirectRallarOperationResultInput {
    readonly error: DirectRallarOperationError;
}

async function runDirectRallarOperation(
    input: DirectRallarOperationRunInput
): Promise<DirectRallarWsSubscribeResult> {
    const startedAtEpochMs = Date.now();
    const started = createDirectRallarRuntimeEvent({
        topic: `${input.topicBase}.started`,
        context: input.context,
        transport: input.transport,
        payload: input.startedPayload
    });
    const resultInput = { execution: input, startedAtEpochMs, started };
    if (input.context.providerMode !== 'browser-rallar') {
        return backendRequiredResult(resultInput);
    }
    try {
        const outcome = await input.run();
        return outcome.fold(
            (error) => failedOperationResult({ ...resultInput, error }),
            (success) => completedOperationResult({ ...resultInput, success })
        );
    }
    catch (error) {
        return failedOperationResult({
            ...resultInput,
            error: decodeDirectRallarError(error)
        });
    }
}

function backendRequiredResult(
    input: DirectRallarOperationResultInput
): DirectRallarOperationResult {
    const endedAtEpochMs = Date.now();
    const error = backendRequiredError(input.execution.context);
    const failed = createDirectRallarRuntimeEvent({
        topic: `${input.execution.topicBase}.failed`,
        context: input.execution.context,
        transport: input.execution.transport,
        severity: 'error',
        payload: {
            action: input.execution.kind,
            error
        }
    });

    return {
        kind: input.execution.kind,
        status: 'failed',
        startedAtEpochMs: input.startedAtEpochMs,
        endedAtEpochMs,
        durationMs: endedAtEpochMs - input.startedAtEpochMs,
        error,
        events: [input.started, failed]
    };
}

function completedOperationResult(
    input: DirectRallarCompletedOperationResultInput
): DirectRallarWsSubscribeResult {
    const endedAtEpochMs = Date.now();
    const completed = createDirectRallarRuntimeEvent({
        topic: `${input.execution.topicBase}.completed`,
        context: input.success.eventContext ?? input.execution.context,
        transport: input.execution.transport,
        payload: input.success.value
    });
    return {
        kind: input.execution.kind,
        status: 'completed',
        startedAtEpochMs: input.startedAtEpochMs,
        endedAtEpochMs,
        durationMs: endedAtEpochMs - input.startedAtEpochMs,
        value: input.success.value,
        events: [input.started, completed],
        ...(input.success.unsubscribe ? { unsubscribe: input.success.unsubscribe } : {})
    };
}

function failedOperationResult(
    input: DirectRallarFailedOperationResultInput
): DirectRallarOperationResult {
    const endedAtEpochMs = Date.now();
    const error = input.error;
    const failed = createDirectRallarRuntimeEvent({
        topic: `${input.execution.topicBase}.failed`,
        context: input.execution.context,
        transport: input.execution.transport,
        severity: 'error',
        payload: {
            action: input.execution.kind,
            ...(input.execution.failureSelector === undefined
                ? {}
                : { selector: input.execution.failureSelector }),
            error
        }
    });
    return {
        kind: input.execution.kind,
        status: 'failed',
        startedAtEpochMs: input.startedAtEpochMs,
        endedAtEpochMs,
        durationMs: endedAtEpochMs - input.startedAtEpochMs,
        error,
        events: [input.started, failed]
    };
}

function validateRoomId(context: DirectRallarOperationContext): RallarValidationResult {
    return validateRallarRouteId(context.roomId?.trim(), '$.roomId', 'Room ID');
}

function effectiveWsTopicId(input: DirectRallarWsSendInput): string {
    return input.topicId?.trim() || input.typeId.trim();
}

function isRallarMessagePayload(payload: unknown): payload is RallarMessagePayload {
    return payload === null || typeof payload === 'object' || typeof payload === 'string' ||
        typeof payload === 'number' || typeof payload === 'boolean';
}

function validateWsSend(context: DirectRallarOperationContext, input: DirectRallarWsSendInput): RallarValidationResult {
    return failRallarValidation([
        ...validateRallarRouteId(input.typeId.trim(), '$.typeId', 'Type ID').issues,
        ...validateRallarWsUserTopicId(effectiveWsTopicId(input), '$.topicId').issues,
        ...((input.scope ?? 'room') === 'room' ? validateRoomId(context).issues : []),
        ...(isRallarMessagePayload(input.payload)
            ? []
            : [{
                path: '$.payload',
                code: 'invalid-payload',
                message: 'WS send payload must be an object, array, string, number, boolean, or null.'
            }])
    ]);
}

function toValidationError(result: RallarValidationResult): DirectRallarOperationError {
    return {
        code: DIRECT_OPERATION_FAILED_ERROR_CODE,
        message: result.errors.join('\n'),
        details: { issues: result.issues }
    };
}

function directWsSendPayload(
    context: DirectRallarOperationContext,
    input: DirectRallarWsSendInput,
    payload: RallarMessagePayload
): DirectRallarWsPayload {
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
        payload
    };
}

export async function runDirectRallarStatusCheck(
    context: DirectRallarOperationContext,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarOperationResult> {
    return await runDirectRallarOperation({
        kind: 'status.check',
        topicBase: 'rallar.direct.status',
        context,
        startedPayload: { action: 'status.check' },
        run: async () => {
            const facade = await loadFacade();
            configureDirectRallarFacade(facade, context);
            const restoredSession = directSession(facade, context);
            if (!restoredSession) {
                return Either.ofLeft(sessionRequiredError());
            }
            const startResult = await startDirectRallarFacade(facade, context, restoredSession);
            return Either.ofRight({
                value: {
                    action: 'status.check',
                    connected: startResult.connected,
                    connectStatus: facade.status(),
                    session: toSessionDiagnostic(startResult.session),
                    defaults: facade.defaults?.(),
                    wsStatus: facade.ws.status(),
                    rtcStatus: facade.rtc.status(),
                    currentRoom: facade.rooms.current(),
                    roomCount: facade.rooms.list().length,
                    peopleCount: facade.people.list().length
                }
            });
        }
    });
}

export async function runDirectRallarGroupCreate(
    context: DirectRallarOperationContext,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarOperationResult> {
    return await runDirectRallarOperation({
        kind: 'group.create',
        topicBase: 'rallar.direct.group.create',
        context,
        startedPayload: { action: 'group.create' },
        run: async () => createDirectRallarGroup(context, loadFacade)
    });
}

async function createDirectRallarGroup(
    context: DirectRallarOperationContext,
    loadFacade: DirectRallarFacadeLoader
): Promise<Either<DirectRallarOperationError, DirectRallarOperationSuccess>> {
    const validation = validateRoomId(context);
    if (!validation.ok) {
        return Either.ofLeft(toValidationError(validation));
    }
    const groupName = context.roomId?.trim() ?? '';
    const facade = await loadFacade();
    configureDirectRallarFacade(facade, context);
    const restoredSession = directSession(facade, context);
    if (!restoredSession) {
        return Either.ofLeft(sessionRequiredError());
    }
    const startResult = await startDirectRallarFacade(facade, context, restoredSession);
    const snapshot = await facade.rooms.create({
        groupId: groupName,
        displayName: groupName,
        scope: directScope(context),
        timeoutMs: context.timeoutMs
    });
    const groupId = snapshot.group.groupId;
    return Either.ofRight({
        value: {
            action: 'group.create',
            requestedGroup: groupName,
            groupId,
            displayName: snapshot.group.displayName ?? groupName,
            connected: startResult.connected,
            session: toSessionDiagnostic(startResult.session),
            snapshot
        },
        eventContext: { ...context, roomId: groupId ?? context.roomId }
    });
}

export async function runDirectRallarGroupJoin(
    context: DirectRallarOperationContext,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarOperationResult> {
    return await runDirectRallarOperation({
        kind: 'group.join',
        topicBase: 'rallar.direct.group.join',
        context,
        startedPayload: { action: 'group.join' },
        run: async () => joinDirectRallarGroup(context, loadFacade)
    });
}

async function joinDirectRallarGroup(
    context: DirectRallarOperationContext,
    loadFacade: DirectRallarFacadeLoader
): Promise<Either<DirectRallarOperationError, DirectRallarOperationSuccess>> {
    const validation = validateRoomId(context);
    if (!validation.ok) {
        return Either.ofLeft(toValidationError(validation));
    }
    const roomId = context.roomId?.trim() ?? '';
    const facade = await loadFacade();
    configureDirectRallarFacade(facade, context);
    const restoredSession = directSession(facade, context);
    if (!restoredSession) {
        return Either.ofLeft(sessionRequiredError());
    }
    const startResult = await startDirectRallarFacade(facade, context, restoredSession);
    const snapshot = await facade.rooms.join(roomId, {
        timeoutMs: context.timeoutMs,
        scope: directScope(context)
    });
    return Either.ofRight({
        value: {
            action: 'group.join',
            groupId: snapshot.group.groupId ?? roomId,
            displayName: snapshot.group.displayName,
            connected: startResult.connected,
            session: toSessionDiagnostic(startResult.session),
            snapshot
        }
    });
}

export interface DirectRallarWsSubscribeInput {
    readonly signal?: AbortSignal;
    readonly subscriptions?: RallarSubscriptionScope;
    readonly context: DirectRallarOperationContext;
    readonly selector: RallarMessageSelectorInput;
    readonly handler: DirectRallarMessageHandler;
    readonly loadFacade?: DirectRallarFacadeLoader;
}

export async function runDirectRallarWsSubscribe(
    input: DirectRallarWsSubscribeInput
): Promise<DirectRallarWsSubscribeResult> {
    return await runDirectRallarOperation({
        kind: 'ws.subscribe',
        topicBase: 'rallar.direct.ws.subscribe',
        context: input.context,
        transport: 'ws',
        startedPayload: { action: 'ws.subscribe', selector: input.selector },
        failureSelector: input.selector,
        run: async () => subscribeDirectRallarWs(input, input.loadFacade ?? loadDirectRallarFacade)
    });
}

async function subscribeDirectRallarWs(
    input: DirectRallarWsSubscribeInput,
    loadFacade: DirectRallarFacadeLoader
): Promise<Either<DirectRallarOperationError, DirectRallarOperationSuccess>> {
    const { context, selector } = input;
    const validation = validateWsSubscribe(context, selector);
    if (!validation.ok) {
        return Either.ofLeft(toValidationError(validation));
    }
    const roomId = context.roomId?.trim() ?? '';
    const facade = await loadFacade();
    if (input.signal?.aborted) {
        return abandonedDirectSubscription();
    }
    configureDirectRallarFacade(facade, context);
    const restoredSession = directSession(facade, context);
    if (!restoredSession) {
        return Either.ofLeft(sessionRequiredError());
    }
    const unsubscribe = registerDirectRallarWs(input, facade);
    try {
        if (input.signal?.aborted) {
            return abandonedDirectSubscription();
        }
        const startResult = await startDirectRallarFacade(facade, context, restoredSession);
        if (input.signal?.aborted) {
            return abandonedDirectSubscription();
        }
        const snapshot = await facade.rooms.join(roomId, {
            timeoutMs: context.timeoutMs,
            scope: directScope(context)
        });
        if (input.signal?.aborted) {
            return abandonedDirectSubscription();
        }
        return Either.ofRight({
            value: {
                action: 'ws.subscribe',
                selector,
                groupId: snapshot.group.groupId ?? roomId,
                displayName: snapshot.group.displayName,
                connected: startResult.connected,
                session: toSessionDiagnostic(startResult.session),
                wsStatus: facade.ws.status()
            },
            unsubscribe
        });
    }
    catch (error) {
        unsubscribe();
        return Either.ofLeft(decodeDirectRallarError(error));
    }
}

export async function runDirectRallarWsSend(
    context: DirectRallarOperationContext,
    input: DirectRallarWsSendInput,
    loadFacade: DirectRallarFacadeLoader = loadDirectRallarFacade
): Promise<DirectRallarOperationResult> {
    return await runDirectRallarOperation({
        kind: 'ws.send',
        topicBase: 'rallar.direct.ws.send',
        context,
        transport: 'ws',
        startedPayload: {
            action: 'ws.send',
            scope: input.scope ?? 'room',
            typeId: input.typeId,
            topicId: input.topicId,
            contextId: input.contextId
        },
        run: async () => sendDirectRallarWs(context, input, loadFacade)
    });
}

async function sendDirectRallarWs(
    context: DirectRallarOperationContext,
    input: DirectRallarWsSendInput,
    loadFacade: DirectRallarFacadeLoader
): Promise<Either<DirectRallarOperationError, DirectRallarOperationSuccess>> {
    const validation = validateWsSend(context, input);
    if (!validation.ok || !isRallarMessagePayload(input.payload)) {
        return Either.ofLeft(toValidationError(validation));
    }
    const payload = input.payload;
    const facade = await loadFacade();
    configureDirectRallarFacade(facade, context);
    const restoredSession = directSession(facade, context);
    if (!restoredSession) {
        return Either.ofLeft(sessionRequiredError());
    }
    const startResult = await startDirectRallarFacade(facade, context, restoredSession);
    const sendInput = directWsSendPayload(context, input, payload);
    const sendResult = await facade.messages.ws.send(sendInput);
    return Either.ofRight({
        value: {
            action: 'ws.send',
            groupId: context.roomId,
            selector: {
                typeId: input.typeId,
                topicId: input.topicId,
                contextId: input.contextId
            },
            connected: startResult.connected,
            session: toSessionDiagnostic(startResult.session),
            wsStatus: facade.ws.status(),
            sendInput,
            sendResult: { msgId: sendResult.msgId, typeId: sendResult.typeId, lifecycle: sendResult.lifecycle() }
        }
    });
}

function abandonedDirectSubscription(): Either<DirectRallarOperationError, DirectRallarOperationSuccess> {
    return Either.ofLeft({ code: 'RALLAR_DIRECT_OPERATION_ABORTED', message: 'WS subscription was abandoned.' });
}
function registerDirectRallarWs(input: DirectRallarWsSubscribeInput, facade: DirectRallarFacade): RallarUnsubscribe {
    const owned = new BrowserRallarSubscriptionScope();
    owned.add(facade.messages.ws.onMessage(input.selector, (message) => {
        if (!input.signal?.aborted) {
            return input.handler({ ...message });
        }
    }));
    const stopDelivery: RallarUnsubscribe = () => {
        owned.unsubscribe();
        input.signal?.removeEventListener('abort', stopDelivery);
    };
    input.subscriptions?.add(stopDelivery);
    if (input.signal?.aborted) {
        stopDelivery();
    }
    else {
        input.signal?.addEventListener('abort', stopDelivery, { once: true });
    }
    return stopDelivery;
}

function validateWsSubscribe(
    context: DirectRallarOperationContext,
    selector: RallarMessageSelectorInput
): RallarValidationResult {
    return failRallarValidation([
        ...validateRoomId(context).issues,
        ...(typeof selector !== 'string' && selector.topicId !== undefined
            ? validateRallarWsUserTopicId(selector.topicId.trim(), '$.topicId').issues
            : []),
        ...(typeof selector === 'string'
            ? validateRallarRouteId(selector, '$.typeId', 'Type ID').issues
            : selector.typeId === undefined
            ? []
            : validateRallarRouteId(selector.typeId, '$.typeId', 'Type ID').issues)
    ]);
}
