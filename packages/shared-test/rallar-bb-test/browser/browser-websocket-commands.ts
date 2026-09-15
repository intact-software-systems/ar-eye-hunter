import {
    normalizeRallarBlackBoxRuntimeDiagnostic
} from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome
} from '../rallar-black-box-test-contracts.ts';

import {
    createBrowserCommandAbortScope,
    toAbortError,
    withBrowserCommandAbort
} from './browser-command-cancellation.ts';
import { CommandWithId, RallarBlackBoxBrowserWebSocket } from './browser-command-contracts.ts';
import {
    BrowserCommandEnvironment,
    readBrowserCommandAuthSession,
    requireBrowserCommandRuntime,
    requireBrowserWebSocketFactory
} from './browser-command-environment.ts';
import { replaceCommandPlaceholders, requiresWsTicketPlaceholder } from './browser-command-placeholders.ts';
import {
    isRuntimeNotConnectedError,
    isStructuredRallarWebSocketEnvelope,
    resolveConfigProviderMode,
    toBrowserCommandErrorMessage,
    toBrowserCommandRecord
} from './browser-command-values.ts';
import { requestWebSocketTicket } from './browser-http-requests.ts';
import { toRallarWebSocketConnectionConfig } from './browser-rallar-command-input.ts';

export const WEBSOCKET_OPEN_STATE = 1;

export function addWebSocketListener(
    socket: RallarBlackBoxBrowserWebSocket,
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void
): () => void {
    if (socket.addEventListener && socket.removeEventListener) {
        socket.addEventListener(type, listener);
        return () => socket.removeEventListener?.(type, listener);
    }

    const property = `on${type}` as keyof Pick<
        RallarBlackBoxBrowserWebSocket,
        'onopen' | 'onmessage' | 'onclose' | 'onerror'
    >;
    const previous = socket[property];
    const next = (event: unknown) => {
        previous?.(event);
        listener(event);
    };

    socket[property] = next;
    return () => {
        if (socket[property] === next) {
            socket[property] = previous;
        }
    };
}

export function toWebSocketSendData(data: unknown): unknown {
    if (
        typeof data === 'string' ||
        data instanceof ArrayBuffer ||
        ArrayBuffer.isView(data)
    ) {
        return data;
    }

    return JSON.stringify(data);
}

export function toWebSocketMessageData(event: unknown): unknown {
    if (event && typeof event === 'object' && 'data' in event) {
        return (event as { data: unknown; }).data;
    }

    return undefined;
}

export function toWebSocketClosePayload(event: unknown): Record<string, unknown> {
    const closeEvent = toBrowserCommandRecord(event);
    return {
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean
    };
}

export function redactedWebSocketUrl(value: string): string {
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

export namespace BrowserWebSocketCommands {
    export interface CloseInput {
        readonly connection: string;
        readonly socket: RallarBlackBoxBrowserWebSocket;
        readonly code: number | undefined;
        readonly reason: string | undefined;
        readonly detachImmediately: boolean;
    }
}
export class BrowserWebSocketCommands {
    private readonly webSockets = new Map<string, RallarBlackBoxBrowserWebSocket>();
    private readonly webSocketDisposers = new Map<string, Array<() => void>>();

    private readonly environment: BrowserCommandEnvironment;
    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
    }
    async openWebSocket(
        command: Extract<CommandWithId, { kind: 'ws.open'; }>,
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
        this.bridgeWebSocketEvents(socket, connection, context);
        try {
            await this.waitForWebSocketOpen(socket, command, context.abortSignal?.());
        }
        catch (error) {
            this.closeWebSocketResource({
                connection: connection,
                socket: socket,
                code: undefined,
                reason: undefined,
                detachImmediately: true
            });
            throw new Error(
                `${toBrowserCommandErrorMessage(error)} url=${redactedWebSocketUrl(url)}`
            );
        }

        const value = {
            connection,
            url: socket.url ?? url,
            protocol: socket.protocol,
            readyState: socket.readyState
        };
        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.ws.opened',
            commandId: command.commandId,
            connection,
            transport: 'ws',
            severity: 'info',
            payload: value
        });

        return {
            status: 'ok',
            value,
            nextStatus: context.state().status
        };
    }

    private bridgeWebSocketEvents(
        socket: RallarBlackBoxBrowserWebSocket,
        connection: string,
        context: RallarBlackBoxTestCommandContext
    ): void {
        this.detachWebSocketListeners(connection);
        const disposers: Array<() => void> = [];
        disposers.push(
            addWebSocketListener(socket, 'message', (event) => {
                context.recordEvent({
                    kind: 'message',
                    topic: 'rallar.bb.ws.message',
                    connection,
                    transport: 'ws',
                    severity: 'info',
                    payload: {
                        data: toWebSocketMessageData(event)
                    }
                });
            })
        );
        disposers.push(
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
            })
        );
        disposers.push(
            addWebSocketListener(socket, 'error', (event) => {
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
                        payload: {
                            event
                        },
                        source: 'browser-adapter'
                    })
                });
            })
        );
        this.webSocketDisposers.set(connection, disposers);
    }

    private detachWebSocketListeners(connection: string): void {
        const disposers = this.webSocketDisposers.get(connection);
        if (!disposers) {
            return;
        }

        this.webSocketDisposers.delete(connection);
        disposers.forEach((dispose) => {
            try {
                dispose();
            }
            catch (_error) {
                // Listener cleanup is best-effort; command cleanup still closes the socket.
            }
        });
    }

    private waitForWebSocketOpen(
        socket: RallarBlackBoxBrowserWebSocket,
        command: Extract<CommandWithId, { kind: 'ws.open'; }>,
        signal: AbortSignal | undefined
    ): Promise<void> {
        if (socket.readyState === WEBSOCKET_OPEN_STATE) {
            return Promise.resolve();
        }

        const timeoutMs = command.timeoutMs ?? this.environment.defaultWsOpenTimeoutMs;
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup: Array<() => void> = [];
            const timeout = setTimeout(() => {
                complete(() =>
                    reject(
                        new Error('WebSocket did not open within ' + timeoutMs + 'ms.')
                    )
                );
            }, timeoutMs);

            const complete = (callback: () => void) => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeout);
                cleanup.forEach((dispose) => dispose());
                signal?.removeEventListener('abort', abort);
                callback();
            };
            const abort = () => {
                complete(() => reject(toAbortError(signal?.reason)));
            };

            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener('abort', abort, { once: true });

            cleanup.push(
                addWebSocketListener(socket, 'open', () => {
                    complete(resolve);
                })
            );
            cleanup.push(
                addWebSocketListener(socket, 'error', () => {
                    complete(() => reject(new Error('WebSocket failed before open.')));
                })
            );
            cleanup.push(
                addWebSocketListener(socket, 'close', (event) => {
                    complete(() => reject(toWebSocketClosedBeforeOpenError(event)));
                })
            );
        });
    }

    async sendWebSocket(
        command: Extract<CommandWithId, { kind: 'ws.send'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const connection = command.connection ?? 'default';
        const socket = this.webSockets.get(connection);
        const shouldUseRallarSignaling = Boolean(this.environment.rallarRuntime?.sendWs) &&
            resolveConfigProviderMode(context.config()) === 'browser-rallar' &&
            isStructuredRallarWebSocketEnvelope(command.data);

        if (shouldUseRallarSignaling) {
            return await this.sendWebSocketViaRallar(command, context, connection);
        }

        if (!socket) {
            throw new Error('WebSocket connection is not open: ' + connection);
        }

        const resolvedData = replaceCommandPlaceholders(command.data, {
            config: context.config(),
            session: this.environment.readSession()
        });
        const data = toWebSocketSendData(resolvedData);
        const sendStartedAtEpochMs = this.environment.now();
        socket.send(data);
        const durationMs = Math.max(0, this.environment.now() - sendStartedAtEpochMs);
        const bufferedAmount = typeof socket.bufferedAmount === 'number'
            ? socket.bufferedAmount
            : undefined;
        const sendObservation = {
            commandId: command.commandId,
            kind: command.kind,
            transport: 'ws',
            durationMs,
            ok: true,
            status: bufferedAmount !== undefined && bufferedAmount > 0 ? 'queued' : 'sent',
            queued: bufferedAmount !== undefined && bufferedAmount > 0
        };
        return {
            status: 'ok',
            value: {
                connection,
                sent: data,
                sendObservation
            }
        };
    }

    private async sendWebSocketViaRallar(
        command: Extract<CommandWithId, { kind: 'ws.send'; }>,
        context: RallarBlackBoxTestCommandContext,
        connection: string
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const data = replaceCommandPlaceholders(command.data, {
            config: context.config(),
            session: this.environment.readSession()
        });
        const sendStartedAtEpochMs = this.environment.now();
        const result = await this.writeRallarWebSocket(command, context, data);
        const durationMs = Math.max(0, this.environment.now() - sendStartedAtEpochMs);
        const sendObservation = {
            commandId: command.commandId,
            kind: command.kind,
            transport: 'ws',
            durationMs,
            ok: true,
            status: 'sent'
        };

        context.recordEvent({
            kind: 'event',
            topic: 'rallar.bb.ws.sent_via_rallar_signaling',
            commandId: command.commandId,
            connection,
            transport: 'ws',
            severity: 'info',
            payload: {
                connection,
                via: 'rallar-signaling-websocket',
                rallar: result,
                sendObservation
            }
        });
        return {
            status: 'ok',
            value: {
                connection,
                via: 'rallar-signaling-websocket',
                sent: data,
                rallar: result,
                sendObservation
            }
        };
    }

    closeWebSocket(
        command: Extract<CommandWithId, { kind: 'ws.close'; }>
    ): RallarBlackBoxTestCommandOutcome {
        const connection = command.connection ?? 'default';
        const socket = this.webSockets.get(connection);
        if (!socket) {
            return {
                status: 'ok',
                value: {
                    connection,
                    closed: false,
                    reason: 'not-open'
                }
            };
        }

        this.closeWebSocketResource({
            connection: connection,
            socket: socket,
            code: command.code,
            reason: command.reason,
            detachImmediately: false
        });
        return {
            status: 'ok',
            value: {
                connection,
                closed: true
            }
        };
    }

    private closeWebSocketResource(input: BrowserWebSocketCommands.CloseInput): void {
        const { connection, socket, code, reason, detachImmediately } = input;
        try {
            socket.close(code, reason);
        }
        finally {
            this.webSockets.delete(connection);
            if (
                detachImmediately === true ||
                socket.readyState === undefined
            ) {
                this.detachWebSocketListeners(connection);
            }
        }
    }

    private recordIgnoredHeaders(
        command: Extract<CommandWithId, { kind: 'ws.open'; }>,
        context: RallarBlackBoxTestCommandContext,
        connection: string
    ): void {
        if (command.headers) {
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
                    message: 'Browser WebSocket constructors cannot set custom headers.',
                    payload: {
                        reason: 'Browser WebSocket constructors cannot set custom headers.',
                        headers: command.headers
                    },
                    source: 'browser-adapter'
                })
            });
        }
    }

    private async writeRallarWebSocket(
        command: Extract<CommandWithId, { kind: 'ws.send'; }>,
        context: RallarBlackBoxTestCommandContext,
        data: unknown
    ): Promise<unknown> {
        const runtime = requireBrowserCommandRuntime(this.environment);
        const sendWs = runtime.sendWs;
        if (!sendWs) {
            throw new Error('Browser Rallar runtime does not support ws.send.');
        }
        let result: unknown;
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);

        try {
            result = await withBrowserCommandAbort(sendWs(data), abort.signal);
        }
        catch (error) {
            if (!isRuntimeNotConnectedError(error)) {
                throw error;
            }
            await withBrowserCommandAbort(
                runtime.connect(
                    toRallarWebSocketConnectionConfig(command, context.config())
                ),
                abort.signal
            );
            result = await withBrowserCommandAbort(sendWs(data), abort.signal);
        }
        finally {
            abort.cleanup();
        }

        return result;
    }

    closeAll(): { webSocketCount: number; errors: unknown[]; } {
        const errors: unknown[] = [];
        const webSockets = [...this.webSockets.entries()];
        webSockets.forEach(([connection, socket]) => {
            try {
                this.closeWebSocketResource({
                    connection: connection,
                    socket: socket,
                    code: undefined,
                    reason: undefined,
                    detachImmediately: true
                });
            }
            catch (error) {
                errors.push({
                    connection,
                    error
                });
            }
            finally {
                this.detachWebSocketListeners(connection);
            }
        });
        this.webSockets.clear();
        this.webSocketDisposers.forEach((_disposers, connection) => {
            this.detachWebSocketListeners(connection);
        });

        return { webSocketCount: webSockets.length, errors };
    }

    connectionNames(): string[] {
        return [...this.webSockets.keys()];
    }

    private async readWebSocketUrl(
        command: Extract<CommandWithId, { kind: 'ws.open'; }>,
        context: RallarBlackBoxTestCommandContext
    ): Promise<string> {
        const config = context.config();
        const session = await readBrowserCommandAuthSession(
            { value: command.url, command, context, required: false },
            this.environment
        );
        const wsTicket = requiresWsTicketPlaceholder(command.url)
            ? await requestWebSocketTicket(this.environment, config, session)
            : undefined;
        const url = command.url
            ? replaceCommandPlaceholders(command.url, {
                config,
                session,
                wsTicket
            })
            : undefined;
        if (!url) {
            throw new Error('ws.open requires url.');
        }

        return url;
    }
}

function toWebSocketClosedBeforeOpenError(event: unknown): Error {
    const payload = toWebSocketClosePayload(event);
    return new Error(
        'WebSocket closed before open. code=' + String(payload.code) + ', reason=' + String(payload.reason)
    );
}
