import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import type {
    RtcTopologyReplayDiagnosticsSink,
    RtcTopologyReplayHydrationOutcome
} from '../consumer/rtc-topology-replay-diagnostics.ts';
import { materializeRtcTopologyHydrationMessage } from './rtc-topology-hydration-message.ts';

export const RTC_TOPOLOGY_HYDRATION_PAGE_SIZE = 100;

export interface RtcTopologyHydrationIdentity {
    readonly principalId: string;
}

export namespace RtcTopologyReconnectHydration {
    export interface TopologyReader {
        listSnapshotEntriesPage(
            input: Readonly<{
                afterKey?: string;
                limit: number;
            }>
        ): Promise<readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[]>;
        findSnapshot(groupRef: GroupRef): Promise<RallarOverlayTopologySnapshot | undefined>;
    }

    export interface GroupReader {
        readSnapshot(groupRef: GroupRef): Promise<GroupSnapshot | undefined>;
    }

    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly topologies: TopologyReader;
        readonly groups: GroupReader;
        readonly readIdentity: (
            connection: ConnectionContext
        ) => RtcTopologyHydrationIdentity | undefined;
        readonly nowEpochMs: () => number;
        readonly diagnostics?: RtcTopologyReplayDiagnosticsSink;
        readonly yield: () => Promise<void>;
    }

    export interface Input {
        readonly connections: readonly ConnectionContext[];
        readonly requestSignal: AbortSignal;
        readonly lifecycleSignal: AbortSignal;
    }
}

export class RtcTopologyReconnectHydration {
    readonly #socket: JsonWebSocketServer;
    readonly #topologies: RtcTopologyReconnectHydration.TopologyReader;
    readonly #groups: RtcTopologyReconnectHydration.GroupReader;
    readonly #readIdentity: RtcTopologyReconnectHydration.Dependencies['readIdentity'];
    readonly #nowEpochMs: () => number;
    readonly #diagnostics: RtcTopologyReplayDiagnosticsSink | undefined;
    readonly #yield: () => Promise<void>;

    constructor(dependencies: RtcTopologyReconnectHydration.Dependencies) {
        this.#socket = dependencies.socket;
        this.#topologies = dependencies.topologies;
        this.#groups = dependencies.groups;
        this.#readIdentity = dependencies.readIdentity;
        this.#nowEpochMs = dependencies.nowEpochMs;
        this.#diagnostics = dependencies.diagnostics;
        this.#yield = dependencies.yield;
    }

    async hydrate(input: RtcTopologyReconnectHydration.Input): Promise<ReadonlySet<ConnectionContext>> {
        const matched = new Set<ConnectionContext>();
        const retry = new Set<ConnectionContext>();
        let afterKey: string | undefined;
        while (true) {
            throwIfAborted(input);
            let page: readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[];
            try {
                page = await this.#topologies.listSnapshotEntriesPage({
                    afterKey,
                    limit: RTC_TOPOLOGY_HYDRATION_PAGE_SIZE
                });
            }
            catch {
                throwIfAborted(input);
                this.#recordScanRetries(input.connections, retry);
                break;
            }
            for (const entry of page) {
                throwIfAborted(input);
                const candidates = input.connections.filter((connection) =>
                    entry.value.activeSessionIds.includes(connection.id)
                );
                for (const connection of candidates) {
                    matched.add(connection);
                    const outcome = await this.#hydrateTopology(connection, entry.value, input);
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
            await this.#yield();
        }
        this.#recordUnmatched(input.connections, matched, retry);
        return retry;
    }

    #recordScanRetries(
        connections: readonly ConnectionContext[],
        retry: Set<ConnectionContext>
    ): void {
        for (const connection of connections) {
            if (this.#isCurrent(connection)) {
                retry.add(connection);
                this.#diagnostics?.({ kind: 'hydration', outcome: 'retry' });
            }
        }
    }

    #recordUnmatched(
        connections: readonly ConnectionContext[],
        matched: ReadonlySet<ConnectionContext>,
        retry: ReadonlySet<ConnectionContext>
    ): void {
        for (const connection of connections) {
            if (!matched.has(connection) && !retry.has(connection)) {
                const outcome: RtcTopologyReplayHydrationOutcome = this.#isCurrent(connection)
                    ? 'no-topology'
                    : 'stale-generation';
                this.#diagnostics?.({ kind: 'hydration', outcome });
            }
        }
    }

    async #hydrateTopology(
        connection: ConnectionContext,
        scannedTopology: RallarOverlayTopologySnapshot,
        input: RtcTopologyReconnectHydration.Input
    ): Promise<RtcTopologyReplayHydrationOutcome> {
        throwIfAborted(input);
        if (!this.#isCurrent(connection)) {
            return 'stale-generation';
        }
        const identity = this.#readIdentity(connection);
        if (!identity) {
            return 'unauthorized';
        }
        try {
            const authorizationBefore = await this.#groups.readSnapshot(scannedTopology.groupRef);
            throwIfAborted(input);
            if (!this.#isCurrent(connection)) {
                return 'stale-generation';
            }
            const currentTopology = await this.#topologies.findSnapshot(scannedTopology.groupRef);
            throwIfAborted(input);
            const authorizationAfter = await this.#groups.readSnapshot(scannedTopology.groupRef);
            throwIfAborted(input);
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
            throwIfAborted(input);
            if (this.#socket.trySendEncodedToContext(connection, encoded)) {
                return 'sent';
            }
            return this.#isCurrent(connection) ? 'retry' : 'stale-generation';
        }
        catch {
            throwIfAborted(input);
            return this.#isCurrent(connection) ? 'retry' : 'stale-generation';
        }
    }

    #isCurrent(connection: ConnectionContext): boolean {
        return this.#socket.connections.get(connection.id) === connection && connection.isOpen;
    }
}

interface IsAuthorizedInput {
    readonly snapshot: GroupSnapshot | undefined;
    readonly sessionId: string;
    readonly identity: RtcTopologyHydrationIdentity;
    readonly nowEpochMs: number;
}

function isAuthorized(input: IsAuthorizedInput): boolean {
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

function throwIfAborted(input: RtcTopologyReconnectHydration.Input): void {
    for (const signal of [input.requestSignal, input.lifecycleSignal]) {
        if (signal.aborted) {
            throw signal.reason ?? new DOMException('RTC topology hydration aborted', 'AbortError');
        }
    }
}
