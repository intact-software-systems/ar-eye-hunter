import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { AL_TRACE_ID_HTTP_HEADER } from '@shared/al-contracts/trace/al-trace-id.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { parseAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { assert, assertEquals } from '@std/assert';
import type { ManagedApiServerPlan } from '../../managed-api/with-managed-api-server-plans.mts';
import {
    ApiV1RtcTopologyProofApi,
    requireRecord,
    requireString,
    type ProofJsonObject,
    type ProofSession
} from '../../topology-replay/api-v1-rtc-topology-proof-api.mts';
import { waitForProofCondition } from '../cluster-proof-socket.mts';
import { OrderingProofPostgres } from './ordering-proof-postgres.mts';
import { OrderingProofSocket } from './ordering-proof-socket.mts';

const GRANTED_FEED = 'room.bb-granted-feed';
/** The receipt retry re-judges an unacknowledged recipient after this long. */
const RECEIVER_ACK_TIMEOUT_MS = 1_000;

export namespace OrderingClusterScenario {
    export interface Input {
        readonly plans: readonly ManagedApiServerPlan[];
        readonly databaseUrl: string;
        readonly artifactDir: string;
    }
}

/**
 * The primary is the only dequeuer and holds no socket of the receivers, so a session live on another
 * instance is recorded from durable presence; a receiver that closes after its dequeue and never
 * acknowledges is judged outside by the receipt retry's durable re-check.
 */
export class OrderingClusterScenario {
    readonly #input: OrderingClusterScenario.Input;
    readonly #api = new ApiV1RtcTopologyProofApi({
        alice: { username: 'alice', password: 'secret' },
        bob: { username: 'bob', password: 'secret' },
        admin: { username: 'admin', password: 'admin' }
    });
    #phase = 'setup';
    readonly #database: OrderingProofPostgres;
    readonly #sockets: OrderingProofSocket[] = [];
    readonly #runId = crypto.randomUUID();
    readonly #scope: GroupRef = {
        applicationId: 'ordering-proof',
        workspaceId: crypto.randomUUID(),
        groupId: 'ordering-group'
    };
    readonly #scopePath = `/api/state/apps/${this.#scope.applicationId}/workspaces/${this.#scope.workspaceId}`;

    constructor(input: OrderingClusterScenario.Input) {
        this.#input = input;
        this.#database = new OrderingProofPostgres(input.databaseUrl);
    }

    async run(): Promise<void> {
        try {
            await this.#writeEvidence(await this.#runScenario());
        }
        catch (error) {
            await Deno.writeTextFile(
                `${this.#input.artifactDir}/ordering-cluster-failure.json`,
                JSON.stringify(
                    {
                        phase: this.#phase,
                        sockets: this.#sockets.map((socket) => ({
                            frameCount: socket.frames.length,
                            closeCodes: socket.closeCodes,
                            readyState: socket.socket.readyState
                        }))
                    },
                    null,
                    2
                )
            );
            throw error;
        }
        finally {
            for (const socket of this.#sockets) {
                socket.close();
            }
            await this.#database.close();
        }
    }

    async #runScenario(): Promise<ClusterEvidence> {
        const [primary, secondary, tertiary] = this.#input.plans;
        const parties = await this.#joinParties(secondary!, tertiary!);
        this.#phase = 'grants-and-subscriptions';
        await this.#grant({ owner: parties.c, grantee: parties.c, publish: true });
        await this.#grant({ owner: parties.c, grantee: parties.s, publish: false });
        for (const party of [parties.r, parties.x, parties.s]) {
            await this.#subscribe(party);
        }
        this.#phase = 'track-1-remote-receiver-entry';
        const first = await this.#assertTrack1Entry(parties);
        this.#phase = 'track-2-remote-receivers-recorded';
        const recorded = await this.#assertTrack2Recorded(parties);
        this.#phase = 'closed-receiver';
        await this.#closeReceiver(parties);
        this.#phase = 'track-2-outside-by-retry-and-omission';
        const track2 = await this.#assertTrack2Completed(parties, recorded);
        this.#phase = 'track-1-in-order-after-close';
        const secondSeq = await this.#assertTrack1InOrder(parties);
        return {
            dequeuer: primary!.port,
            receiver: secondary!.port,
            publisher: tertiary!.port,
            closedSession: parties.x.session.sessionId,
            closedAt: 'after-dequeue',
            outsideJudgedBy: 'retry',
            track1: { ...first, secondSeq },
            track2
        };
    }

    async #writeEvidence(evidence: ClusterEvidence): Promise<void> {
        await Deno.writeTextFile(
            `${this.#input.artifactDir}/ordering-cluster-proof.json`,
            JSON.stringify(
                {
                    status: 'passed',
                    queueWorkers: this.#input.plans.map((plan) => plan.env.RALLAR_API_QUEUE_WORKERS),
                    ...evidence
                },
                null,
                2
            )
        );
    }

    /** Alice's publisher `c` and Bob's `s` on the tertiary; Alice's receiver `r` and closing `x` on the secondary. */
    async #joinParties(secondary: ManagedApiServerPlan, tertiary: ManagedApiServerPlan): Promise<Parties> {
        const c = await this.#login('alice', tertiary);
        const r = await this.#login('alice', secondary);
        const x = await this.#login('alice', secondary);
        const s = await this.#login('bob', tertiary);
        await this.#createSharedGroup(c, s);
        return {
            c: await this.#join(c),
            r: await this.#join(r),
            x: await this.#join(x),
            s: await this.#join(s)
        };
    }

    async #login(principal: 'alice' | 'bob', receiver: ManagedApiServerPlan): Promise<ProofSession> {
        return await this.#api.login({
            label: `${principal}-${receiver.port}`,
            principal,
            apiBaseUrl: this.#input.plans[0]!.baseUrl,
            wsBaseUrl: receiver.baseUrl.replace(/^http/, 'ws')
        });
    }

    async #createSharedGroup(owner: ProofSession, member: ProofSession): Promise<void> {
        const group = { ...this.#scope, proofId: this.#scope.workspaceId };
        await this.#api.createGroup({ ...group, owner });
        await this.#api.activateMember({ ...group, actor: member, memberClientId: member.clientId });
    }

    async #join(session: ProofSession): Promise<Party> {
        const socket = await OrderingProofSocket.open({
            api: this.#api,
            session,
            scope: { applicationId: this.#scope.applicationId, workspaceId: this.#scope.workspaceId }
        });
        this.#sockets.push(socket);
        return { session, socket, generationId: await this.#connectRoom(session, socket) };
    }

    /** Joins the room under the socket's live generation and answers that generation. */
    async #connectRoom(session: ProofSession, socket: OrderingProofSocket): Promise<string> {
        const snapshot = await this.#readClient(session);
        const connected = snapshot.activeSessions.find((candidate) => candidate.sessionId === session.sessionId);
        assert(connected, 'Current websocket has canonical client presence');
        const requestId = this.#newRequestId();
        await this.#mutate(
            session,
            toApiMutationRequestPath(`/groups/${this.#scope.groupId}/sessions/${session.sessionId}`, requestId),
            {
                method: 'PUT',
                requestId,
                body: {
                    generationId: crypto.randomUUID(),
                    connectionGenerationId: connected.generationId,
                    publicationKey: null,
                    principalId: session.clientId
                }
            }
        );
        await socket.waitForFrame((frame) =>
            frame.route.topicId === AppTopics.groupStateEvent && frame.id.traceId === requestId
        );
        return connected.generationId;
    }

    async #grant({ owner, grantee, publish }: PublicationGrant): Promise<void> {
        const requestId = this.#newRequestId();
        const principalId = grantee.session.clientId;
        await this.#mutate(
            owner.session,
            toApiMutationRequestPath(
                `/groups/${this.#scope.groupId}/publication-grants/${principalId}/grant`,
                requestId
            ),
            {
                method: 'POST',
                requestId,
                body: { topicId: GRANTED_FEED, publish, subscribe: true }
            }
        );
    }

    async #subscribe(party: Party): Promise<void> {
        const requestId = this.#newRequestId();
        const path = toApiMutationRequestPath(
            `/groups/${this.#scope.groupId}/sessions/${party.session.sessionId}/subscribe`,
            requestId
        );
        const outcome = await this.#mutate(party.session, path, {
            method: 'POST',
            requestId,
            body: { topicId: GRANTED_FEED, connectionGenerationId: party.generationId }
        });
        assertEquals(requireString(outcome.outcome, 'subscribe outcome'), 'subscribed');
    }

    /**
     * The principal upsert on the secondary reaches, from the primary's dequeue, every live session of Alice and of her
     * full-visibility co-member Bob, wherever their sockets are.
     */
    async #assertTrack1Entry(parties: Parties): Promise<Omit<Track1Evidence, 'secondSeq'>> {
        const { c, r, x, s } = parties;
        const secondary = this.#input.plans[1]!.baseUrl;
        const requestId = await this.#upsertPrincipal({ ...c.session, apiBaseUrl: secondary }, 'ordering-1');
        const first = await this.#waitForPrincipalFrame(r, requestId);
        const firstSeq = first.ordering!.seq!;
        assert(firstSeq >= 2, `The principal track has a history before ${firstSeq}`);
        const copies = [
            { party: c, frame: await this.#waitForPrincipalFrame(c, requestId) },
            { party: r, frame: first },
            { party: x, frame: await this.#waitForPrincipalFrame(x, requestId) },
            // Bob shares the room with full visibility, so Alice's principal event addresses his session too.
            { party: s, frame: await this.#waitForPrincipalFrame(s, requestId) }
        ];
        for (const { party, frame } of copies) {
            assertInOrderOnTrack(party, frame, `${party.session.label} enters the principal track in order`);
        }
        await this.#database.waitForOutboxCompleted(first.id.msgId);
        const sentPositions = await this.#database.readSentPositions(first.id.msgId);
        assertEquals(
            sentPositions,
            Object.fromEntries(copies.map(({ party, frame }) => [party.session.sessionId, toPriorSeq(party, frame)])),
            'The record names every live session of the audience at its prior position, the remote ones and the co-member included'
        );
        return { msgId: first.id.msgId, orderingKey: first.ordering!.orderingKey!, firstSeq, sentPositions };
    }

    /** The frozen granted row records both sessions live on the secondary although the primary holds no socket of them. */
    async #assertTrack2Recorded(parties: Parties): Promise<RecordedMessage> {
        const { c, r, x } = parties;
        const msg1 = this.#newFeedMessage(c, [r, x], 1);
        c.socket.send(msg1);
        const admitted = await this.#waitForReceipt(c, msg1, 'admitted');
        assertEquals(
            [...admitted.expectedRecipientPeerIds].sort(),
            [r.session.sessionId, x.session.sessionId].sort(),
            'The admitted receipt expects both of Alice\'s receivers'
        );
        await r.socket.waitForFrame((frame) => frame.id.msgId === msg1.id.msgId);
        await x.socket.waitForFrame((frame) => frame.id.msgId === msg1.id.msgId);
        const sentPositions = await this.#database.readSentPositions(msg1.id.msgId);
        assertEquals(
            sentPositions,
            { [r.session.sessionId]: 0, [x.session.sessionId]: 0 },
            'A frozen row records the sessions live on another instance'
        );
        return { message: msg1, sentPositions };
    }

    /** `x` closes after its dequeue and never acknowledges; the close commits through AppInbox. */
    async #closeReceiver(parties: Parties): Promise<void> {
        const secondary = { ...parties.c.session, apiBaseUrl: this.#input.plans[1]!.baseUrl };
        parties.x.socket.socket.close(1000, 'ordering-proof-closed-receiver');
        await waitForProofCondition(async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            const snapshot = await this.#readClient(secondary);
            return !snapshot.activeSessions.some((session) =>
                session.sessionId === parties.x.session.sessionId && session.status === 'active'
            );
        }, 'the closed receiver is live nowhere');
    }

    async #assertTrack2Completed(parties: Parties, recorded: RecordedMessage): Promise<Track2Evidence> {
        const msg1 = recorded.message;
        const { c, r, s, x } = parties;
        const ackedAt = Date.now();
        r.socket.sendAck(msg1, r.session.sessionId);
        const complete = await this.#waitForReceipt(c, msg1, 'complete');
        const completeAfterAckMs = Date.now() - ackedAt;
        assertEquals(complete.confirmedRecipientPeerIds, [r.session.sessionId]);
        assertEquals(
            complete.outsideAudienceRecipientPeerIds,
            [x.session.sessionId],
            'The retry judges the closed session outside'
        );
        const msg2 = this.#newFeedMessage(c, [s], 2);
        c.socket.send(msg2);
        await s.socket.waitForFrame((frame) => frame.id.msgId === msg2.id.msgId);
        s.socket.sendAck(msg2, s.session.sessionId);
        const msg3 = this.#newFeedMessage(c, [r], 3);
        c.socket.send(msg3);
        const omitted = await r.socket.waitForFrame((frame) => frame.id.msgId === msg3.id.msgId);
        r.socket.sendAck(msg3, r.session.sessionId);
        assertEquals(r.socket.frames.filter((frame) => frame.id.msgId === msg2.id.msgId), []);
        assertEquals(
            omitted.ordering?.priorSeqByRecipient,
            { [r.session.sessionId]: 1 },
            'The receiver reads seq 2 as omitted'
        );
        return {
            msgIds: [msg1.id.msgId, msg2.id.msgId, msg3.id.msgId],
            sentPositions: recorded.sentPositions,
            receipt: {
                confirmed: complete.confirmedRecipientPeerIds,
                outside: complete.outsideAudienceRecipientPeerIds,
                receiverAckTimeoutMs: RECEIVER_ACK_TIMEOUT_MS,
                completeAfterAckMs
            }
        };
    }

    /** After the close settled, r's next frame on the principal track follows the frame it last received there. */
    async #assertTrack1InOrder(parties: Parties): Promise<number> {
        const { c, r } = parties;
        const requestId = await this.#upsertPrincipal(c.session, 'ordering-2');
        const next = await this.#waitForPrincipalFrame(r, requestId);
        assertInOrderOnTrack(r, next, 'The remote receiver reads the next frame in order, never a gap');
        return next.ordering!.seq!;
    }

    async #waitForPrincipalFrame(party: Party, requestId: string): Promise<ALMessage> {
        return await party.socket.waitForFrame((frame) =>
            frame.id.traceId === requestId && frame.ordering !== undefined
        );
    }

    /** The receipt never times out: the wait ends at the message's 30 s deadline at the latest. */
    async #waitForReceipt(
        origin: Party,
        message: ALMessage,
        phase: 'admitted' | 'complete'
    ): Promise<ALReceiptPayload> {
        const read = () => origin.socket.receipts().filter((receipt) => receipt.msgId === message.id.msgId);
        await waitForProofCondition(
            () => {
                assertEquals(read().filter((receipt) => receipt.phase === 'timed-out'), []);
                return read().some((receipt) => receipt.phase === phase);
            },
            `the ${phase} receipt of ${message.id.msgId}`,
            30_000
        );
        return read().find((receipt) => receipt.phase === phase)!;
    }

    #newFeedMessage(origin: Party, recipients: readonly Party[], seq: number): ALMessage {
        const route = newALEventRoute(GRANTED_FEED, this.#scope.groupId, `ord-${seq}-${this.#runId}`);
        return newALBroadcastMessage(origin.session.sessionId, route, 'room', 'feed.v1', {}, {
            groupRef: this.#scope,
            recipientPeerIds: recipients.map((party) => party.session.sessionId),
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: 30_000,
            qos: { ack: { algo: 'receiver', opts: { timeoutMs: RECEIVER_ACK_TIMEOUT_MS } } },
            traceId: `ordering-proof-trace-${seq}-${this.#runId}`,
            ordering: { orderingKey: 'ordering-proof', epoch: 1, seq }
        });
    }

    async #upsertPrincipal(session: ProofSession, displayName: string): Promise<string> {
        const requestId = this.#newRequestId();
        await this.#mutate(session, toApiMutationRequestPath(`/clients/${session.clientId}/principal`, requestId), {
            method: 'PUT',
            requestId,
            body: { username: session.principal, displayName }
        });
        return requestId;
    }

    async #readClient(session: ProofSession): Promise<ClientSnapshot> {
        const response = await fetch(`${session.apiBaseUrl}${this.#scopePath}/clients/${session.clientId}`, {
            headers: toAuthHeaders(session)
        });
        assertEquals(response.status, 200);
        return parseAuthoritativeClientSnapshot(await response.text(), this.#scope);
    }

    async #mutate(session: ProofSession, path: string, request: MutationRequest): Promise<ProofJsonObject> {
        const response = await fetch(`${session.apiBaseUrl}${this.#scopePath}${path}`, {
            method: request.method,
            headers: {
                ...toAuthHeaders(session),
                'Content-Type': 'application/json',
                [AL_TRACE_ID_HTTP_HEADER]: request.requestId
            },
            body: JSON.stringify(request.body)
        });
        const body = await response.text();
        assertEquals(response.status, 200, `${request.method} ${path} applies through AppInbox: ${body}`);
        return requireRecord(JSON.parse(body), `${request.method} ${path} response`);
    }

    #newRequestId(): string {
        return `ordering-proof-${crypto.randomUUID()}`;
    }
}

interface Party {
    readonly session: ProofSession;
    readonly socket: OrderingProofSocket;
    /** The socket's live connection generation the room presence and the subscription assert. */
    readonly generationId: string;
}

/** The owner grants the grantee the granted feed: always to subscribe, and to publish only when asked. */
interface PublicationGrant {
    readonly owner: Party;
    readonly grantee: Party;
    readonly publish: boolean;
}

interface Parties {
    readonly c: Party;
    readonly r: Party;
    readonly x: Party;
    readonly s: Party;
}

interface MutationRequest {
    readonly method: 'POST' | 'PUT';
    readonly requestId: string;
    readonly body: object;
}

interface RecordedMessage {
    readonly message: ALMessage;
    readonly sentPositions: Readonly<Record<string, number>> | null;
}

interface Track1Evidence {
    readonly msgId: string;
    readonly orderingKey: string;
    readonly firstSeq: number;
    readonly secondSeq: number;
    readonly sentPositions: Readonly<Record<string, number>> | null;
}

interface Track2Evidence {
    readonly msgIds: readonly string[];
    readonly sentPositions: Readonly<Record<string, number>> | null;
    readonly receipt: {
        readonly confirmed: readonly string[];
        readonly outside: readonly string[];
        readonly receiverAckTimeoutMs: number;
        readonly completeAfterAckMs: number;
    };
}

interface ClusterEvidence {
    readonly dequeuer: number;
    readonly receiver: number;
    readonly publisher: number;
    readonly closedSession: string;
    readonly closedAt: 'after-dequeue';
    readonly outsideJudgedBy: 'retry';
    readonly track1: Track1Evidence;
    readonly track2: Track2Evidence;
}

/**
 * The receiver's prior for this frame — listed, or `seq - 1` when omitted — is the sequence of the frame it
 * last received on the same track, `0` before its first: it reads the frame in order, never a gap.
 */
function assertInOrderOnTrack(party: Party, frame: ALMessage, message: string): void {
    const ordering = frame.ordering!;
    assert(ordering.priorSeqByRecipient !== undefined, 'An authority recorded this copy');
    const track = party.socket.frames.filter((candidate) =>
        candidate.ordering?.orderingKey === ordering.orderingKey && candidate.ordering?.epoch === ordering.epoch
    );
    const previous = track[track.indexOf(frame) - 1];
    assertEquals(toPriorSeq(party, frame), previous?.ordering?.seq ?? 0, message);
}

/** The prior a receiver reads: the listed one, or `seq - 1` when the record omits it. */
function toPriorSeq(party: Party, frame: ALMessage): number {
    return frame.ordering!.priorSeqByRecipient?.[party.session.sessionId] ?? frame.ordering!.seq! - 1;
}

function toAuthHeaders(session: ProofSession): Record<string, string> {
    return { Authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId };
}
