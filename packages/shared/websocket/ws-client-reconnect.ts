import { Command } from '../cache/Command.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '../resilience/TryWith.ts';
import type { WsQueueBoxClientService } from '../services/ws-queue-box-client-service.ts';
import type { JsonWebSocketClient } from './json-web-socket-client.ts';

export namespace WsClientReconnect {
    export interface Input {
        readonly socket: JsonWebSocketClient;
        readonly sessionId: string;
        readonly reconnect: WsQueueBoxClientService.ReconnectOptions;
        readonly newConnectionRequestId: (() => string) | undefined;
    }
}

/** Owns reconnect retries and their cancellation generation for one WS client. */
export class WsClientReconnect {
    private readonly dependencies: WsClientReconnect.Input;
    private readonly socket: JsonWebSocketClient;
    private readonly sessionId: string;
    private readonly reconnectStatus: WsQueueBoxClientService.ReconnectStatus = {
        task: undefined,
        enabled: false,
        generation: 0,
        attempts: 0,
        exhausted: false
    };

    constructor(input: WsClientReconnect.Input) {
        this.dependencies = input;
        this.socket = input.socket;
        this.sessionId = input.sessionId;
    }

    readHealth(): Pick<
        WsQueueBoxClientService.Health,
        'reconnecting' | 'reconnectEnabled' | 'reconnectAttempts' | 'maxReconnectAttempts' | 'reconnectExhausted'
    > {
        return {
            reconnecting: this.reconnectStatus.task !== undefined,
            reconnectEnabled: this.reconnectStatus.enabled,
            reconnectAttempts: this.reconnectStatus.attempts,
            maxReconnectAttempts: this.dependencies.reconnect.maxAttempts,
            reconnectExhausted: this.reconnectStatus.exhausted
        };
    }

    enable(): void {
        this.reconnectStatus.enabled = true;
        this.reconnectStatus.attempts = 0;
        this.reconnectStatus.exhausted = false;
        this.socket
            .onWebsocketCallbacksDo(
                this.sessionId,
                {
                    onOpen: () => {},
                    onClose: () => this.reconnect(),
                    onError: () => this.reconnect()
                }
            );
    }

    disable(): void {
        this.reconnectStatus.enabled = false;
        this.reconnectStatus.generation++;
        this.reconnectStatus.attempts = 0;
        this.reconnectStatus.exhausted = false;
    }

    private reconnect() {
        if (!this.canReconnect()) {
            return;
        }

        if (this.reconnectStatus.task) {
            return;
        }

        const reconnectGeneration = this.reconnectStatus.generation;
        const connectionRequestId = this.dependencies.newConnectionRequestId?.();
        const reconnectTask = tryWithPolicy(
            async () =>
                await this.attemptReconnect(
                    reconnectGeneration,
                    connectionRequestId
                ),
            this.toReconnectPolicy(reconnectGeneration)
        )
            .catch(
                (error) =>
                    this.stopReconnectAfterFailure(
                        error instanceof Error ? error : new Error(String(error)),
                        reconnectGeneration
                    )
            )
            .finally(() => {
                if (this.reconnectStatus.task === reconnectTask) {
                    this.reconnectStatus.task = undefined;
                }
            });

        this.reconnectStatus.task = reconnectTask;
    }

    private async attemptReconnect(
        reconnectGeneration: number,
        connectionRequestId: string | undefined
    ): Promise<void> {
        if (!this.isReconnectCurrent(reconnectGeneration)) {
            return;
        }

        this.reconnectStatus.attempts++;
        await this.connectSocketForReconnect(connectionRequestId);
        this.reconnectStatus.attempts = 0;
        this.reconnectStatus.exhausted = false;
    }

    private async connectSocketForReconnect(requestId: string | undefined): Promise<void> {
        const timeoutMs = this.dependencies.reconnect.connectTimeoutMsecs;
        if (timeoutMs <= 0) {
            await this.socket.connect({ requestId });
            return;
        }

        await new Command<void>(
            (signal) => this.socket.connect({ requestId, signal }),
            {
                timeoutMs,
                errorOnNull: false
            }
        ).run();
    }

    private toReconnectPolicy(reconnectGeneration: number): TryWithPolicy {
        return TryWithPolicy.defaults()
            .label(`ws-reconnect:${this.sessionId}`)
            .maxAttempts(this.dependencies.reconnect.maxAttempts)
            .initialDelayMsecs(this.dependencies.reconnect.retryIntervalMsecs)
            .maxDelayMsecs(this.dependencies.reconnect.maxRetryIntervalMsecs)
            .jitterRatio(0)
            .retryIf(() => this.isReconnectCurrent(reconnectGeneration));
    }

    private stopReconnectAfterFailure(
        error: Error,
        reconnectGeneration: number
    ): void {
        if (this.reconnectStatus.generation !== reconnectGeneration) {
            return;
        }

        this.reconnectStatus.enabled = false;
        this.reconnectStatus.generation++;

        if (error instanceof TryWithExhaustedError) {
            this.reconnectStatus.attempts = error.context.attempt;
            this.reconnectStatus.exhausted = true;
            console.warn(
                `WebSocket reconnect exhausted after ${this.reconnectStatus.attempts} attempts for ${this.sessionId}`,
                error
            );
            return;
        }

        this.reconnectStatus.exhausted = false;
        console.warn(
            `WebSocket reconnect stopped for ${this.sessionId}`,
            error
        );
    }

    private isReconnectCurrent(reconnectGeneration: number): boolean {
        return this.reconnectStatus.generation === reconnectGeneration &&
            this.canReconnect();
    }

    private canReconnect(): boolean {
        if (!this.reconnectStatus.enabled) {
            return false;
        }

        if (this.dependencies.reconnect.canReconnect() === false) {
            this.disable();
            return false;
        }

        return true;
    }
}
