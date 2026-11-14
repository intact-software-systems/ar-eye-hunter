import { expect, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createOriginOverlay, createRtcOriginOverlayFixture, type RtcOriginOverlayFixture } from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/**
 * A room mesh for layout promotions: the origin `a` and a relay pipeline for every other session, joined by the edges
 * open at each, and an exchange that carries every copy over those edges until no edge has a new one.
 */

export type SessionNextHops = Readonly<Record<string, readonly string[]>>;

export interface RoomLayout {
    readonly tree: SessionNextHops;
    readonly version: number;
}

/** The snapshot naming a layout accepted, and that layout as one session holds it. */
export interface AcceptedLayout {
    readonly snapshot: GroupSnapshot;
    readonly overlay: OverlayInfo;
}

export interface LayoutMeshInput {
    readonly snapshot: GroupSnapshot;
    /** The layout every session starts on, with no layout replaced. */
    readonly initialTree: SessionNextHops;
    /** The origin `a` first; the order of the others is the order the exchange carries their frames in. */
    readonly sessionIds: readonly string[];
    /** The neighbours whose edge is open at `sessionId`. */
    openEdgePeerIds(sessionId: string): readonly string[];
    /** Every copy one exchange may carry before the test fails: a loop that does not stop exceeds it. */
    readonly copyBudget: number;
}

export interface LayoutMesh {
    readonly snapshot: GroupSnapshot;
    readonly origin: RtcOriginOverlayFixture;
    readonly peers: ReadonlyMap<string, RtcRelayOverlayFixture>;
    readonly edges: ReadonlyMap<string, readonly string[]>;
    /** How many frames of each directed edge the exchange already carried. */
    readonly carriedCounts: Map<string, number>;
    readonly copyBudget: number;
}

export interface TransportCopy {
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly message: ALMessage;
    /** The clock when the exchange took the copy off its edge. */
    readonly carriedAtMs: number;
}

/** What the transport does to each copy it carries: the copy that arrives, and how long it travels. */
export interface ExchangeTransit {
    toCarried(message: ALMessage): ALMessage;
    readonly delayMs: number;
}

const DIRECT_TRANSIT: ExchangeTransit = { toCarried: (message) => message, delayMs: 0 };

/** One re-plan promotes the layout one version past the initial one. */
const PROMOTED_LAYOUT_VERSION = 2;

export const DIAMOND_SESSION_IDS = ['a', 'b', 'c', 'd', 'e'];

/** `d` has two parents during the overlap: `b` in the replaced layout, `c` in the promoted one; `e` hangs below `d`. */
export const DIAMOND_PREVIOUS: SessionNextHops = { a: ['b', 'c'], b: ['a', 'd'], c: ['a'], d: ['b', 'e'], e: ['d'] };
export const DIAMOND_PROMOTED: SessionNextHops = { a: ['b', 'c'], b: ['a'], c: ['a', 'd'], d: ['c', 'e'], e: ['d'] };

/** The chain `a`, `b`, `c`, `d` re-planned to `a`, `c`, `d`, `b`: every edge but `c`-`d` is new, and `a`-`b`, `b`-`c` are dropped. */
export const CHAIN_PREVIOUS: SessionNextHops = { a: ['b'], b: ['a', 'c'], c: ['b', 'd'], d: ['c'] };
export const CHAIN_PROMOTED: SessionNextHops = { a: ['c'], b: ['d'], c: ['a', 'd'], d: ['b', 'c'] };

export function toPromotedLayout(tree: SessionNextHops): RoomLayout {
    return { tree, version: PROMOTED_LAYOUT_VERSION };
}

/** A re-plan keeps the causal revision the fixture's layout was planned from: only the layout version moves. */
export function toAcceptedLayout(snapshot: GroupSnapshot, layout: RoomLayout, sessionId: string): AcceptedLayout {
    return {
        snapshot: {
            ...snapshot,
            group: {
                ...snapshot.group,
                acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: layout.version, state: 'active' }
            }
        },
        overlay: { ...createOriginOverlay(layout.tree[sessionId] ?? [], layout.tree), overlayVersion: layout.version }
    };
}

/** Every edge of every layout given is open at `sessionId`, as early dial leaves them. */
export function toOpenEdgePeerIds(sessionId: string, trees: readonly SessionNextHops[]): readonly string[] {
    return [...new Set(trees.flatMap((tree) => tree[sessionId] ?? []))];
}

export function createLayoutMesh(input: LayoutMeshInput): LayoutMesh {
    const { snapshot, initialTree } = input;
    const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: initialTree.a ?? [], nextHopsBySessionId: initialTree });
    origin.ready.peerIds = input.openEdgePeerIds('a');
    const edges = new Map<string, readonly string[]>([['a', origin.ready.peerIds]]);
    const peers = new Map<string, RtcRelayOverlayFixture>();
    for (const sessionId of input.sessionIds.filter((peerId) => peerId !== 'a')) {
        const neighbourPeerIds = input.openEdgePeerIds(sessionId);
        const initialOverlay = createOriginOverlay(initialTree[sessionId] ?? [], initialTree);
        peers.set(sessionId, createRtcRelayOverlayFixture({ selfPeerId: sessionId, snapshot, neighbourPeerIds, initialOverlay }));
        edges.set(sessionId, neighbourPeerIds);
    }
    return { snapshot, origin, peers, edges, carriedCounts: new Map(), copyBudget: input.copyBudget };
}

/** `sessionId` takes the snapshot naming `layout` accepted, then `layout` itself. */
export function acceptMeshLayout(mesh: LayoutMesh, sessionId: string, layout: RoomLayout): void {
    const accepted = toAcceptedLayout(mesh.snapshot, layout, sessionId);
    if (sessionId === 'a') {
        mesh.origin.groups.accept('room', accepted.snapshot);
        mesh.origin.acceptOverlay(accepted.overlay);
        return;
    }
    const peer = mesh.peers.get(sessionId)!;
    peer.acceptSnapshot(accepted.snapshot);
    peer.acceptOverlay(accepted.overlay);
}

/**
 * Carries every new frame over every open edge, in the order of the mesh's sessions, until no edge has one. A frame
 * that reaches the origin is a control it accepts, or a copy it only records. More than the budget fails the test.
 */
export async function exchangeUntilQuiet(mesh: LayoutMesh, transit: ExchangeTransit = DIRECT_TRANSIT): Promise<readonly TransportCopy[]> {
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
                    const copy = { fromPeerId, toPeerId, message: transit.toCarried(sentMessage), carriedAtMs: Date.now() };
                    carried.push(copy);
                    expect(carried.length, 'the exchange stops within its copy budget').toBeLessThanOrEqual(mesh.copyBudget);
                    if (transit.delayMs > 0) {
                        await vi.advanceTimersByTimeAsync(transit.delayMs);
                    }
                    await carry(mesh, copy);
                    moved = true;
                }
            }
        }
    }
    return carried;
}

/** Exchanges, then lets `totalMs` pass in steps, exchanging after each, and returns everything carried. */
export async function exchangeOver(mesh: LayoutMesh, totalMs: number): Promise<readonly TransportCopy[]> {
    const carried = [...await exchangeUntilQuiet(mesh)];
    for (let elapsedMs = 0; elapsedMs < totalMs; elapsedMs += 500) {
        await vi.advanceTimersByTimeAsync(500);
        carried.push(...await exchangeUntilQuiet(mesh));
    }
    return carried;
}

async function readEdge(mesh: LayoutMesh, fromPeerId: string, toPeerId: string): Promise<readonly ALMessage[]> {
    return fromPeerId === 'a'
        ? mesh.origin.channels[toPeerId]?.sent ?? []
        : await mesh.peers.get(fromPeerId)!.readSent(toPeerId);
}

async function carry(mesh: LayoutMesh, copy: TransportCopy): Promise<void> {
    if (copy.toPeerId !== 'a') {
        await mesh.peers.get(copy.toPeerId)!.receive(copy.message, copy.fromPeerId);
        return;
    }
    if (parseALControlMessage(copy.message) !== undefined) {
        await mesh.origin.manager.acceptControlMessage(copy.message);
    }
}

export function readCopies(messages: readonly ALMessage[], message: ALMessage): number {
    return messages.filter((sent) => sent.id.msgId === message.id.msgId).length;
}

export function readAdmissionReasons(peer: RtcRelayOverlayFixture, message: ALMessage): readonly string[] {
    return peer.diagnostics.flatMap((event) => event.kind === 'admission-outcome' && event.msgId === message.id.msgId ? [event.reason] : []);
}
