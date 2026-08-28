import type { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import type { RtcTopologyReplayDiagnosticsSink } from '../consumer/rtc-topology-replay-diagnostics.ts';
import {
    defaultRtcTopologyHydrationScheduler,
    RTC_TOPOLOGY_HYDRATION_RETRY_DELAYS_MS,
    type RtcTopologyHydrationScheduler
} from './rtc-topology-hydration-scheduler.ts';
import {
    RtcTopologyReconnectHydration,
    type RtcTopologyHydrationIdentity
} from './rtc-topology-reconnect-hydration.ts';

const CALLBACK_ID = 'rtc-topology-reconnect-hydrator';

export namespace RtcTopologyReconnectHydrator {
    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly topologies: RtcTopologyReconnectHydration.TopologyReader;
        readonly acceptedTopologies: RtcTopologyReconnectHydration.TopologyReader;
        readonly groups: RtcTopologyReconnectHydration.GroupReader;
        readonly readIdentity: (
            connection: ConnectionContext
        ) => RtcTopologyHydrationIdentity | undefined;
        readonly nowEpochMs: () => number;
        readonly batchWindowMs: number;
        readonly diagnostics?: RtcTopologyReplayDiagnosticsSink;
        readonly scheduler?: RtcTopologyHydrationScheduler;
    }
}

export class RtcTopologyReconnectHydrator {
    readonly #socket: JsonWebSocketServer;
    readonly #batchWindowMs: number;
    readonly #scheduler: RtcTopologyHydrationScheduler;
    readonly #hydration: RtcTopologyReconnectHydration;
    readonly #abort = new AbortController();
    readonly #pending = new Map<ConnectionContext, number>();
    readonly #retryCancellations = new Map<ConnectionContext, () => void>();
    #batchCancellation: (() => void) | undefined;
    #inFlight: Promise<void> | undefined;
    #started = false;
    #stopped = false;

    constructor(dependencies: RtcTopologyReconnectHydrator.Dependencies) {
        this.#socket = dependencies.socket;
        this.#batchWindowMs = dependencies.batchWindowMs;
        this.#scheduler = dependencies.scheduler ?? defaultRtcTopologyHydrationScheduler;
        this.#hydration = new RtcTopologyReconnectHydration({
            socket: dependencies.socket,
            topologies: dependencies.topologies,
            acceptedTopologies: dependencies.acceptedTopologies,
            groups: dependencies.groups,
            readIdentity: dependencies.readIdentity,
            nowEpochMs: dependencies.nowEpochMs,
            diagnostics: dependencies.diagnostics,
            yield: () => this.#scheduler.yield()
        });
    }

    start(): void {
        if (this.#started) {
            return;
        }
        if (this.#stopped) {
            throw new Error('RTC topology reconnect hydrator is stopped');
        }
        this.#started = true;
        this.#socket.onWebsocketCallbacksDo(CALLBACK_ID, {
            onConnection: (connection) => this.#enqueue(connection, 0),
            onClose: (connection) => this.#cancelConnection(connection)
        });
    }

    async hydrateOpenConnections(signal: AbortSignal): Promise<void> {
        throwIfAborted(signal);
        const connections = [...this.#socket.connections.values()].filter(
            (connection) => connection.isOpen
        );
        const retry = await this.#hydration.hydrate({
            connections,
            requestSignal: signal,
            lifecycleSignal: this.#abort.signal
        });
        if (retry.size > 0) {
            throw new Error('RTC topology current-state hydration requires retry');
        }
    }

    async whenIdle(): Promise<void> {
        await this.#inFlight;
    }

    async stop(): Promise<void> {
        if (!this.#stopped) {
            this.#stopped = true;
            this.#abort.abort();
            this.#batchCancellation?.();
            this.#batchCancellation = undefined;
            for (const cancel of this.#retryCancellations.values()) {
                cancel();
            }
            this.#retryCancellations.clear();
            this.#pending.clear();
            if (this.#started) {
                this.#socket.removeWebsocketCallbackById(CALLBACK_ID);
            }
        }
        await this.whenIdle();
    }

    #enqueue(connection: ConnectionContext, attempt: number): void {
        if (this.#stopped || !this.#isCurrent(connection)) {
            return;
        }
        this.#pending.set(connection, attempt);
        if (this.#batchCancellation) {
            return;
        }
        this.#batchCancellation = this.#scheduler.schedule(
            this.#batchWindowMs,
            () => {
                this.#batchCancellation = undefined;
                this.#flushPending();
            }
        );
    }

    #flushPending(): void {
        if (this.#stopped || this.#inFlight) {
            return;
        }
        const batch = takePendingHydrations(this.#pending);
        this.#inFlight = this.#hydration.hydrate({
            connections: [...batch.keys()],
            requestSignal: this.#abort.signal,
            lifecycleSignal: this.#abort.signal
        })
            .then((retry) => {
                for (const connection of retry) {
                    this.#scheduleRetry(connection, (batch.get(connection) ?? 0) + 1);
                }
            })
            .catch((error) => {
                const failure = error instanceof Error ? error : new Error(String(error));
                if (!isAbortFromSignal(failure, this.#abort.signal)) {
                    throw error;
                }
            })
            .finally(() => {
                this.#inFlight = undefined;
                if (this.#pending.size > 0 && !this.#stopped) {
                    const pending = takePendingHydrations(this.#pending);
                    for (const [connection, attempt] of pending) {
                        this.#enqueue(connection, attempt);
                    }
                }
            });
    }

    #scheduleRetry(connection: ConnectionContext, attempt: number): void {
        if (this.#stopped || !this.#isCurrent(connection)) {
            return;
        }
        const index = Math.min(attempt - 1, RTC_TOPOLOGY_HYDRATION_RETRY_DELAYS_MS.length - 1);
        const cancel = this.#scheduler.schedule(RTC_TOPOLOGY_HYDRATION_RETRY_DELAYS_MS[index]!, () => {
            this.#retryCancellations.delete(connection);
            this.#enqueue(connection, attempt);
        });
        this.#retryCancellations.get(connection)?.();
        this.#retryCancellations.set(connection, cancel);
    }

    #cancelConnection(connection: ConnectionContext): void {
        this.#pending.delete(connection);
        this.#retryCancellations.get(connection)?.();
        this.#retryCancellations.delete(connection);
    }

    #isCurrent(connection: ConnectionContext): boolean {
        return this.#socket.connections.get(connection.id) === connection && connection.isOpen;
    }
}

function takePendingHydrations(
    pending: Map<ConnectionContext, number>
): Map<ConnectionContext, number> {
    const batch = new Map(pending);
    pending.clear();
    return batch;
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason ?? new DOMException('RTC topology hydration aborted', 'AbortError');
    }
}

function isAbortFromSignal(error: Error, signal: AbortSignal): boolean {
    return (
        signal.aborted &&
        (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError'))
    );
}
