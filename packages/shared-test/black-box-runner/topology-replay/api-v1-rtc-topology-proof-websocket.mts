import { compareOverlayTopologyCausalTuple } from '@shared/api/overlay-topology.ts';
import type {
    ProofCausalRevision,
    ProofJsonObject,
    ProofJsonValue,
    ProofSession
} from './api-v1-rtc-topology-proof-api.mts';
import { requireRecord, requireSafeInteger, requireString } from './api-v1-rtc-topology-proof-api.mts';

export const RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS = 10_000;

export type ProofTopologyDeliveryKind = 'publication' | 'hydration';

export type ProofTopologyExpectation = Readonly<{
    causalRevision: ProofCausalRevision;
    causalMatch: 'exact' | 'at-least';
    version?: number;
    deliveryKind?: ProofTopologyDeliveryKind;
    messageId?: string;
}>;

export type ProofTopologyObservation = Readonly<{
    causalRevision: ProofCausalRevision;
    version: number;
    semanticJson: string;
    activeSessionIds: readonly string[];
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
    messageId: string;
    deliveryKind: ProofTopologyDeliveryKind;
}>;

export class ApiV1RtcTopologyProofSocket {
    readonly #socket: WebSocket;
    readonly #label: string;
    readonly #observations: ProofTopologyObservation[] = [];
    readonly #waiters = new Set<() => void>();
    readonly #topicCounts = new Map<string, number>();
    readonly #frameTypeCounts = new Map<string, number>();
    #failure: Error | undefined;

    private constructor(socket: WebSocket, label: string) {
        this.#socket = socket;
        this.#label = label;
        socket.addEventListener('message', (event) => this.#onMessage(event));
        socket.addEventListener('close', () => {
            this.#failure = this.#failure ?? new Error(`WebSocket ${label} closed before proof completion.`);
            this.#wakeWaiters();
        });
        socket.addEventListener('error', () => {
            this.#failure = this.#failure ?? new Error(`WebSocket ${label} failed.`);
            this.#wakeWaiters();
        });
    }

    static async open(session: ProofSession, ticket: string): Promise<ApiV1RtcTopologyProofSocket> {
        const url = `${session.wsBaseUrl}/api/ws/${encodeURIComponent(session.sessionId)}` +
            `?ticket=${encodeURIComponent(ticket)}`;
        const socket = new WebSocket(url);
        const client = new ApiV1RtcTopologyProofSocket(socket, session.label);
        await waitForOpen(socket, session.label);
        return client;
    }

    async waitForTopology(expectation: ProofTopologyExpectation): Promise<ProofTopologyObservation> {
        const deadline = Date.now() + RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS;
        while (true) {
            this.#failure && fail(this.#failure);
            const observation = this.#observations.find((candidate) =>
                matchesProofTopologyExpectation(candidate, expectation)
            );
            if (observation) {
                return observation;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(
                    `WebSocket ${this.#label} did not receive a matching topology for revision ` +
                        `${expectation.causalRevision.groupRevision}/` +
                        `${expectation.causalRevision.presenceRevision} within ` +
                        `${RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS}ms.`
                );
            }
            await this.#waitForMessage(remaining);
        }
    }

    assertNoRegressionOrDuplicateLane(): void {
        adoptProofTopologyObservations(this.#observations, this.#label);
    }

    close(): void {
        if (this.#socket.readyState === WebSocket.OPEN) {
            this.#socket.close(1000, 'rtc-topology-replay-proof-complete');
        }
    }

    readDiagnostics(): ProofJsonObject {
        return {
            label: this.#label,
            frameTypeCounts: Object.fromEntries(this.#frameTypeCounts),
            topicCounts: Object.fromEntries(this.#topicCounts),
            topologyTuples: this.#observations.map((observation) => ({
                ...observation.causalRevision,
                version: observation.version,
                deliveryKind: observation.deliveryKind,
                messageId: observation.messageId
            }))
        };
    }

    #onMessage(event: MessageEvent): void {
        try {
            const frameType = typeof event.data;
            this.#frameTypeCounts.set(frameType, (this.#frameTypeCounts.get(frameType) ?? 0) + 1);
            if (typeof event.data === 'string') {
                const message = requireRecord(JSON.parse(event.data), 'WebSocket message');
                const route = requireRecord(message.route, 'WebSocket route');
                if (typeof route.topicId === 'string') {
                    this.#topicCounts.set(route.topicId, (this.#topicCounts.get(route.topicId) ?? 0) + 1);
                }
            }
            const observation = decodeTopologyObservation(event.data);
            if (observation) {
                this.#observations.push(observation);
            }
        }
        catch (error) {
            this.#failure = error instanceof Error ? error : new Error(String(error));
        }
        this.#wakeWaiters();
    }

    async #waitForMessage(timeoutMs: number): Promise<void> {
        await new Promise<void>((resolve) => {
            let timeout: ReturnType<typeof setTimeout>;
            const wake = (): void => {
                clearTimeout(timeout);
                this.#waiters.delete(wake);
                resolve();
            };
            timeout = setTimeout(wake, timeoutMs);
            this.#waiters.add(wake);
        });
    }

    #wakeWaiters(): void {
        for (const wake of [...this.#waiters]) {
            wake();
        }
    }
}

function waitForOpen(socket: WebSocket, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(
                new Error(
                    `WebSocket ${label} did not open within ` +
                        `${RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS}ms.`
                )
            );
        }, RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS);
        socket.addEventListener(
            'open',
            () => {
                clearTimeout(timeout);
                resolve();
            },
            { once: true }
        );
        socket.addEventListener(
            'error',
            () => {
                clearTimeout(timeout);
                reject(new Error(`WebSocket ${label} failed during open.`));
            },
            { once: true }
        );
    });
}

export function decodeTopologyObservation(
    data: string | ArrayBuffer | Blob
): ProofTopologyObservation | undefined {
    if (typeof data !== 'string') {
        return undefined;
    }
    const message = requireRecord(JSON.parse(data), 'WebSocket message');
    const route = requireRecord(message.route, 'WebSocket route');
    if (route.topicId !== 'overlay.topology') {
        return undefined;
    }
    const payload = requireRecord(message.payload, 'WebSocket payload');
    if (payload.typeId !== 'overlay.topology') {
        return undefined;
    }
    const id = requireRecord(message.id, 'WebSocket message identity');
    const messageId = requireString(id.msgId, 'WebSocket message ID');
    const snapshot = requireRecord(
        JSON.parse(requireString(payload.resource, 'topology payload resource')),
        'topology snapshot'
    );
    const causal = requireRecord(snapshot.sourceGroupStateCausalRevision, 'topology causal revision');
    const activeSessionIds = requireStringArray(snapshot.activeSessionIds, 'active session IDs');
    const nextHops = requireRecord(snapshot.nextHopsBySessionId, 'next hops');
    return {
        causalRevision: {
            groupRevision: requireSafeInteger(causal.groupRevision, 'topology group revision'),
            presenceRevision: requireSafeInteger(causal.presenceRevision, 'topology presence revision')
        },
        version: requireSafeInteger(snapshot.version, 'topology version'),
        semanticJson: JSON.stringify(snapshot),
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(
            Object.entries(nextHops).map(([sessionId, peers]) => [
                sessionId,
                requireStringArray(peers, `next hops for ${sessionId}`)
            ])
        ),
        messageId,
        deliveryKind: readProofTopologyDeliveryKind(messageId)
    };
}

function requireStringArray(
    value: ProofJsonValue | undefined,
    label: string
): readonly string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new TypeError(`${label} must be a string array.`);
    }
    return value;
}

function assertUniqueTopologyLanes(observation: ProofTopologyObservation, label: string): void {
    const active = new Set(observation.activeSessionIds);
    if (active.size !== observation.activeSessionIds.length) {
        throw new Error(`WebSocket ${label} received duplicate active topology sessions.`);
    }
    for (const [sessionId, peers] of Object.entries(observation.nextHopsBySessionId)) {
        if (!active.has(sessionId) || new Set(peers).size !== peers.length) {
            throw new Error(`WebSocket ${label} received a duplicate or unknown RTC lane.`);
        }
        if (peers.some((peer) => peer === sessionId || !active.has(peer))) {
            throw new Error(`WebSocket ${label} received an invalid RTC lane endpoint.`);
        }
    }
}

export function adoptProofTopologyObservations(
    observations: readonly ProofTopologyObservation[],
    label = 'proof'
): readonly ProofTopologyObservation[] {
    const adopted: ProofTopologyObservation[] = [];
    for (const observation of observations) {
        assertUniqueTopologyLanes(observation, label);
        const current = adopted.at(-1);
        if (!current) {
            adopted.push(observation);
            continue;
        }
        const comparison = compareOverlayTopologyCausalTuple(
            {
                sourceGroupStateCausalRevision: observation.causalRevision,
                version: observation.version
            },
            {
                sourceGroupStateCausalRevision: current.causalRevision,
                version: current.version
            }
        );
        if (comparison === 'dominates') {
            adopted.push(observation);
            continue;
        }
        if (comparison === 'dominated') {
            continue;
        }
        if (comparison === 'equal') {
            if (observation.semanticJson !== current.semanticJson) {
                throw new Error(`WebSocket ${label} received a conflicting duplicate topology.`);
            }
            continue;
        }
        throw new Error(`WebSocket ${label} received an incomparable topology.`);
    }
    return adopted;
}

function sameRevision(left: ProofCausalRevision, right: ProofCausalRevision): boolean {
    return (
        left.groupRevision === right.groupRevision && left.presenceRevision === right.presenceRevision
    );
}

export function causallyIncludes(
    current: ProofCausalRevision,
    required: ProofCausalRevision
): boolean {
    return (
        current.groupRevision >= required.groupRevision &&
        current.presenceRevision >= required.presenceRevision
    );
}

export function matchesProofTopologyExpectation(
    observation: ProofTopologyObservation,
    expectation: ProofTopologyExpectation
): boolean {
    const causalMatches = expectation.causalMatch === 'exact'
        ? sameRevision(observation.causalRevision, expectation.causalRevision)
        : causallyIncludes(observation.causalRevision, expectation.causalRevision);
    return (
        causalMatches &&
        (expectation.version === undefined || observation.version === expectation.version) &&
        (expectation.deliveryKind === undefined ||
            observation.deliveryKind === expectation.deliveryKind) &&
        (expectation.messageId === undefined || observation.messageId === expectation.messageId)
    );
}

function readProofTopologyDeliveryKind(messageId: string): ProofTopologyDeliveryKind {
    let identity;
    try {
        identity = JSON.parse(messageId);
    }
    catch {
        throw new TypeError('Proof topology message identity is not valid JSON.');
    }
    if (!Array.isArray(identity)) {
        throw new TypeError('Proof topology message identity must be an array.');
    }
    if (identity[0] === 'rtc-topology-publication') {
        return 'publication';
    }
    if (identity[0] === 'rtc-topology-hydration') {
        return 'hydration';
    }
    throw new TypeError('Proof topology message identity has an unknown delivery kind.');
}

function fail(error: Error): never {
    throw error;
}
