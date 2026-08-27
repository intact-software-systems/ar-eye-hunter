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
        /** The accepted slot: hydration pins to it whenever it exists (plan slice 4c). */
        readonly acceptedTopologies: TopologyReader;
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
    readonly #acceptedTopologies: RtcTopologyReconnectHydration.TopologyReader;
    readonly #groups: RtcTopologyReconnectHydration.GroupReader;
    readonly #readIdentity: RtcTopologyReconnectHydration.Dependencies['readIdentity'];
    readonly #nowEpochMs: () => number;
    readonly #diagnostics: RtcTopologyReplayDiagnosticsSink | undefined;
    readonly #yield: () => Promise<void>;

    constructor(dependencies: RtcTopologyReconnectHydration.Dependencies) {
        this.#socket = dependencies.socket;
        this.#topologies = dependencies.topologies;
        this.#acceptedTopologies = dependencies.acceptedTopologies;
        this.#groups = dependencies.groups;
        this.#readIdentity = dependencies.readIdentity;
        this.#nowEpochMs = dependencies.nowEpochMs;
        this.#diagnostics = dependencies.diagnostics;
        this.#yield = dependencies.yield;
    }

    /**
     * Both slots are scanned (plan slice 4c): the planned namespace names
     * every dialing member — a connecting group has no accepted row — while
     * the accepted namespace names members the traffic layout still carries
     * after a replan moved the planned row past them. Delivery itself always
     * chooses accepted-first, so the two scans agree on content and the pair
     * set only dedupes work.
     */
    async hydrate(input: RtcTopologyReconnectHydration.Input): Promise<ReadonlySet<ConnectionContext>> {
        const state: HydrationScanState = {
            matched: new Set<ConnectionContext>(),
            retry: new Set<ConnectionContext>(),
            hydratedPairs: new Set<string>()
        };
        await this.#scanTopologyPages(this.#topologies, input, state);
        await this.#scanTopologyPages(this.#acceptedTopologies, input, state);
        this.#recordUnmatched(input.connections, state.matched, state.retry);
        return state.retry;
    }

    async #scanTopologyPages(
        reader: RtcTopologyReconnectHydration.TopologyReader,
        input: RtcTopologyReconnectHydration.Input,
        state: HydrationScanState
    ): Promise<void> {
        let afterKey: string | undefined;
        while (true) {
            throwIfAborted(input);
            let page: readonly RuntimeStateEntryValue<RallarOverlayTopologySnapshot>[];
            try {
                page = await reader.listSnapshotEntriesPage({
                    afterKey,
                    limit: RTC_TOPOLOGY_HYDRATION_PAGE_SIZE
                });
            }
            catch {
                throwIfAborted(input);
                this.#recordScanRetries(input.connections, state.retry);
                return;
            }
            for (const entry of page) {
                throwIfAborted(input);
                await this.#hydrateScannedTopology(entry.value, input, state);
            }
            if (page.length < RTC_TOPOLOGY_HYDRATION_PAGE_SIZE) {
                return;
            }
            afterKey = page.at(-1)!.entry.key;
            await this.#yield();
        }
    }

    async #hydrateScannedTopology(
        scannedTopology: RallarOverlayTopologySnapshot,
        input: RtcTopologyReconnectHydration.Input,
        state: HydrationScanState
    ): Promise<void> {
        const candidates = input.connections.filter((connection) =>
            scannedTopology.activeSessionIds.includes(connection.id)
        );
        for (const connection of candidates) {
            const pair = `${scannedTopology.overlayId}\u0000${connection.id}`;
            if (state.hydratedPairs.has(pair)) {
                continue;
            }
            state.matched.add(connection);
            const outcome = await this.#hydrateTopology(connection, scannedTopology, input);
            this.#diagnostics?.({ kind: 'hydration', outcome });
            if (outcome === 'retry') {
                state.retry.add(connection);
                continue;
            }
            state.hydratedPairs.add(pair);
        }
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
            // Hydration content is accepted-first: the layout carrying
            // traffic when it exists, the planned row only before a first
            // promotion (product decisions 1/30).
            const [acceptedTopology, plannedTopology] = await Promise.all([
                this.#acceptedTopologies.findSnapshot(scannedTopology.groupRef),
                this.#topologies.findSnapshot(scannedTopology.groupRef)
            ]);
            const currentTopology = acceptedTopology ?? plannedTopology;
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

interface HydrationScanState {
    readonly matched: Set<ConnectionContext>;
    readonly retry: Set<ConnectionContext>;
    readonly hydratedPairs: Set<string>;
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
