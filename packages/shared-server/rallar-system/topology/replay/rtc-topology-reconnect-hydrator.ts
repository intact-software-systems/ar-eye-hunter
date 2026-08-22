import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';

import { validatePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { RtcTopologyReplayDiagnosticsSink } from './rtc-topology-replay-diagnostics.ts';
import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from './rtc-topology-replay-policy.ts';

export const RTC_TOPOLOGY_HYDRATION_PAGE_SIZE = 100;
export const RTC_TOPOLOGY_HYDRATION_RETRY_DELAYS_MS = [100, 1_000, 5_000, 30_000] as const;

interface RtcTopologyHydrationTopologyReader {
    listSnapshotEntriesPage(
        input: Readonly<{
            afterKey?: string;
            limit: number;
        }>
    ): Promise<readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[]>;
    findSnapshot(groupRef: GroupRef): Promise<RallarOverlayTopologySnapshot | undefined>;
}

interface RtcTopologyHydrationGroupReader {
    readSnapshot(groupRef: GroupRef): Promise<GroupSnapshot | undefined>;
}

export interface RtcTopologyHydrationIdentity {
    readonly principalId: string;
}

export interface RtcTopologyHydrationScheduler {
    schedule(delayMs: number, task: () => void): () => void;
    yield(): Promise<void>;
}

interface RtcTopologyReconnectHydratorOptions {
    readonly socket: JsonWebSocketServer;
    readonly topologies: RtcTopologyHydrationTopologyReader;
    readonly groups: RtcTopologyHydrationGroupReader;
    readonly readIdentity: (
        connection: ConnectionContext
    ) => RtcTopologyHydrationIdentity | undefined;
    readonly nowEpochMs: () => number;
    readonly batchWindowMs: number;
    readonly diagnostics?: RtcTopologyReplayDiagnosticsSink;
    readonly scheduler?: RtcTopologyHydrationScheduler;
}

type HydrationOutcome = 'sent' | 'unauthorized' | 'no-topology' | 'retry' | 'stale-generation';

const CALLBACK_ID = 'rtc-topology-reconnect-hydrator';

export class RtcTopologyReconnectHydrator {
    readonly #socket: JsonWebSocketServer;
    readonly #topologies: RtcTopologyHydrationTopologyReader;
    readonly #groups: RtcTopologyHydrationGroupReader;
    readonly #readIdentity: RtcTopologyReconnectHydratorOptions['readIdentity'];
    readonly #nowEpochMs: () => number;
    readonly #batchWindowMs: number;
    readonly #diagnostics: RtcTopologyReplayDiagnosticsSink | undefined;
    readonly #scheduler: RtcTopologyHydrationScheduler;
    readonly #abort = new AbortController();
    readonly #pending = new Map<ConnectionContext, number>();
    readonly #retryCancellations = new Map<ConnectionContext, () => void>();
    #batchCancellation: (() => void) | undefined;
    #inFlight: Promise<void> | undefined;
    #started = false;
    #stopped = false;

    constructor(options: RtcTopologyReconnectHydratorOptions) {
        this.#socket = options.socket;
        this.#topologies = options.topologies;
        this.#groups = options.groups;
        this.#readIdentity = options.readIdentity;
        this.#nowEpochMs = options.nowEpochMs;
        this.#batchWindowMs = options.batchWindowMs;
        this.#diagnostics = options.diagnostics;
        this.#scheduler = options.scheduler ?? defaultRtcTopologyHydrationScheduler;
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
        const retry = await this.#hydrateContexts(connections, signal);
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
        const batch = takeRtcTopologyHydrationBatch(this.#pending);
        this.#inFlight = this.#hydrateContexts([...batch.keys()], this.#abort.signal)
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
                    const pending = takeRtcTopologyHydrationBatch(this.#pending);
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

    async #hydrateContexts(
        connections: readonly ConnectionContext[],
        signal: AbortSignal
    ): Promise<ReadonlySet<ConnectionContext>> {
        const matched = new Set<ConnectionContext>();
        const retry = new Set<ConnectionContext>();
        let afterKey: string | undefined;
        while (true) {
            throwIfEitherAborted(signal, this.#abort.signal);
            let page: readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[];
            try {
                page = await this.#topologies.listSnapshotEntriesPage({
                    afterKey,
                    limit: RTC_TOPOLOGY_HYDRATION_PAGE_SIZE
                });
            }
            catch {
                throwIfEitherAborted(signal, this.#abort.signal);
                for (const connection of connections) {
                    if (this.#isCurrent(connection)) {
                        retry.add(connection);
                        this.#diagnostics?.({ kind: 'hydration', outcome: 'retry' });
                    }
                }
                break;
            }
            for (const entry of page) {
                throwIfEitherAborted(signal, this.#abort.signal);
                const candidates = connections.filter((connection) =>
                    entry.value.activeSessionIds.includes(connection.id)
                );
                for (const connection of candidates) {
                    matched.add(connection);
                    const outcome = await this.#hydrateTopology(connection, entry.value, signal);
                    this.#diagnostics?.({ kind: 'hydration', outcome });
                    if (outcome === 'retry') {
                        retry.add(connection);
                    }
                }
            }
            if (page.length < RTC_TOPOLOGY_HYDRATION_PAGE_SIZE) {
                break;
            }
            afterKey = page.at(-1)!.entry.key;
            await this.#scheduler.yield();
        }
        for (const connection of connections) {
            if (!matched.has(connection) && !retry.has(connection)) {
                const outcome: HydrationOutcome = this.#isCurrent(connection)
                    ? 'no-topology'
                    : 'stale-generation';
                this.#diagnostics?.({ kind: 'hydration', outcome });
            }
        }
        return retry;
    }

    async #hydrateTopology(
        connection: ConnectionContext,
        scannedTopology: RallarOverlayTopologySnapshot,
        signal: AbortSignal
    ): Promise<HydrationOutcome> {
        throwIfEitherAborted(signal, this.#abort.signal);
        if (!this.#isCurrent(connection)) {
            return 'stale-generation';
        }
        const identity = this.#readIdentity(connection);
        if (!identity) {
            return 'unauthorized';
        }
        try {
            const authorizationBefore = await this.#groups.readSnapshot(scannedTopology.groupRef);
            throwIfEitherAborted(signal, this.#abort.signal);
            if (!this.#isCurrent(connection)) {
                return 'stale-generation';
            }
            const currentTopology = await this.#topologies.findSnapshot(scannedTopology.groupRef);
            throwIfEitherAborted(signal, this.#abort.signal);
            const authorizationAfter = await this.#groups.readSnapshot(scannedTopology.groupRef);
            throwIfEitherAborted(signal, this.#abort.signal);
            if (!this.#isCurrent(connection)) {
                return 'stale-generation';
            }
            if (!sameCausalRevision(authorizationBefore, authorizationAfter)) {
                return 'retry';
            }
            if (
                !isAuthorized({
                    snapshot: authorizationAfter,
                    sessionId: connection.id,
                    identity,
                    nowEpochMs: this.#nowEpochMs()
                })
            ) {
                return 'unauthorized';
            }
            if (!currentTopology?.activeSessionIds.includes(connection.id)) {
                return 'no-topology';
            }
            const message = materializeRtcTopologyHydrationMessage({
                connection,
                topology: currentTopology,
                nowEpochMs: this.#nowEpochMs()
            });
            const encoded = this.#socket.encode(message);
            throwIfEitherAborted(signal, this.#abort.signal);
            if (this.#socket.trySendEncodedToContext(connection, encoded)) {
                return 'sent';
            }
            return this.#isCurrent(connection) ? 'retry' : 'stale-generation';
        }
        catch (error) {
            throwIfEitherAborted(signal, this.#abort.signal);
            return this.#isCurrent(connection) ? 'retry' : 'stale-generation';
        }
    }

    #isCurrent(connection: ConnectionContext): boolean {
        return this.#socket.connections.get(connection.id) === connection && connection.isOpen;
    }
}

export function takeRtcTopologyHydrationBatch(
    pending: Map<ConnectionContext, number>
): Map<ConnectionContext, number> {
    const batch = new Map(pending);
    pending.clear();
    return batch;
}

export function materializeRtcTopologyHydrationMessage(
    input: Readonly<{
        connection: ConnectionContext;
        topology: RallarOverlayTopologySnapshot;
        nowEpochMs: number;
    }>
): ALMessage {
    const { connection, topology, nowEpochMs } = input;
    const revision = topology.sourceGroupStateCausalRevision;
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: JSON.stringify([
                'rtc-topology-hydration',
                connection.id,
                connection.generationId,
                revision.groupRevision,
                revision.presenceRevision,
                topology.version
            ]),
            ts: connection.generationStartedAtEpochMs,
            senderId: 'rallar-server',
            sessionId: connection.id
        },
        route: {
            topicId: AppTopics.overlayTopology,
            contextId: topology.groupRef.groupId,
            resourceId: `${topology.overlayId}:${revision.groupRevision}:` +
                `${revision.presenceRevision}:${topology.version}`
        },
        constraints: {
            expiresAtMs: nowEpochMs + RTC_TOPOLOGY_REPLAY_RETENTION_MS
        },
        targets: { mode: 'unicast', toPeerId: connection.id },
        delivery: { reliability: 'best-effort', ack: 'none' },
        payload: {
            typeId: AppTopics.overlayTopology,
            contentType: 'application/json',
            resource: JSON.stringify(topology)
        },
        audit: { createdBy: 'rallar-server', createdTs: nowEpochMs }
    };
    validatePersistedALMessage(message);
    return message;
}

const defaultRtcTopologyHydrationScheduler: RtcTopologyHydrationScheduler = {
    schedule: (delayMs, task) => {
        const timer = setTimeout(task, delayMs);
        return () => clearTimeout(timer);
    },
    yield: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
};

interface IsAuthorizedInput {
    snapshot: GroupSnapshot | undefined;
    sessionId: string;
    identity: RtcTopologyHydrationIdentity;
    nowEpochMs: number;
}

function isAuthorized(input: Readonly<IsAuthorizedInput>): boolean {
    const { snapshot, sessionId, identity, nowEpochMs } = input;
    if (!snapshot || snapshot.group.status !== 'active') {
        return false;
    }
    const member = snapshot.members.find(
        (candidate) => candidate.principalId === identity.principalId
    );
    if (member?.status !== 'active') {
        return false;
    }
    const session = snapshot.activeSessions.find((candidate) => candidate.sessionId === sessionId);
    return (
        session?.status === 'active' &&
        session.principalId === identity.principalId &&
        session.expiresAtEpochMs > nowEpochMs
    );
}

function sameCausalRevision(
    left: GroupSnapshot | undefined,
    right: GroupSnapshot | undefined
): boolean {
    return (
        left?.causalRevision.groupRevision === right?.causalRevision.groupRevision &&
        left?.causalRevision.presenceRevision === right?.causalRevision.presenceRevision
    );
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason ?? new DOMException('RTC topology hydration aborted', 'AbortError');
    }
}

function throwIfEitherAborted(first: AbortSignal, second: AbortSignal): void {
    throwIfAborted(first);
    throwIfAborted(second);
}

function isAbortFromSignal(error: Error, signal: AbortSignal): boolean {
    return (
        signal.aborted &&
        (error === signal.reason || (error instanceof DOMException && error.name === 'AbortError'))
    );
}
