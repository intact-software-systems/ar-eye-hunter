import { toError } from '@shared/resilience/to-error.ts';
import { normalizeRallarBlackBoxRuntimeDiagnostic } from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestSendObservation,
    RallarBlackBoxTestWsSendCommand
} from '../rallar-black-box-test-contracts.ts';

import type {
    CommandWithId,
    RallarBlackBoxBrowserWebSocket,
    RallarBlackBoxBrowserWebSocketData
} from './browser-command-contracts.ts';
import {
    readBrowserCommandAuthSession,
    requireBrowserWebSocketFactory,
    type BrowserCommandEnvironment
} from './browser-command-environment.ts';
import {
    replaceCommandPlaceholders,
    requiresAuthSessionPlaceholder,
    requiresWsTicketPlaceholder
} from './browser-command-placeholders.ts';
import { decodeBrowserCommandString, isStructuredRallarWebSocketEnvelope } from './browser-command-values.ts';
import { requestWebSocketTicket } from './browser-http-requests.ts';
import { addWebSocketListener, toWebSocketClosePayload, waitForWebSocketOpen } from './browser-websocket-events.ts';
import { sendRallarWebSocketMessage } from './send-rallar-websocket-message.ts';

type WsOpenCommand = Extract<CommandWithId, { kind: 'ws.open'; }>;
type WsSendCommand = Extract<CommandWithId, { kind: 'ws.send'; }>;

export namespace BrowserWebSocketCommands {
    export interface CloseAllResult {
        readonly webSocketCount: number;
        readonly errors: readonly CloseError[];
    }

    export interface CloseError {
        readonly connection: string;
        readonly error: Error;
    }

    export interface OpenedSocket {
        readonly connection: string;
        readonly url: string;
        readonly socket: RallarBlackBoxBrowserWebSocket;
    }
}

/** Owns the adapter's raw browser WebSockets: one per connection name, with their recorded events. */
export class BrowserWebSocketCommands {
    private readonly webSockets = new Map<string, RallarBlackBoxBrowserWebSocket>();
    private readonly webSocketDisposers = new Map<string, ReadonlyArray<() => void>>();
    private readonly environment: BrowserCommandEnvironment;

    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
    }

    async openWebSocket(
        command: WsOpenCommand,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const url = await this.readWebSocketUrl(command, context);
        const connection = command.connection ?? 'default';
        if (this.webSockets.has(connection)) {
            throw new Error('WebSocket connection is already open: ' + connection);
        }

        this.recordIgnoredHeaders(command, context, connection);
        const socket = requireBrowserWebSocketFactory(this.environment)(url, command.protocols);
        this.webSockets.set(connection, socket);
        this.bridgeWebSocketEvents({ connection, url, socket }, context);
        const timeoutMs = command.timeoutMs ?? this.environment.defaultWsOpenTimeoutMs;
        try {
            await waitForWebSocketOpen({ socket, timeoutMs, signal: context.abortSignal?.() });
        }
        catch (caught) {
            this.closeWebSocketResource({
                connection,
                socket,
                code: undefined,
                reason: undefined,
                detachImmediately: true
            });
            throw new Error(`${toError(caught).message} url=${toRedactedWebSocketUrl(url)}`);
        }
        return this.recordOpened(command, context, { connection, url, socket });
    }

    async sendWebSocket(
        command: WsSendCommand,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const connection = command.connection ?? 'default';
        if (this.usesRallarSignaling(command, context)) {
            return await sendRallarWebSocketMessage({ environment: this.environment, command, context, connection });
        }
        const socket = this.webSockets.get(connection);
        if (!socket) {
            throw new Error('WebSocket connection is not open: ' + connection);
        }

        const data = toWebSocketSendData(replaceCommandPlaceholders(command.data, {
            config: context.config(),
            session: this.environment.readSession(),
            wsTicket: undefined
        }));
        const sendStartedAtEpochMs = this.environment.now();
        socket.send(data);
        const durationMs = Math.max(0, this.environment.now() - sendStartedAtEpochMs);
        const queued = typeof socket.bufferedAmount === 'number' && socket.bufferedAmount > 0;
        const sendObservation: RallarBlackBoxTestSendObservation = {
            commandId: command.commandId,
            kind: command.kind,
            transport: 'ws',
            durationMs,
            ok: true,
            status: queued ? 'queued' : 'sent',
            queued
        };
        return { status: 'ok', value: { connection, sent: data, sendObservation } };
    }

    closeWebSocket(command: Extract<CommandWithId, { kind: 'ws.close'; }>): RallarBlackBoxTestCommandOutcome {
        const connection = command.connection ?? 'default';
        const socket = this.webSockets.get(connection);
        if (!socket) {
            return { status: 'ok', value: { connection, closed: false, reason: 'not-open' } };
        }

        this.closeWebSocketResource({
            connection,
            socket,
            code: command.code,
            reason: command.reason,
            detachImmediately: false
        });
        return { status: 'ok', value: { connection, closed: true } };
    }

    closeAll(): BrowserWebSocketCommands.CloseAllResult {
        const errors: BrowserWebSocketCommands.CloseError[] = [];
        const webSockets = [...this.webSockets.entries()];
        for (const [connection, socket] of webSockets) {
            try {
                this.closeWebSocketResource({
                    connection,
                    socket,
                    code: undefined,
                    reason: undefined,
                    detachImmediately: true
                });
            }
            catch (caught) {
                errors.push({ connection, error: toError(caught) });
            }
            finally {
                this.detachWebSocketListeners(connection);
            }
        }
        this.webSockets.clear();
        for (const connection of [...this.webSocketDisposers.keys()]) {
            this.detachWebSocketListeners(connection);
        }
        return { webSocketCount: webSockets.length, errors };
    }

    connectionNames(): string[] {
        return [...this.webSockets.keys()];
    }

    private usesRallarSignaling(command: WsSendCommand, context: RallarBlackBoxTestCommandContext): boolean {
        return Boolean(this.environment.rallarRuntime?.sendWs) &&
            decodeBrowserCommandString(context.config()?.control?.providerMode) === 'browser-rallar' &&
            isStructuredRallarWebSocketEnvelope(command.data);
    }

    private recordOpened(
        command: WsOpenCommand,
        context: RallarBlackBoxTestCommandContext,
        opened: BrowserWebSocketCommands.OpenedSocket
    ): RallarBlackBoxTestCommandOutcome {
        const { connection, url, socket } = opened;
        const value = { connection, url: socket.url ?? url, protocol: socket.protocol, readyState: socket.readyState };
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.ws.opened',
            commandId: command.commandId,
            connection,
            transport: 'ws',
            severity: 'info',
            payload: value
        });
        return { status: 'ok', value, nextStatus: context.state().status };
    }

    private bridgeWebSocketEvents(
        opened: BrowserWebSocketCommands.OpenedSocket,
        context: RallarBlackBoxTestCommandContext
    ): void {
        const { connection, socket } = opened;
        this.detachWebSocketListeners(connection);
        this.webSocketDisposers.set(connection, [
            addWebSocketListener(socket, 'message', (event) => {
                context.recordEvent({
                    kind: 'message',
                    topic: 'rallar.bb.ws.message',
                    connection,
                    transport: 'ws',
                    severity: 'info',
                    payload: { data: event.data }
                });
            }),
            addWebSocketListener(socket, 'close', (event) => {
                this.webSockets.delete(connection);
                this.detachWebSocketListeners(connection);
                context.recordEvent({
                    kind: 'event',
                    topic: 'rallar.bb.ws.closed',
                    connection,
                    transport: 'ws',
                    severity: 'warning',
                    payload: toWebSocketClosePayload(event)
                });
            }),
            addWebSocketListener(socket, 'error', (event) => {
                recordWebSocketError(context, connection, { event });
            })
        ]);
    }

    private detachWebSocketListeners(connection: string): void {
        const disposers = this.webSocketDisposers.get(connection);
        if (!disposers) {
            return;
        }

        this.webSocketDisposers.delete(connection);
        for (const dispose of disposers) {
            try {
                dispose();
            }
            catch (_error) {
                // Listener cleanup is best-effort; command cleanup still closes the socket.
            }
        }
    }

    private closeWebSocketResource(input: CloseWebSocketResourceInput): void {
        const { connection, socket, code, reason, detachImmediately } = input;
        try {
            socket.close(code, reason);
        }
        finally {
            this.webSockets.delete(connection);
            if (detachImmediately || socket.readyState === undefined) {
                this.detachWebSocketListeners(connection);
            }
        }
    }

    private recordIgnoredHeaders(
        command: WsOpenCommand,
        context: RallarBlackBoxTestCommandContext,
        connection: string
    ): void {
        if (!command.headers) {
            return;
        }
        const reason = 'Browser WebSocket constructors cannot set custom headers.';
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.ws.headers_ignored',
            commandId: command.commandId,
            connection,
            transport: 'ws',
            severity: 'warning',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: 'rallar.bb.ws.headers_ignored',
                severity: 'warning',
                commandId: command.commandId,
                connection,
                transport: 'ws',
                message: reason,
                payload: { reason, headers: command.headers },
                source: 'browser-adapter'
            })
        });
    }

    private async readWebSocketUrl(
        command: WsOpenCommand,
        context: RallarBlackBoxTestCommandContext
    ): Promise<string> {
        const config = context.config();
        const session = await readBrowserCommandAuthSession(
            { command, context, required: requiresAuthSessionPlaceholder(command.url) },
            this.environment
        );
        const wsTicket = requiresWsTicketPlaceholder(command.url)
            ? await requestWebSocketTicket(this.environment, config, session)
            : undefined;
        const url = command.url ? replaceCommandPlaceholders(command.url, { config, session, wsTicket }) : undefined;
        if (!url) {
            throw new Error('ws.open requires url.');
        }
        return url;
    }
}

interface CloseWebSocketResourceInput {
    readonly connection: string;
    readonly socket: RallarBlackBoxBrowserWebSocket;
    readonly code: number | undefined;
    readonly reason: string | undefined;
    readonly detachImmediately: boolean;
}

function toWebSocketSendData(data: RallarBlackBoxTestWsSendCommand['data']): RallarBlackBoxBrowserWebSocketData {
    return typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)
        ? data
        : JSON.stringify(data);
}

function toRedactedWebSocketUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.searchParams.has('ticket')) {
            url.searchParams.set('ticket', '<redacted>');
        }
        return url.toString();
    }
    catch {
        return value.replace(/([?&]ticket=)[^&]+/i, '$1<redacted>');
    }
}

function recordWebSocketError(
    context: RallarBlackBoxTestCommandContext,
    connection: string,
    payload: RallarBlackBoxTestRecord
): void {
    context.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.bb.ws.error',
        connection,
        transport: 'ws',
        severity: 'error',
        payload: normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.bb.ws.error',
            severity: 'error',
            connection,
            transport: 'ws',
            payload,
            source: 'browser-adapter'
        })
    });
}
