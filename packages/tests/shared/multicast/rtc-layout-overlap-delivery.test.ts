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
import { planALMessageHandling, type ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
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
        const peer = createRtcRelayOverlayFixture({ selfPeerId: sessionId, snapshot, neighbourPeerIds });
        peer.acceptOverlay(createOriginOverlay(input.previousTree[sessionId] ?? [], input.previousTree));
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
async function exchangeUntilQuiet(mesh: OverlapMesh): Promise<readonly TransportCopy[]> {
    const carried: TransportCopy[] = [];
    for (let moved = true; moved;) {
        moved = false;
        for (const [fromPeerId, toPeerIds] of mesh.edges) {
            for (const toPeerId of toPeerIds) {
                const key = `${fromPeerId}>${toPeerId}`;
                const sent = await readEdge(mesh, fromPeerId, toPeerId);
                const fresh = sent.slice(mesh.carriedCounts.get(key) ?? 0);
                mesh.carriedCounts.set(key, sent.length);
                for (const message of fresh) {
                    carried.push({ fromPeerId, toPeerId, message });
                    expect(carried.length, 'the exchange stops within its copy budget')
                        .toBeLessThanOrEqual(EXCHANGE_COPY_BUDGET);
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
    const frame = createPositionFrame({ resourceId: msgId, qos });
    return planALMessageHandling({ ...frame, id: { ...frame.id, msgId } }, {
        nowMs: frame.id.ts,
        selfPeerId: 'a',
        connectedPeerIds: ['b', 'c'],
        groupMemberPeerIds: ['a', 'b', 'c'],
        overlayNeighborPeerIds: ['c'],
        previousOverlayLayout: { neighborPeerIds: ['b'], nextHopsBySessionId: undefined }
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
        expect((await d.readSent('e')).map((message) => message.ordering?.seq)).toEqual([1, 3, 2]);
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

    // Green on first run: the visited list each copy carries names every sibling its sender addressed, so no relay
    // owns a peer of the cycle another copy already reaches.
    it('a loop through the union of two layouts stops at the first repeat', async () => {
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
    ])('$shape carries each frame once per edge of the layouts in force, and every peer delivers it once', async (input) => {
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

    // Green on first run, pinned as it is today. Each session stamps its own promotion instant, so `b`, which promoted
    // 5 s after `c`, still forwards to `c` for 5 s after `c`'s overlap ended. `c` refuses the copy as unauthorized with
    // no NACK, delivers and forwards nothing, and `b`'s row keeps waiting on `c` without a retry or a word upward.
    it.each(['at-least-once', 'best-effort'] as const)(
        'a relay forwards a %s frame to its previous child after the child\'s overlap ended, and the child refuses it as unauthorized',
        async (reliability) => {
            const snapshot = createOriginSnapshot(['a', 'b', 'c', 'd'], 4);
            const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b'], nextHopsBySessionId: CHAIN_PREVIOUS });
            const child = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['a', 'b', 'd'] });
            const relay = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: ['a', 'c', 'd'] });
            child.acceptOverlay(createOriginOverlay(CHAIN_PREVIOUS.c!, CHAIN_PREVIOUS));
            relay.acceptOverlay(createOriginOverlay(CHAIN_PREVIOUS.b!, CHAIN_PREVIOUS));
            child.acceptSnapshot(toPromotedSnapshot(snapshot));
            child.acceptOverlay(toPromotedOverlay(CHAIN_PROMOTED, 'c'));
            await vi.advanceTimersByTimeAsync(5_000);
            relay.acceptSnapshot(toPromotedSnapshot(snapshot));
            relay.acceptOverlay(toPromotedOverlay(CHAIN_PROMOTED, 'b'));
            await vi.advanceTimersByTimeAsync(SERVED_REPLACED_LAYOUT_OVERLAP_MS - 5_000);
            const frame = reliability === 'at-least-once'
                ? createOriginReceiverMulticast('tail')
                : createPositionFrame({ resourceId: 'tail' });
            await enqueueAndDrain(origin.manager, frame);
            await relay.receive(origin.channels.b!.sent[0]!, 'a');
            const copy = (await relay.readSent('c')).find((sent) => sent.id.msgId === frame.id.msgId);
            expect(copy).toBeDefined();

            await child.receive(copy!, 'b');
            await vi.advanceTimersByTimeAsync(10 * ACK_TIMEOUT_MS);

            expect(readAdmissionReasons(child, frame)).toEqual(['unauthorized']);
            expect(await child.readSent('b')).toEqual([]);
            expect(readCopies(child.delivered, frame)).toBe(0);
            expect(readCopies(await child.readSent('d'), frame)).toBe(0);
            expect(readCopies(await relay.readSent('c'), frame)).toBe(1);
            expect((await relay.readSentControls('a')).map((control) => control.type))
                .toEqual(reliability === 'at-least-once' ? ['ack'] : []);
            const waiting = await relay.readPendingAck({ msgId: frame.id.msgId, fromPeerId: 'c' });
            expect(waiting?.ackedFromPeerIds.includes('c')).toBe(reliability === 'at-least-once' ? false : undefined);
        }
    );
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

    // Expected failure, found on first run: `random-k` re-ranks every owned child by message id, the replaced layout's
    // included, under the accepted neighbour count, so a frame can go only to the replaced child `b`.
    it.fails('under random-k fanout accepted children are chosen before replaced ones', () => {
        for (const msgId of MSG_IDS) {
            expect(planOriginNextHops({ fanout: { algo: 'random-k' } }, msgId)).toContain('c');
        }
    });
});
