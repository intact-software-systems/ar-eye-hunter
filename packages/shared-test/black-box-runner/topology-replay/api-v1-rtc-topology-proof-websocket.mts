import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { validateSerializedALMessageSize } from '@shared/al-contracts/al-message-resource-limits.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { parseAuthoritativeOverlayTopologySnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { compareOverlayTopologyCausalTuple } from '@shared/api/overlay-topology.ts';
import type { CompletedStateSnapshot } from '@shared/api/state-snapshot-page.ts';
import { StateSnapshotAssembly } from '@shared/services/state-snapshot-assembly.ts';
import type {
    ProofCausalRevision,
    ProofJsonObject,
    ProofSession
} from './api-v1-rtc-topology-proof-api.mts';

export const RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS = 10_000;

export type ProofTopologyDeliveryKind = 'publication' | 'hydration';

export interface ProofTopologyExpectation {
    readonly causalRevision: ProofCausalRevision;
    readonly causalMatch: 'exact' | 'at-least';
    readonly version?: number;
    readonly deliveryKind?: ProofTopologyDeliveryKind;
    readonly messageId?: string;
}

export interface ProofTopologyObservation {
    readonly causalRevision: ProofCausalRevision;
    readonly version: number;
    readonly semanticJson: string;
    readonly activeSessionIds: readonly string[];
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
    readonly messageId: string;
    readonly deliveryKind: ProofTopologyDeliveryKind;
}

export class ApiV1RtcTopologyProofSocket {
    readonly #socket: WebSocket;
    readonly #groupRef: GroupRef;
    readonly #assembly = new StateSnapshotAssembly();
    readonly #label: string;
    readonly #observations: ProofTopologyObservation[] = [];
    readonly #waiters = new Set<() => void>();
    readonly #topicCounts = new Map<string, number>();
    readonly #frameTypeCounts = new Map<string, number>();
    #failure: Error | undefined;

    private constructor(socket: WebSocket, label: string, groupRef: GroupRef) {
        this.#socket = socket;
        this.#groupRef = groupRef;
        this.#label = label;
        socket.addEventListener('message', (event) => this.#onMessage(event));
        socket.addEventListener('close', () => {
            this.#assembly.dispose();
            this.#failure = this.#failure ?? new Error(`WebSocket ${label} closed before proof completion.`);
            this.#wakeWaiters();
        });
        socket.addEventListener('error', () => {
            this.#assembly.dispose();
            this.#failure = this.#failure ?? new Error(`WebSocket ${label} failed.`);
            this.#wakeWaiters();
        });
    }

    static async open(session: ProofSession, ticket: string, groupRef: GroupRef): Promise<ApiV1RtcTopologyProofSocket> {
        const url = `${session.wsBaseUrl}/api/ws/${encodeURIComponent(session.sessionId)}` +
            `?ticket=${encodeURIComponent(ticket)}` +
            `&applicationId=${encodeURIComponent(groupRef.applicationId)}` +
            `&workspaceId=${encodeURIComponent(groupRef.workspaceId)}`;
        const socket = new WebSocket(url);
        const client = new ApiV1RtcTopologyProofSocket(socket, session.label, groupRef);
        await waitForOpen(socket, session.label);
        return client;
    }

    async waitForTopology(expectation: ProofTopologyExpectation): Promise<ProofTopologyObservation> {
        const deadline = Date.now() + RTC_TOPOLOGY_PROOF_ASSERTION_TIMEOUT_MS;
        while (true) {
            if (this.#failure) {
                throw this.#failure;
            }
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
        this.#assembly.dispose();
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
            if (typeof event.data !== 'string') {
                return;
            }
            const sizeIssue = validateSerializedALMessageSize(event.data)[0];
            if (sizeIssue) {
                throw new TypeError(sizeIssue.message);
            }
            const decoded = decodeALMessageValue(JSON.parse(event.data));
            if (decoded.left) {
                throw new TypeError(decoded.left.message);
            }
            const message = decoded.right!;
            const topic = message.route.topicId;
            this.#topicCounts.set(topic, (this.#topicCounts.get(topic) ?? 0) + 1);
            if (topic !== 'overlay.topology' || message.payload.typeId !== 'overlay.topology') {
                return;
            }
            const accepted = this.#assembly.accept({ message, scope: this.#groupRef, nowMs: Date.now() });
            if (accepted.left) {
                throw new TypeError(accepted.left.message);
            }
            if (accepted.right!.kind === 'complete') {
                this.#observations.push(decodeTopologyObservation(accepted.right!.snapshot, this.#groupRef));
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
    completed: CompletedStateSnapshot,
    groupRef: GroupRef
): ProofTopologyObservation {
    const snapshot = parseAuthoritativeOverlayTopologySnapshot(completed.resource, groupRef);
    const revision = snapshot.sourceGroupStateCausalRevision;
    if (
        !isSameGroupRef(snapshot.groupRef, groupRef) || completed.page.scope.kind !== 'group' ||
        completed.page.scope.resourceId !== groupRef.groupId ||
        completed.page.revision !==
            JSON.stringify([revision.groupRevision, revision.presenceRevision, snapshot.version])
    ) {
        throw new TypeError('Completed proof topology differs from its scoped page identity.');
    }
    return {
        causalRevision: revision,
        version: snapshot.version,
        semanticJson: JSON.stringify(snapshot),
        activeSessionIds: snapshot.activeSessionIds,
        nextHopsBySessionId: snapshot.nextHopsBySessionId,
        messageId: completed.page.originalMessageId,
        deliveryKind: readProofTopologyDeliveryKind(completed.page.originalMessageId)
    };
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
    let identity: unknown;
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
