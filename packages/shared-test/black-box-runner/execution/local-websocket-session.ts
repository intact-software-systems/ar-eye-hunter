import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { validateRallarRouteId } from '@shared/api/rallar-validation.ts';
import { STATE_SNAPSHOT_LIMITS } from '@shared/api/state-snapshot-page.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { StateSnapshotAssembly } from '@shared/services/state-snapshot-assembly.ts';
import { toWsConnectionName, toWsFailureStatus, toWsSuccessStatus } from '../ws/ws-interaction-statuses.ts';
import {
    resolveWsOpenExpectation,
    validateWsOpenExpectation,
    type WsOpenCloseEvent,
    type WsOpenExpectation,
    type WsOpenOutcome
} from '../ws/ws-open-expectation.ts';
import { acceptLocalWsFrame, type LocalWsMessage } from './local-websocket-frame.ts';

export interface LocalWsRequest {
    readonly url?: string;
    readonly path?: string;
    readonly connection?: string;
    readonly name?: string;
    readonly timeoutMs?: number | string;
    /** Scope used to authenticate and create this connection's application resources. */
    readonly snapshotScope?: unknown;
    readonly closeCode?: number;
    readonly closeReason?: string;
    readonly code?: number;
    readonly reason?: string;
}

export interface LocalWsInteraction {
    readonly request: LocalWsRequest;
    readonly response?: Readonly<{ rejected?: boolean; close?: unknown; }>;
}

export interface LocalWsContext {
    readonly wsConnections: Record<string, WebSocket | undefined>;
    readonly wsMessages: Record<string, LocalWsMessage[] | undefined>;
    readonly wsCloseEvents: Record<string, unknown[] | undefined>;
    wsSnapshotAssemblies?: Record<string, StateSnapshotAssembly | undefined>;
    wsObservationLoss?: Record<string, number>;
}

export interface LocalWsSocketState {
    readonly readyState: number | undefined;
    readonly readyStateName: string;
    readonly bufferedAmount?: number;
}

const MAX_RETAINED_MESSAGES = 256;
const MAX_RETAINED_BYTES = STATE_SNAPSHOT_LIMITS.aggregateBytes;
const MAX_CLOSE_EVENTS = 64;

export function toWsSocketState(ws: WebSocket | undefined): LocalWsSocketState {
    const names = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return {
        readyState: ws?.readyState,
        readyStateName: ws ? names[ws.readyState] ?? 'UNKNOWN' : 'MISSING',
        bufferedAmount: ws?.bufferedAmount
    };
}

function readSnapshotScope(value: unknown): Either<ALMessageRejection, StateScope> {
    if (
        typeof value !== 'object' || value === null || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 2 ||
        !('applicationId' in value) || !('workspaceId' in value) ||
        typeof value.applicationId !== 'string' || typeof value.workspaceId !== 'string' ||
        !validateRallarRouteId(value.applicationId).ok || !validateRallarRouteId(value.workspaceId).ok
    ) {
        return Either.ofLeft({
            code: 'malformed',
            message: 'snapshotScope requires bounded applicationId and workspaceId strings'
        });
    }
    return Either.ofRight({ applicationId: value.applicationId, workspaceId: value.workspaceId });
}

function rememberWsMessage(connectionName: string, message: LocalWsMessage, context: LocalWsContext): void {
    const messages = context.wsMessages[connectionName] ??= [];
    messages.push(message);
    let retainedBytes = messages.reduce((total, entry) => total + entry.retainedBytes, 0);
    while (messages.length > MAX_RETAINED_MESSAGES || retainedBytes > MAX_RETAINED_BYTES) {
        retainedBytes -= messages.shift()!.retainedBytes;
        recordWsObservationLoss(connectionName, context);
    }
}

function recordWsObservationLoss(connectionName: string, context: LocalWsContext): void {
    const losses = context.wsObservationLoss ??= {};
    losses[connectionName] = Math.min(Number.MAX_SAFE_INTEGER, (losses[connectionName] ?? 0) + 1);
}

function clearWsSemanticObservations(connectionName: string, context: LocalWsContext): void {
    recordWsObservationLoss(connectionName, context);
    context.wsMessages[connectionName] = (context.wsMessages[connectionName] ?? []).flatMap((message) =>
        message.wireFrame === undefined ? [] : [{ ...message, data: undefined }]
    );
}

export function rememberWsCloseEvent(connectionName: string, closeEvent: unknown, context: LocalWsContext): void {
    const events = context.wsCloseEvents[connectionName] ??= [];
    events.push(closeEvent);
    if (events.length > MAX_CLOSE_EVENTS) {
        events.splice(0, events.length - MAX_CLOSE_EVENTS);
    }
}

export function openWs(interaction: LocalWsInteraction, config: unknown, context: LocalWsContext): Promise<unknown> {
    const expectation = validateWsOpenExpectation(interaction.response ?? {});
    if (expectation.left) {
        return Promise.resolve(toWsFailureStatus(config, interaction, expectation.left.message));
    }
    const request = interaction.request;
    const connectionName = toWsConnectionName(request);
    const url = request.url || request.path;
    const scope = request.snapshotScope === undefined ? undefined : readSnapshotScope(request.snapshotScope);
    if (scope?.left) {
        return Promise.resolve(toWsFailureStatus(config, interaction, scope.left.message));
    }
    if (!url) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket URL is missing'));
    }
    if (scope?.right) {
        const parameters = new URL(url).searchParams;
        if (
            parameters.get('applicationId') !== scope.right.applicationId ||
            parameters.get('workspaceId') !== scope.right.workspaceId
        ) {
            return Promise.resolve(
                toWsFailureStatus(
                    config,
                    interaction,
                    'snapshotScope must match the explicit authenticated WebSocket URL scope'
                )
            );
        }
    }
    const timeoutMs = request.timeoutMs === undefined ? 5000 : Number(request.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket timeout must be positive'));
    }
    return new LocalWsConnection({
        interaction,
        config,
        context,
        connectionName,
        url,
        scope: scope?.right,
        timeoutMs,
        expectation: expectation.right!
    })
        .open();
}

namespace LocalWsConnection {
    export interface OpenResult {
        readonly outcome: WsOpenOutcome;
        readonly failureResult: string;
        readonly details: Readonly<Record<string, unknown>>;
        readonly close: WsOpenCloseEvent | undefined;
    }
    export interface Input {
        readonly interaction: LocalWsInteraction;
        readonly config: unknown;
        readonly context: LocalWsContext;
        readonly connectionName: string;
        readonly url: string;
        readonly scope: StateScope | undefined;
        readonly timeoutMs: number;
        readonly expectation: WsOpenExpectation;
    }
}

/** Owns the authenticated socket generation and its incomplete snapshot transfers. */
class LocalWsConnection {
    readonly #input: LocalWsConnection.Input;
    readonly #socket: WebSocket;
    readonly #assembly = new StateSnapshotAssembly();
    #timeout: ReturnType<typeof setTimeout> | undefined;
    #settle: ((result: unknown) => void) | undefined;
    #opened = false;

    constructor(input: LocalWsConnection.Input) {
        this.#input = input;
        this.#socket = new WebSocket(input.url);
    }

    open(): Promise<unknown> {
        return new Promise((resolve) => {
            this.#settle = resolve;
            this.#timeout = setTimeout(() => {
                this.#dispose();
                this.#resolveOpen({
                    outcome: 'timedOut',
                    failureResult: 'WebSocket connect timed out',
                    details: { timeoutMs: this.#input.timeoutMs },
                    close: undefined
                });
                this.#socket.close();
            }, this.#input.timeoutMs);
            this.#socket.onopen = () => this.#onOpen();
            this.#socket.onmessage = (event) => this.#onMessage(event);
            this.#socket.onclose = (event) => this.#onClose(event);
            this.#socket.onerror = (event) => this.#onError(event);
        });
    }

    #onOpen(): void {
        this.#resolveOpen({
            outcome: 'opened',
            failureResult: 'WebSocket opened',
            details: { readyState: this.#socket.readyState },
            close: undefined
        });
    }

    #registerOpen(): void {
        const { context, connectionName } = this.#input;
        const previous = context.wsConnections[connectionName];
        context.wsSnapshotAssemblies?.[connectionName]?.dispose();
        context.wsConnections[connectionName] = this.#socket;
        (context.wsSnapshotAssemblies ??= {})[connectionName] = this.#assembly;
        // Historical wire evidence survives reconnect; semantic matches belong to this generation.
        clearWsSemanticObservations(connectionName, context);
        context.wsCloseEvents[connectionName] ??= [];
        previous?.close();
        this.#opened = true;
    }

    #onMessage(event: MessageEvent): void {
        const { context, connectionName, scope } = this.#input;
        if (!this.#opened || context.wsConnections[connectionName] !== this.#socket) {
            return;
        }
        const records = acceptLocalWsFrame({
            maxRetainedBytes: MAX_RETAINED_BYTES,
            value: event.data,
            scope,
            assembly: this.#assembly,
            nowMs: Date.now()
        });
        for (const record of records) {
            if (record.rejection) {
                recordWsObservationLoss(connectionName, context);
            }
            rememberWsMessage(connectionName, record, context);
        }
    }

    #onClose(event: CloseEvent): void {
        const { context, connectionName } = this.#input;
        this.#dispose();
        this.#opened = false;
        rememberWsCloseEvent(connectionName, {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
            closedAtEpochMs: Date.now()
        }, context);
        if (context.wsConnections[connectionName] === this.#socket) {
            delete context.wsConnections[connectionName];
        }
        this.#resolveOpen({
            outcome: 'refused',
            failureResult: 'WebSocket closed before opening',
            details: { code: event.code, reason: event.reason, wasClean: event.wasClean },
            close: { code: event.code, reason: event.reason }
        });
    }

    #onError(event: Event): void {
        const { context, connectionName } = this.#input;
        this.#dispose();
        this.#opened = false;
        if (context.wsConnections[connectionName] === this.#socket) {
            delete context.wsConnections[connectionName];
        }
        this.#resolveOpen({
            outcome: 'errored',
            failureResult: 'WebSocket connection failed',
            details: { eventType: event.type, readyState: this.#socket.readyState },
            close: undefined
        });
        this.#socket.close();
    }

    #dispose(): void {
        const { context, connectionName } = this.#input;
        this.#assembly.dispose();
        if (context.wsConnections[connectionName] === this.#socket) {
            clearWsSemanticObservations(connectionName, context);
        }
        if (context.wsSnapshotAssemblies?.[connectionName] === this.#assembly) {
            delete context.wsSnapshotAssemblies[connectionName];
        }
    }

    #resolveOpen(result: LocalWsConnection.OpenResult): void {
        if (!this.#settle) {
            if (result.outcome === 'opened') {
                this.#socket.close();
            }
            return;
        }
        const { config, interaction, connectionName, url } = this.#input;
        const verdict = resolveWsOpenExpectation({
            expectation: this.#input.expectation,
            outcome: result.outcome,
            close: result.close
        });
        const details = { connection: connectionName, url, ...result.details };
        if (verdict.satisfied) {
            if (result.outcome === 'opened') {
                this.#registerOpen();
            }
            this.#resolve(toWsSuccessStatus(config, interaction, details));
            return;
        }
        this.#resolve(toWsFailureStatus(config, interaction, verdict.message ?? result.failureResult, details));
        if (result.outcome === 'opened') {
            this.#dispose();
            this.#socket.close();
        }
    }

    #resolve(result: unknown): void {
        clearTimeout(this.#timeout);
        this.#settle?.(result);
        this.#settle = undefined;
    }
}

export function closeWs(interaction: LocalWsInteraction, config: unknown, context: LocalWsContext): Promise<unknown> {
    const request = interaction.request;
    const connectionName = toWsConnectionName(request);
    const ws = context.wsConnections[connectionName];
    const closeCode = request.closeCode ?? request.code;
    const closeReason = request.closeReason ?? request.reason;
    clearWsSemanticObservations(connectionName, context);
    context.wsSnapshotAssemblies?.[connectionName]?.dispose();
    if (context.wsSnapshotAssemblies) {
        delete context.wsSnapshotAssemblies[connectionName];
    }
    if (!ws) {
        return Promise.resolve(toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closed: false,
            reason: 'WebSocket connection was not open'
        }));
    }
    try {
        ws.close(closeCode, closeReason);
        delete context.wsConnections[connectionName];
        return Promise.resolve(toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closeRequested: true,
            closed: true,
            closeCode,
            closeReason
        }));
    }
    catch (error) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'Failed to close WebSocket connection', {
            connection: connectionName,
            closeCode,
            closeReason,
            exception: error instanceof Error ? error.message : String(error)
        }));
    }
}
