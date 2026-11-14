import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling, resolveALMessageExpireAtMs, type ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    SERVED_REPLACED_LAYOUT_OVERLAP_MS,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/**
 * During the overlap after a layout promotion, a frame travels over the accepted layout's edges and the replaced
 * layout's open edges at once, so one peer can be reached by two parents and the union of two trees can hold a cycle.
 * These tests pin what a peer delivers, forwards, answers and refuses when that happens.
 */

type SessionNextHops = Readonly<Record<string, readonly string[]>>;

interface OverlapMeshInput {
    /** The origin `a` first; the order of the others is the order the exchange carries their frames in. */
    readonly sessionIds: readonly string[];
    readonly previousTree: SessionNextHops;
    readonly promotedTree: SessionNextHops;
}

/** The origin `a` and a relay pipeline for every other session, each holding its edges of both layouts open. */
interface OverlapMesh {
    readonly origin: RtcOriginOverlayFixture;
    readonly peers: ReadonlyMap<string, RtcRelayOverlayFixture>;
    readonly edges: ReadonlyMap<string, readonly string[]>;
    /** How many frames of each directed edge the exchange already carried. */
    readonly carriedCounts: Map<string, number>;
}

interface TransportCopy {
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly message: ALMessage;
}

interface PositionFrameInput {
    readonly resourceId: string;
    /** Absent, the frame names no ordering track. */
    readonly seq?: number;
    readonly qos?: ALQosPolicyRequest;
}

interface RelayedCopies {
    /** The copy of `frame` the previous parent `b` relayed to `d`. */
    previous(frame: ALMessage): ALMessage;
    /** The copy of `frame` the promoted parent `c` relayed to `d`. */
    promoted(frame: ALMessage): ALMessage;
}

/** One frame the origin sent through `b`: the elapsed time around the send and the copies `b` relayed to `c`. */
interface TailSend {
    readonly sentFromMs: number;
    readonly sentUntilMs: number;
    readonly copies: number;
}

interface OriginFanoutLayouts {
    readonly acceptedPeerIds: readonly string[];
    /** Absent, no replaced layout is in force. */
    readonly replacedPeerIds: readonly string[] | undefined;
    /** The neighbours whose edge is open now. */
    readonly readyPeerIds: readonly string[];
}

/** A chain whose child `c` has promoted; `promoteRelay` promotes its previous parent `b`. */
interface ChainTail {
    readonly origin: RtcOriginOverlayFixture;
    readonly child: RtcRelayOverlayFixture;
    readonly relay: RtcRelayOverlayFixture;
    promoteRelay(): void;
}

interface FrozenOverlapShape extends OverlapMeshInput {
    readonly shape: string;
    readonly recipientPeerIds: readonly string[];
    /** Absent, the frame requests no QoS. */
    readonly qos?: ALQosPolicyRequest;
    /** Every edge the frame crosses, sorted. */
    readonly edges: readonly string[];
}

/** What the transport does to each copy it carries: the copy that arrives, and how long it travels. */
interface ExchangeTransit {
    toCarried(message: ALMessage): ALMessage;
    readonly delayMs: number;
}

const DIRECT_TRANSIT: ExchangeTransit = { toCarried: (message) => message, delayMs: 0 };

/** Every copy one exchange may carry before the test fails: a loop that does not stop exceeds it. */
const EXCHANGE_COPY_BUDGET = 60;

const ACK_TIMEOUT_MS = 2_000;

/** The re-plan keeps the causal revision the fixture's layout was planned from: only the layout version moves. */
const PROMOTED_LAYOUT_IDENTITY = { groupRevision: 1, presenceRevision: 1, version: 2, state: 'active' } as const;

/** `d` has two parents during the overlap: `b` in the replaced layout, `c` in the promoted one; `e` hangs below `d`. */
const DIAMOND_PREVIOUS: SessionNextHops = { a: ['b', 'c'], b: ['a', 'd'], c: ['a'], d: ['b', 'e'], e: ['d'] };
const DIAMOND_PROMOTED: SessionNextHops = { a: ['b', 'c'], b: ['a'], c: ['a', 'd'], d: ['c', 'e'], e: ['d'] };
const DIAMOND_SESSION_IDS = ['a', 'b', 'c', 'd', 'e'];

/** The chain `a`, `b`, `c`, `d` re-planned to `a`, `c`, `d`, `b`. */
const CHAIN_PREVIOUS: SessionNextHops = { a: ['b'], b: ['a', 'c'], c: ['b', 'd'], d: ['c'] };
const CHAIN_PROMOTED: SessionNextHops = { a: ['c'], b: ['d'], c: ['a', 'd'], d: ['b', 'c'] };

/** The subtree `d`, `e` moves from below `b` to below `c`. */
const MOVED_SUBTREE_PREVIOUS: SessionNextHops = { a: ['b', 'c'], b: ['a', 'd', 'e'], c: ['a'], d: ['b'], e: ['b'] };
const MOVED_SUBTREE_PROMOTED: SessionNextHops = { a: ['b', 'c'], b: ['a'], c: ['a', 'd', 'e'], d: ['c'], e: ['c'] };

/** The union of the two layouts holds the cycle `b`, `c`, `d`: `b`-`c` is replaced, `b`-`d` is promoted. */
const CYCLE_PREVIOUS: SessionNextHops = { a: ['b'], b: ['a', 'c'], c: ['b', 'd'], d: ['c'] };
const CYCLE_PROMOTED: SessionNextHops = { a: ['b'], b: ['a', 'd'], c: ['d'], d: ['b', 'c'] };

/** The chain `a,b,c,d,e` re-planned to `a,b,e,d,c`: the union holds the square `b`, `c`, `d`, `e`. */
const SQUARE_PREVIOUS: SessionNextHops = { a: ['b'], b: ['a', 'c'], c: ['b', 'd'], d: ['c', 'e'], e: ['d'] };
const SQUARE_PROMOTED: SessionNextHops = { a: ['b'], b: ['a', 'e'], c: ['d'], d: ['c', 'e'], e: ['b', 'd'] };

/** A visited list already at its cap of 64 with sessions that left: every id a relay appends past it falls away. */
const VISITED_AT_CAP = Array.from({ length: 64 }, (_, index) => `left-${index}`);

function toPromotedSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
    return { ...snapshot, group: { ...snapshot.group, acceptedLayoutIdentity: PROMOTED_LAYOUT_IDENTITY } };
}

function toPromotedOverlay(tree: SessionNextHops, sessionId: string): OverlayInfo {
    return { ...createOriginOverlay(tree[sessionId] ?? [], tree), overlayVersion: PROMOTED_LAYOUT_IDENTITY.version };
}

function toOpenEdgePeerIds(input: OverlapMeshInput, sessionId: string): readonly string[] {
    return [...new Set([...(input.previousTree[sessionId] ?? []), ...(input.promotedTree[sessionId] ?? [])])];
}

/** Every session promotes the re-planned layout at the same instant, now. */
function createOverlapMesh(input: OverlapMeshInput): OverlapMesh {
    const snapshot = createOriginSnapshot(input.sessionIds, 4);
    const origin = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: input.previousTree.a ?? [],
        nextHopsBySessionId: input.previousTree
    });
    origin.groups.accept('room', toPromotedSnapshot(snapshot));
    origin.acceptOverlay(toPromotedOverlay(input.promotedTree, 'a'));
    origin.ready.peerIds = toOpenEdgePeerIds(input, 'a');
    const edges = new Map<string, readonly string[]>([['a', toOpenEdgePeerIds(input, 'a')]]);
    const peers = new Map<string, RtcRelayOverlayFixture>();
    for (const sessionId of input.sessionIds.filter((peerId) => peerId !== 'a')) {
        const neighbourPeerIds = toOpenEdgePeerIds(input, sessionId);
        const initialOverlay = createOriginOverlay(input.previousTree[sessionId] ?? [], input.previousTree);
        const peer = createRtcRelayOverlayFixture({ selfPeerId: sessionId, snapshot, neighbourPeerIds, initialOverlay });
        peer.acceptSnapshot(toPromotedSnapshot(snapshot));
        peer.acceptOverlay(toPromotedOverlay(input.promotedTree, sessionId));
        peers.set(sessionId, peer);
        edges.set(sessionId, neighbourPeerIds);
    }
    return { origin, peers, edges, carriedCounts: new Map() };
}

/**
 * Carries every new frame over every open edge, in the order of the mesh's sessions, until no edge has one. A frame
 * that reaches the origin is a control it accepts, or a copy it only records. More than the budget fails the test.
 */
async function exchangeUntilQuiet(mesh: OverlapMesh, transit: ExchangeTransit = DIRECT_TRANSIT): Promise<readonly TransportCopy[]> {
    const carried: TransportCopy[] = [];
    for (let moved = true; moved;) {
        moved = false;
        for (const [fromPeerId, toPeerIds] of mesh.edges) {
            for (const toPeerId of toPeerIds) {
                const key = `${fromPeerId}>${toPeerId}`;
                const sent = await readEdge(mesh, fromPeerId, toPeerId);
                const fresh = sent.slice(mesh.carriedCounts.get(key) ?? 0);
                mesh.carriedCounts.set(key, sent.length);
                for (const sentMessage of fresh) {
                    const message = transit.toCarried(sentMessage);
                    carried.push({ fromPeerId, toPeerId, message });
                    expect(carried.length, 'the exchange stops within its copy budget')
                        .toBeLessThanOrEqual(EXCHANGE_COPY_BUDGET);
                    if (transit.delayMs > 0) {
                        await vi.advanceTimersByTimeAsync(transit.delayMs);
                    }
                    await carry(mesh, { fromPeerId, toPeerId, message });
                    moved = true;
                }
            }
        }
    }
    return carried;
}

async function readEdge(mesh: OverlapMesh, fromPeerId: string, toPeerId: string): Promise<readonly ALMessage[]> {
    return fromPeerId === 'a'
        ? mesh.origin.channels[toPeerId]?.sent ?? []
        : await mesh.peers.get(fromPeerId)!.readSent(toPeerId);
}

async function carry(mesh: OverlapMesh, copy: TransportCopy): Promise<void> {
    if (copy.toPeerId !== 'a') {
        await mesh.peers.get(copy.toPeerId)!.receive(copy.message, copy.fromPeerId);
        return;
    }
    if (parseALControlMessage(copy.message) !== undefined) {
        await mesh.origin.manager.acceptControlMessage(copy.message);
    }
}

/** The edges `message` itself crossed, in carrying order. */
function readDataEdges(carried: readonly TransportCopy[], message: ALMessage): readonly string[] {
    return carried
        .filter((copy) => copy.message.id.msgId === message.id.msgId)
        .map((copy) => `${copy.fromPeerId}>${copy.toPeerId}`);
}

/** Each control as its edge, its type, and for an ACK the recipient it speaks for and its status. */
function readControlEdges(carried: readonly TransportCopy[]): readonly string[] {
    return carried.flatMap((copy) => {
        const control = parseALControlMessage(copy.message);
        if (control === undefined) {
            return [];
        }
        const detail = control.type === 'ack'
            ? `ack ${control.payload.logicalRecipientPeerId} ${control.payload.status}`
            : control.type;
        return [`${copy.fromPeerId}>${copy.toPeerId} ${detail}`];
    });
}

function readCopies(messages: readonly ALMessage[], message: ALMessage): number {
    return messages.filter((sent) => sent.id.msgId === message.id.msgId).length;
}

function readAdmissionReasons(peer: RtcRelayOverlayFixture, message: ALMessage): readonly string[] {
    return peer.diagnostics.flatMap((event) => event.kind === 'admission-outcome' && event.msgId === message.id.msgId ? [event.reason] : []);
}

/** The copy as a sender that stamps no deadline would carry it: no expiry instant and no expiry policy. */
function toDeadlineFreeCopy(message: ALMessage): ALMessage {
    const { expiresAtMs: _expiresAtMs, ...constraints } = message.constraints ?? {};
    const { expiry: _expiry, ...qos } = message.qos ?? {};
    return { ...message, constraints, qos };
}

/** A best-effort frame of a position stream with no receipt, as a peer sends many a second. */
function createPositionFrame(input: PositionFrameInput): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'position', resourceId: input.resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'position.frame.v1',
        { resourceId: input.resourceId, seq: input.seq },
        {
            reliability: 'best-effort',
            ack: 'none',
            ttlMs: 30_000,
            qos: input.qos,
            ...(input.seq === undefined ? {} : { seq: input.seq, orderingKey: 'position-track' })
        }
    );
}

/** The origin's copies to `b` and `c`, each relayed by its own pipeline, and those relays' copies to `d`. */
async function relayToBothParentsOfD(mesh: OverlapMesh, frames: readonly ALMessage[]): Promise<RelayedCopies> {
    for (const frame of frames) {
        await enqueueAndDrain(mesh.origin.manager, frame);
    }
    for (const parentPeerId of ['b', 'c']) {
        for (const copy of mesh.origin.channels[parentPeerId]!.sent) {
            await mesh.peers.get(parentPeerId)!.receive(copy, 'a');
        }
    }
    const fromPrevious = await mesh.peers.get('b')!.readSent('d');
    const fromPromoted = await mesh.peers.get('c')!.readSent('d');
    return {
        previous: (frame) => fromPrevious.find((copy) => copy.id.msgId === frame.id.msgId)!,
        promoted: (frame) => fromPromoted.find((copy) => copy.id.msgId === frame.id.msgId)!
    };
}

/** The origin `a`, whose accepted child is `c` and whose replaced layout's child, in force, is `b`. */
function planOriginNextHops(qos: ALQosPolicyRequest, msgId: string): readonly string[] {
    return planOriginFanout(qos, msgId, { acceptedPeerIds: ['c'], replacedPeerIds: ['b'], readyPeerIds: ['b', 'c'] });
}

/** The origin `a`'s next hops for one frame over its accepted neighbours and, when one is in force, a replaced layout's. */
function planOriginFanout(qos: ALQosPolicyRequest, msgId: string, layouts: OriginFanoutLayouts): readonly string[] {
    const frame = createPositionFrame({ resourceId: msgId, qos });
    return planALMessageHandling({ ...frame, id: { ...frame.id, msgId } }, {
        nowMs: frame.id.ts,
        selfPeerId: 'a',
        connectedPeerIds: layouts.readyPeerIds,
        groupMemberPeerIds: ['a', ...layouts.acceptedPeerIds, ...layouts.replacedPeerIds ?? []],
        overlayNeighborPeerIds: layouts.acceptedPeerIds,
        previousOverlayLayout: layouts.replacedPeerIds === undefined
            ? undefined
            : { neighborPeerIds: layouts.replacedPeerIds, nextHopsBySessionId: undefined }
    }).forwarding.nextHopPeerIds;
}

function useFakeClock(): void {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
}

describe('a frame carried by both layouts during the replaced-layout overlap', () => {
    useFakeClock();

    // Green on first run.
    it.each([
        { first: 'the previous parent b', sessionIds: ['a', 'b', 'c', 'd', 'e'] },
        { first: 'the new parent c', sessionIds: ['a', 'c', 'b', 'd', 'e'] }
    ])('a frame relayed by the previous and the new parent is delivered once and forwarded once ($first first)', async ({ sessionIds }) => {
        const mesh = createOverlapMesh({ sessionIds, previousTree: DIAMOND_PREVIOUS, promotedTree: DIAMOND_PROMOTED });
        const message = createOriginReceiverMulticast('two-parents');
        await enqueueAndDrain(mesh.origin.manager, message);

        const carried = await exchangeUntilQuiet(mesh);

        const d = mesh.peers.get('d')!;
        expect(readDataEdges(carried, message).filter((edge) => edge.endsWith('>d')).toSorted()).toEqual(['b>d', 'c>d']);
        expect(readCopies(d.delivered, message)).toBe(1);
        expect(readAdmissionReasons(d, message)).toEqual(['admitted', 'duplicate']);
        expect(readCopies(await d.readSent('e'), message)).toBe(1);
        expect(readCopies(mesh.peers.get('e')!.delivered, message)).toBe(1);
    });

    // Green on first run: the copy that loses the race earns its sender this peer's terminal ACK at once (the sibling
    // answer), so neither parent waits, retries or asks the origin for a repair.
    it.each([
        { first: 'the previous parent b', sessionIds: ['a', 'b', 'c', 'd', 'e'], answer: 'd>c ack d subtree-complete' },
        { first: 'the new parent c', sessionIds: ['a', 'c', 'b', 'd', 'e'], answer: 'd>b ack d subtree-complete' }
    ])('the second parent gets the peer\'s ACK for its duplicate copy, and no copy is retried or repaired ($first first)', async ({ sessionIds, answer }) => {
        const mesh = createOverlapMesh({ sessionIds, previousTree: DIAMOND_PREVIOUS, promotedTree: DIAMOND_PROMOTED });
        const message = createOriginReceiverMulticast('second-copy-answer');
        await enqueueAndDrain(mesh.origin.manager, message);

        const carried = await exchangeUntilQuiet(mesh);
        await vi.advanceTimersByTimeAsync(10 * ACK_TIMEOUT_MS);
        const later = await exchangeUntilQuiet(mesh);

        const controls = readControlEdges(carried);
        expect(controls).toContain(answer);
        expect(controls.filter((control) => !control.includes(' ack '))).toEqual([]);
        expect(readDataEdges(carried, message)).toHaveLength(5);
        expect(later).toEqual([]);
        expect(mesh.origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1))
            .toMatchObject({ complete: true, unconfirmedRecipientPeerIds: [], unconfirmedHopPeerIds: [] });
    });

    // Green on first run.
    it('an ordered frame that arrives by the new path before its predecessor arrives by the old one is delivered in order', async () => {
        const mesh = createOverlapMesh({
            sessionIds: DIAMOND_SESSION_IDS,
            previousTree: DIAMOND_PREVIOUS,
            promotedTree: DIAMOND_PROMOTED
        });
        const frames = [1, 2, 3].map((seq) => createPositionFrame({ resourceId: `ordered-${seq}`, seq }));
        const copies = await relayToBothParentsOfD(mesh, frames);
        const d = mesh.peers.get('d')!;
        await d.receive(copies.promoted(frames[0]!), 'c');

        await d.receive(copies.promoted(frames[2]!), 'c');
        expect(d.delivered.map((message) => message.ordering?.seq)).toEqual([1]);
        await d.receive(copies.previous(frames[1]!), 'b');
        for (const frame of frames) {
            await d.receive(copies.previous(frame), 'b');
            await d.receive(copies.promoted(frame), 'c');
        }

        expect(d.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
        // A relay forwards in arrival order; the receiver below it restores the order on its own.
        const forwardedToE = await d.readSent('e');
        expect(forwardedToE.map((message) => message.ordering?.seq)).toEqual([1, 3, 2]);
        const e = mesh.peers.get('e')!;
        for (const copy of forwardedToE) {
            await e.receive(copy, 'd');
        }
        expect(e.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
    });

    // Green on first run. Not one of T's decision rules, reported as a concern: a receiver with no state for a track
    // enters it at the first frame it meets, so an older frame that arrives later by the other layout is stale.
    it('a receiver that first meets an ordered track by the new path enters it there, and its predecessor by the old path is not delivered', async () => {
        const mesh = createOverlapMesh({
            sessionIds: DIAMOND_SESSION_IDS,
            previousTree: DIAMOND_PREVIOUS,
            promotedTree: DIAMOND_PROMOTED
        });
        const frames = [1, 2].map((seq) => createPositionFrame({ resourceId: `entered-${seq}`, seq }));
        const copies = await relayToBothParentsOfD(mesh, frames);
        const d = mesh.peers.get('d')!;

        await d.receive(copies.promoted(frames[1]!), 'c');
        await d.receive(copies.previous(frames[0]!), 'b');

        expect(d.delivered.map((message) => message.ordering?.seq)).toEqual([2]);
        expect(readAdmissionReasons(d, frames[0]!)).toEqual(['Ordering runtime rejected message as stale']);
    });

    // Green on first run.
    it('a supersedence frame older than one already delivered by the other path is not delivered', async () => {
        const mesh = createOverlapMesh({
            sessionIds: DIAMOND_SESSION_IDS,
            previousTree: DIAMOND_PREVIOUS,
            promotedTree: DIAMOND_PROMOTED
        });
        const latestWins: ALQosPolicyRequest = { supersedence: { algo: 'latest-wins' } };
        const older = createPositionFrame({ resourceId: 'pose', qos: latestWins });
        await vi.advanceTimersByTimeAsync(100);
        const newer = createPositionFrame({ resourceId: 'pose', qos: latestWins });
        const copies = await relayToBothParentsOfD(mesh, [older, newer]);
        const d = mesh.peers.get('d')!;

        await d.receive(copies.promoted(newer), 'c');
        await d.receive(copies.previous(older), 'b');

        expect(d.delivered.map((message) => message.id.msgId)).toEqual([newer.id.msgId]);
        expect(readAdmissionReasons(d, older)).toEqual([`Message superseded by ${newer.id.msgId}`]);
        expect((await d.readSent('e')).map((message) => message.id.msgId)).toEqual([newer.id.msgId]);
    });
});

describe('a loop through the union of two layouts', () => {
    useFakeClock();

    // The visited list each copy carries names every sibling its sender addressed, so in the triangle no relay owns a
    // peer of the cycle another copy already reaches, and no copy arrives twice.
    it('a loop through a triangle of the union is never entered', async () => {
        const mesh = createOverlapMesh({
            sessionIds: ['a', 'b', 'c', 'd'],
            previousTree: CYCLE_PREVIOUS,
            promotedTree: CYCLE_PROMOTED
        });
        const frame = createPositionFrame({ resourceId: 'cycle' });
        await enqueueAndDrain(mesh.origin.manager, frame);

        const carried = await exchangeUntilQuiet(mesh);

        expect(readDataEdges(carried, frame)).toEqual(['a>b', 'b>c', 'b>d']);
        for (const peer of mesh.peers.values()) {
            expect(readCopies(peer.delivered, frame)).toBe(1);
        }
    });

    // In the square `b`, `c`, `d`, `e` the two copies `b` sends meet at `d`, which neither sender could name as
    // visited: `d` admits the first, drops the second as a duplicate, and forwards neither back into the square.
    it('a loop through the union of two layouts stops at the first repeat', async () => {
        const mesh = createOverlapMesh({
            sessionIds: ['a', 'b', 'c', 'd', 'e'],
            previousTree: SQUARE_PREVIOUS,
            promotedTree: SQUARE_PROMOTED
        });
        const frame = createPositionFrame({ resourceId: 'square' });
        await enqueueAndDrain(mesh.origin.manager, frame);

        const carried = await exchangeUntilQuiet(mesh);

        expect(readDataEdges(carried, frame)).toEqual(['a>b', 'b>c', 'b>e', 'c>d', 'e>d']);
        expect(readAdmissionReasons(mesh.peers.get('d')!, frame)).toEqual(['admitted', 'duplicate']);
        for (const peer of mesh.peers.values()) {
            expect(readCopies(peer.delivered, frame)).toBe(1);
        }
    });

    // Green on first run: past the visited cap every relay owns every other neighbour, so a copy goes each way round
    // the cycle; each peer stops it at its first repeat, which it neither delivers nor forwards. A dedupe window of 0
    // does not open the loop: identity dedupe is held to the frame's deadline, and a semantic-key repeat that is
    // admitted again is neither delivered nor forwarded again.
    it.each(
        [
            { policy: 'the default dedupe', qos: undefined, reasons: ['admitted', 'duplicate'] },
            {
                policy: 'a message-id dedupe window of 0',
                qos: { dedup: { algo: 'msg-id', opts: { windowMs: 0 } } },
                reasons: ['admitted', 'duplicate']
            },
            {
                policy: 'a semantic-key dedupe window of 0',
                qos: { dedup: { algo: 'semantic-key', opts: { windowMs: 0 } } },
                reasons: ['admitted', 'admitted']
            }
        ] as const
    )('a copy whose visited list is past its cap stops in a cycle of the union under $policy', async ({ qos, reasons }) => {
        const mesh = createOverlapMesh({
            sessionIds: ['a', 'b', 'c', 'd'],
            previousTree: CYCLE_PREVIOUS,
            promotedTree: CYCLE_PROMOTED
        });
        const frame = createPositionFrame({ resourceId: 'past-cap', qos });
        await enqueueAndDrain(mesh.origin.manager, frame);
        const first = mesh.origin.channels.b!.sent[0]!;
        mesh.origin.channels.b!.sent[0] = { ...first, diagnostics: { ...first.diagnostics, visitedPeerIds: VISITED_AT_CAP } };

        const carried = await exchangeUntilQuiet(mesh);

        expect(readDataEdges(carried, frame)).toEqual(['a>b', 'b>c', 'b>d', 'c>d', 'd>c']);
        for (const peer of mesh.peers.values()) {
            expect(readCopies(peer.delivered, frame)).toBe(1);
        }
        expect(readAdmissionReasons(mesh.peers.get('c')!, frame)).toEqual(reasons);
        expect(readAdmissionReasons(mesh.peers.get('d')!, frame)).toEqual(reasons);
    });

    // A frame that reaches a peer with no deadline (a proof-carrying frame passed on untouched, or a foreign sender's)
    // holds its message-id dedupe row only for the window. Every copy here arrives without a deadline and 1 s after it
    // was sent, so each repeat meets a dedupe row that has already expired and is admitted again. The loop still stops:
    // the local delivery effect is keyed by sender and message id, so the repeat is not delivered again (a per-arrival
    // effect id delivers it twice), and the outbound admission of the forward finds the message id already sent and
    // absorbs it as a duplicate (without that check the repeats are forwarded on round the cycle).
    it('a frame without a deadline and with a dedupe window of 0 still stops at the first repeat in a union with a cycle', async () => {
        const mesh = createOverlapMesh({
            sessionIds: ['a', 'b', 'c', 'd'],
            previousTree: CYCLE_PREVIOUS,
            promotedTree: CYCLE_PROMOTED
        });
        const frame = createPositionFrame({ resourceId: 'no-deadline', qos: { dedup: { algo: 'msg-id', opts: { windowMs: 0 } } } });
        await enqueueAndDrain(mesh.origin.manager, frame);
        const first = mesh.origin.channels.b!.sent[0]!;
        mesh.origin.channels.b!.sent[0] = { ...first, diagnostics: { ...first.diagnostics, visitedPeerIds: VISITED_AT_CAP } };

        const carried = await exchangeUntilQuiet(mesh, {
            toCarried: (message) => message.id.msgId === frame.id.msgId ? toDeadlineFreeCopy(message) : message,
            delayMs: 1_000
        });

        expect(carried.filter((copy) => copy.message.id.msgId === frame.id.msgId).every((copy) => resolveALMessageExpireAtMs(copy.message) === undefined))
            .toBe(true);
        expect(readDataEdges(carried, frame)).toEqual(['a>b', 'b>c', 'b>d', 'c>d', 'd>c']);
        for (const peer of mesh.peers.values()) {
            expect(readCopies(peer.delivered, frame)).toBe(1);
        }
        expect(readAdmissionReasons(mesh.peers.get('c')!, frame)).toEqual(['admitted', 'admitted']);
        expect(readAdmissionReasons(mesh.peers.get('d')!, frame)).toEqual(['admitted', 'admitted']);
    });
});

describe('the transport copies one broadcast produces', () => {
    useFakeClock();

    // Green on first run.
    it.each([
        {
            shape: 'the chain re-plan',
            sessionIds: ['a', 'b', 'c', 'd'],
            previousTree: CHAIN_PREVIOUS,
            promotedTree: CHAIN_PROMOTED,
            withoutOverlap: ['a>c', 'c>d', 'd>b'],
            withOverlap: ['a>b', 'a>c', 'b>d', 'c>d']
        },
        {
            shape: 'the diamond',
            sessionIds: DIAMOND_SESSION_IDS,
            previousTree: DIAMOND_PREVIOUS,
            promotedTree: DIAMOND_PROMOTED,
            withoutOverlap: ['a>b', 'a>c', 'c>d', 'd>e'],
            withOverlap: ['a>b', 'a>c', 'b>d', 'c>d', 'd>e']
        },
        {
            shape: 'the moved subtree',
            sessionIds: DIAMOND_SESSION_IDS,
            previousTree: MOVED_SUBTREE_PREVIOUS,
            promotedTree: MOVED_SUBTREE_PROMOTED,
            withoutOverlap: ['a>b', 'a>c', 'c>d', 'c>e'],
            withOverlap: ['a>b', 'a>c', 'b>d', 'b>e', 'c>d', 'c>e']
        }
    ])('$shape carries each frame over exactly these edges, once each, and every peer delivers it once', async (input) => {
        const inside = createOverlapMesh(input);
        const after = createOverlapMesh(input);
        const insideFrame = createPositionFrame({ resourceId: 'inside' });
        const afterFrame = createPositionFrame({ resourceId: 'after' });
        await enqueueAndDrain(inside.origin.manager, insideFrame);
        const insideEdges = readDataEdges(await exchangeUntilQuiet(inside), insideFrame);
        await vi.advanceTimersByTimeAsync(SERVED_REPLACED_LAYOUT_OVERLAP_MS);
        await enqueueAndDrain(after.origin.manager, afterFrame);
        const afterEdges = readDataEdges(await exchangeUntilQuiet(after), afterFrame);

        expect(afterEdges.toSorted()).toEqual(input.withoutOverlap);
        expect(insideEdges.toSorted()).toEqual(input.withOverlap);
        for (const [mesh, frame] of [[inside, insideFrame], [after, afterFrame]] as const) {
            for (const peer of mesh.peers.values()) {
                expect(readCopies(peer.delivered, frame)).toBe(1);
            }
        }
    });
});

describe('the overlap\'s tail, when a relay promoted later than its previous child', () => {
    useFakeClock();

    const FORWARDING_HALF_MS = SERVED_REPLACED_LAYOUT_OVERLAP_MS / 2;
    const RELAY_OVERLAP_END_MS = FORWARDING_HALF_MS + SERVED_REPLACED_LAYOUT_OVERLAP_MS;
    /** Every 1.5 s from `c`'s promotion until `b` stops admitting the origin's copies over its own replaced edge. */
    const SEND_AT_MS = Array.from({ length: RELAY_OVERLAP_END_MS / 1_500 }, (_, index) => index * 1_500);

    // The chain `a,b,c,d` re-planned to `a,c,d,b`: `c` promotes now, `b` (its previous parent) promotes later by
    // `relayLagMs`. The origin `a` stays on the previous layout, so every frame reaches `b` first.
    function createChainTail(): ChainTail {
        const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
        const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b'], nextHopsBySessionId: CHAIN_PREVIOUS });
        const child = createRtcRelayOverlayFixture({
            selfPeerId: 'c',
            snapshot,
            neighbourPeerIds: ['a', 'b', 'd'],
            initialOverlay: createOriginOverlay(CHAIN_PREVIOUS.c!, CHAIN_PREVIOUS)
        });
        const relay = createRtcRelayOverlayFixture({
            selfPeerId: 'b',
            snapshot,
            neighbourPeerIds: ['a', 'c', 'd'],
            initialOverlay: createOriginOverlay(CHAIN_PREVIOUS.b!, CHAIN_PREVIOUS)
        });
        child.acceptSnapshot(toPromotedSnapshot(snapshot));
        child.acceptOverlay(toPromotedOverlay(CHAIN_PROMOTED, 'c'));
        return {
            origin,
            child,
            relay,
            promoteRelay: () => {
                relay.acceptSnapshot(toPromotedSnapshot(snapshot));
                relay.acceptOverlay(toPromotedOverlay(CHAIN_PROMOTED, 'b'));
            }
        };
    }

    /** The origin sends one frame to `b`; every copy `b` relays to `c` is carried to `c`. */
    async function relayToChild(tail: ChainTail, frame: ALMessage): Promise<readonly ALMessage[]> {
        await enqueueAndDrain(tail.origin.manager, frame);
        await tail.relay.receive(tail.origin.channels.b!.sent.find((sent) => sent.id.msgId === frame.id.msgId)!, 'a');
        const copies = (await tail.relay.readSent('c')).filter((sent) => sent.id.msgId === frame.id.msgId);
        for (const copy of copies) {
            await tail.child.receive(copy, 'b');
        }
        return copies;
    }

    function createTailFrame(reliability: 'at-least-once' | 'best-effort', resourceId: string): ALMessage {
        return reliability === 'at-least-once' ? createOriginReceiverMulticast(resourceId) : createPositionFrame({ resourceId });
    }

    // `b` promotes exactly half the overlap after `c`, so its forwarding over the replaced edge ends at the instant
    // `c` stops admitting that edge. The fixture's queue waits move the clock on by a few tens of milliseconds per
    // frame, so each send records the elapsed time before and after it; the boundary to the millisecond is pinned by
    // the rule's own tests.
    it.each(['at-least-once', 'best-effort'] as const)(
        'a relay that promoted up to half the overlap after its previous child sends that child no %s copy the child refuses',
        async (reliability) => {
            const tail = createChainTail();
            const startMs = Date.now();
            const sends: TailSend[] = [];
            const refusals: string[] = [];
            let deliveredCopies = 0;
            for (const sendAtMs of SEND_AT_MS) {
                await vi.advanceTimersByTimeAsync(Math.max(0, sendAtMs - (Date.now() - startMs)));
                if (sendAtMs === FORWARDING_HALF_MS) {
                    tail.promoteRelay();
                }
                const frame = createTailFrame(reliability, `tail-${sendAtMs}`);
                const sentFromMs = Date.now() - startMs;
                const copies = await relayToChild(tail, frame);
                sends.push({ sentFromMs, sentUntilMs: Date.now() - startMs, copies: copies.length });
                refusals.push(...readAdmissionReasons(tail.child, frame).filter((reason) => reason !== 'admitted'));
                deliveredCopies += readCopies(tail.child.delivered, frame);
            }

            expect(refusals).toEqual([]);
            const forwarded = sends.filter((send) => send.copies > 0);
            // Inside both windows `b` forwards one copy; once `c`'s window has ended it forwards none.
            expect(sends.filter((send) => send.sentUntilMs < SERVED_REPLACED_LAYOUT_OVERLAP_MS && send.copies !== 1)).toEqual([]);
            expect(sends.filter((send) => send.sentFromMs >= SERVED_REPLACED_LAYOUT_OVERLAP_MS && send.copies > 0)).toEqual([]);
            expect(forwarded.length).toBeGreaterThanOrEqual(SERVED_REPLACED_LAYOUT_OVERLAP_MS / 1_500 - 1);
            expect(deliveredCopies).toBe(forwarded.length);
        }
    );

    // `b` promotes one millisecond more than half the overlap after `c`: at `c`'s bound, `b` is still in the first
    // half of its own overlap and forwards over the replaced edge. `c` refuses the copy as unauthorized because its
    // admission no longer permits the edge (cause `edge-unavailable`, not a membership or authority refusal), sends `b`
    // nothing back, delivers and forwards nothing, and `b` sends no retry or word upward.
    it.each(['at-least-once', 'best-effort'] as const)(
        'a relay that promoted more than half the overlap after its previous child is still refused as unauthorized (%s)',
        async (reliability) => {
            const tail = createChainTail();
            const relayLagMs = FORWARDING_HALF_MS + 1;
            await vi.advanceTimersByTimeAsync(relayLagMs);
            tail.promoteRelay();
            await vi.advanceTimersByTimeAsync(SERVED_REPLACED_LAYOUT_OVERLAP_MS - relayLagMs);
            const frame = createTailFrame(reliability, 'tail');
            const copies = await relayToChild(tail, frame);
            expect(copies).toHaveLength(1);
            expect(tail.child.readRoomAdmission(copies[0]!, 'b')).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
            await vi.advanceTimersByTimeAsync(10 * ACK_TIMEOUT_MS);

            expect(readAdmissionReasons(tail.child, frame)).toEqual(['unauthorized']);
            expect(await tail.child.readSent('b')).toEqual([]);
            expect(readCopies(tail.child.delivered, frame)).toBe(0);
            expect(readCopies(await tail.child.readSent('d'), frame)).toBe(0);
            expect(readCopies(await tail.relay.readSent('c'), frame)).toBe(1);
            expect((await tail.relay.readSentControls('a')).map((control) => control.type))
                .toEqual(reliability === 'at-least-once' ? ['ack'] : []);
        }
    );

    // An at-least-once relay row keeps `c` among the hops it waits on; a best-effort frame keeps no row at all.
    it('the relay\'s row for an at-least-once copy its previous child refused keeps waiting on that child', async () => {
        const tail = createChainTail();
        await vi.advanceTimersByTimeAsync(FORWARDING_HALF_MS + 1);
        tail.promoteRelay();
        await vi.advanceTimersByTimeAsync(FORWARDING_HALF_MS - 1);
        const frame = createTailFrame('at-least-once', 'tail');
        await relayToChild(tail, frame);
        await vi.advanceTimersByTimeAsync(10 * ACK_TIMEOUT_MS);

        const waiting = await tail.relay.readPendingAck({ msgId: frame.id.msgId, fromPeerId: 'c' });
        expect(waiting).toBeDefined();
        expect(waiting!.ackedFromPeerIds).not.toContain('c');
    });
});

describe('a multicast frozen to few recipients during the forwarding half', () => {
    useFakeClock();

    /** A receipted frame whose receipt counts next hops and their subtrees, not recipients. */
    function createOriginSubtreeMulticast(resourceId: string): ALMessage {
        return newALMulticastMessage(
            'a',
            { topicId: 'chat', resourceId, contextId: 'room' },
            ORIGIN_ROOM,
            'chat.message.v1',
            { text: resourceId },
            { reliability: 'at-least-once', ttlMs: 30_000, qos: { ack: { algo: 'subtree' } } }
        );
    }

    /** A position frame frozen to `recipientPeerIds` at the mesh snapshot's version. */
    function createFrozenFrame(recipientPeerIds: readonly string[], qos: ALQosPolicyRequest | undefined): ALMessage {
        return { ...createPositionFrame({ resourceId: 'frozen', qos }), targets: toOriginFrozenTargets(recipientPeerIds, 4) };
    }

    const REVIEW_PREVIOUS: SessionNextHops = { a: ['b'], b: ['a', 'c', 'e'], c: ['b'], e: ['b', 'f'], f: ['e'] };
    const REVIEW_PROMOTED: SessionNextHops = { a: ['c'], b: ['c', 'e'], c: ['a', 'b'], e: ['b', 'f'], f: ['e'] };

    // The review's example with a chain `e`, `f` below `b`: `a` reaches `c` over the accepted edge and `b` over the
    // replaced one, and names both visited, so no neighbour of `b` toward `c` is left for `b` to own over either layout.
    it.each(
        [
            {
                shape: 'the recipient visited through the other layout',
                sessionIds: ['a', 'b', 'c', 'e', 'f'],
                previousTree: REVIEW_PREVIOUS,
                promotedTree: REVIEW_PROMOTED,
                recipientPeerIds: ['c'],
                edges: ['a>b', 'a>c']
            },
            // Green on first run: random-k is clamped to the accepted neighbour count and keeps the accepted child first, so
            // the origin addresses no replaced-layout neighbour that could fall back.
            {
                shape: 'the recipient visited through the other layout under random-k with a limit of 2',
                sessionIds: ['a', 'b', 'c', 'e', 'f'],
                previousTree: REVIEW_PREVIOUS,
                promotedTree: REVIEW_PROMOTED,
                recipientPeerIds: ['c'],
                qos: { fanout: { algo: 'random-k', opts: { limit: 2 } } },
                edges: ['a>c']
            },
            {
                shape: 'the recipient-side neighbour visited through the other layout at depth two',
                sessionIds: ['a', 'b', 'c', 'd', 'e', 'f'],
                previousTree: { a: ['b'], b: ['a', 'd', 'e'], c: ['d'], d: ['b', 'c'], e: ['b', 'f'], f: ['e'] },
                promotedTree: { a: ['d'], b: ['d', 'e'], c: ['d'], d: ['a', 'b', 'c'], e: ['b', 'f'], f: ['e'] },
                recipientPeerIds: ['c'],
                edges: ['a>b', 'a>d', 'd>c']
            },
            {
                shape: 'two recipients in different subtrees, both visited through the other layout',
                sessionIds: ['a', 'b', 'c', 'd', 'e', 'f'],
                previousTree: { a: ['b'], b: ['a', 'c', 'd', 'e'], c: ['b'], d: ['b'], e: ['b', 'f'], f: ['e'] },
                promotedTree: { a: ['c', 'd'], b: ['c', 'e'], c: ['a', 'b'], d: ['a'], e: ['b', 'f'], f: ['e'] },
                recipientPeerIds: ['c', 'd'],
                edges: ['a>b', 'a>c', 'a>d']
            },
            // Green on first run: `b` owns `e` toward `f`, so no fallback is decided and `g` gets no copy.
            {
                shape: 'two recipients in different subtrees, one of them behind an unvisited neighbour',
                sessionIds: ['a', 'b', 'c', 'e', 'f', 'g'],
                previousTree: { a: ['b'], b: ['a', 'c', 'e', 'g'], c: ['b'], e: ['b', 'f'], f: ['e'], g: ['b'] },
                promotedTree: { a: ['c'], b: ['c', 'e', 'g'], c: ['a', 'b'], e: ['b', 'f'], f: ['e'], g: ['b'] },
                recipientPeerIds: ['c', 'f'],
                edges: ['a>b', 'a>c', 'b>e', 'e>f']
            }
        ] as readonly FrozenOverlapShape[]
    )('$shape: every recipient delivers once and no copy reaches a peer off the path to one', async (input) => {
        const mesh = createOverlapMesh(input);
        const frame = createFrozenFrame(input.recipientPeerIds, input.qos);
        await enqueueAndDrain(mesh.origin.manager, frame);

        const carried = await exchangeUntilQuiet(mesh);

        expect(readDataEdges(carried, frame).toSorted()).toEqual(input.edges);
        for (const [peerId, peer] of mesh.peers) {
            expect(readCopies(peer.delivered, frame), peerId).toBe(input.recipientPeerIds.includes(peerId) ? 1 : 0);
        }
    });

    it('the origin\'s retry for a recipient whose first copy was lost reaches no peer off the path to it', async () => {
        const mesh = createOverlapMesh({ sessionIds: ['a', 'b', 'c', 'e', 'f'], previousTree: REVIEW_PREVIOUS, promotedTree: REVIEW_PROMOTED });
        const message = { ...createOriginReceiverMulticast('frozen-retry'), targets: toOriginFrozenTargets(['c'], 4) };
        await enqueueAndDrain(mesh.origin.manager, message);
        mesh.carriedCounts.set('a>c', 1);

        const first = await exchangeUntilQuiet(mesh);
        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
        const retry = await exchangeUntilQuiet(mesh);

        expect(readDataEdges(first, message).toSorted()).toEqual(['a>b']);
        expect(readDataEdges(retry, message).toSorted()).toEqual(['a>b', 'a>c']);
        expect(readCopies(mesh.peers.get('c')!.delivered, message)).toBe(1);
    });

    // Green on first run. `b`, the origin's only path child toward `c` in both layouts, takes no copy. The origin's
    // retry names `b` visited and goes round it to `d` over the replaced edge; `d` reaches `c` through `g` over the
    // accepted layout, a path neither layout alone gives the origin. Owning nothing over a layout whose path child is
    // visited would lose this delivery.
    it('the origin\'s retry round a failed path child still reaches the recipient through the other layout', async () => {
        const mesh = createOverlapMesh({
            sessionIds: ['a', 'b', 'c', 'd', 'g'],
            previousTree: { a: ['b', 'd'], b: ['a', 'c'], c: ['b'], d: ['a', 'g'], g: ['d'] },
            promotedTree: { a: ['b'], b: ['a', 'g'], c: ['g'], d: ['g'], g: ['b', 'c', 'd'] }
        });
        const failedPathChild = {
            ...mesh,
            edges: new Map([...mesh.edges].map(([peerId, toPeerIds]) => [peerId, toPeerIds.filter((toPeerId) => toPeerId !== 'b')]))
        };
        const message = { ...createOriginSubtreeMulticast('frozen-reroute'), targets: toOriginFrozenTargets(['c'], 4) };
        await enqueueAndDrain(mesh.origin.manager, message);

        const first = await exchangeUntilQuiet(failedPathChild);
        await vi.advanceTimersByTimeAsync(10 * ACK_TIMEOUT_MS);
        const retry = await exchangeUntilQuiet(failedPathChild);

        expect(readDataEdges(first, message)).toEqual([]);
        expect(readDataEdges(retry, message)).toEqual(['a>d', 'd>g', 'g>c']);
        expect(readCopies(mesh.peers.get('c')!.delivered, message)).toBe(1);
    });
});

describe('fanout selection over the union of two layouts', () => {
    const MSG_IDS = Array.from({ length: 8 }, (_, index) => `frame-${index}`);

    // Green on first run: a limited fanout is clamped to the accepted layout's neighbour count, and `limit` keeps the
    // accepted children first, so the replaced layout adds no copy.
    it('under limit fanout the accepted child is kept and the replaced child gets no copy', () => {
        for (const msgId of MSG_IDS) {
            expect(planOriginNextHops({ fanout: { algo: 'limit' } }, msgId)).toEqual(['c']);
        }
    });

    // Two ids of one length that differ in one character rank the same way for almost every message id, so these
    // children's ids differ in their first characters: `frame-0` ranks `accepted-child` first and `frame-5` ranks
    // `previous-child` first. Accepted-first selection is shown against both rank orders.
    const RANKED_BOTH_WAYS_MSG_IDS = ['frame-0', 'frame-5'];

    // `random-k` ranks within each layout: the ready accepted children by rank, then the ready replaced-layout children,
    // then the accepted neighbour count cuts the list.
    it('under random-k fanout accepted children are chosen before replaced ones', () => {
        const layouts = { acceptedPeerIds: ['accepted-child'], replacedPeerIds: ['previous-child'], readyPeerIds: ['previous-child', 'accepted-child'] };
        for (const msgId of RANKED_BOTH_WAYS_MSG_IDS) {
            expect(planOriginFanout({ fanout: { algo: 'random-k' } }, msgId, layouts)).toEqual(['accepted-child']);
        }
    });

    it('under random-k fanout a replaced-layout child fills in when fewer accepted children are ready than the limit', () => {
        const layouts = {
            acceptedPeerIds: ['accepted-child', 'accepted-late'],
            replacedPeerIds: ['previous-child'],
            readyPeerIds: ['previous-child', 'accepted-child']
        };
        for (const msgId of RANKED_BOTH_WAYS_MSG_IDS) {
            expect(planOriginFanout({ fanout: { algo: 'random-k' } }, msgId, layouts)).toEqual(['accepted-child', 'previous-child']);
        }
    });

    // Peer ids of different lengths: the rank of `${msgId}:${peerId}` then orders them differently from one id to the
    // next (with ids of one length that differ in one character the order hardly ever changes).
    it('with no replaced layout in force random-k selects as before', () => {
        const layouts = { acceptedPeerIds: ['birch', 'cedar', 'dogwood'], replacedPeerIds: undefined, readyPeerIds: ['birch', 'cedar', 'dogwood'] };
        const selections = ['frame-0', 'frame-1', 'frame-2', 'frame-5'].map((msgId) =>
            planOriginFanout({ fanout: { algo: 'random-k', opts: { limit: 2 } } }, msgId, layouts)
        );
        expect(selections).toEqual([['dogwood', 'birch'], ['dogwood', 'birch'], ['birch', 'cedar'], ['birch', 'cedar']]);
    });
});
