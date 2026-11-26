import { parseAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { readSocketClockSample } from '@shared-web/browser/connection/server-clock/read-socket-clock-sample.ts';
import { API_CREATE_WS_PATH, toApiWsUrl } from '@shared/websocket/to-api-ws-url.ts';
import { hasViewInvalidatedTopic, decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { ViewPushProofSocket } from './view-push/view-push-proof-socket.mts';
import { waitForProofCondition } from './cluster-proof-socket.mts';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { setTimeout as delay } from 'node:timers/promises';
import { checkNodeClockOffset, sampleNode, sampleNodeClockPair, type ClockProbeNode } from './check-node-clock-offset.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeRoomLobbyAccountView, type RoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import { requestJson, type ApiV1RtcTopologyProofApi, type ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';

export interface SeatDeadlineQualification {
    readonly api: ApiV1RtcTopologyProofApi;
    readonly claim: ClockProbeNode;
    readonly expiry: ClockProbeNode;
    readonly budgetMs: number;
    readonly databaseUrl: string;
    readonly owner: ProofSession;
    readonly player: ProofSession;
    readonly next: ProofSession;
    readonly stopExpiry: () => Promise<void>;
    readonly startExpiry: () => Promise<void>;
}

export async function withExpiryWorkerStopped(
    worker: Pick<SeatDeadlineQualification, 'stopExpiry' | 'startExpiry'>, observeOutage: () => Promise<void>
) {
    // Register recovery before stop: a controller can terminate the worker and then fail its acknowledgement.
    await using recovery = new AsyncDisposableStack();
    recovery.defer(() => worker.startExpiry());
    await worker.stopExpiry();
    await observeOutage();
}

/** The claim node returned the first timestamp before dispatch and the second after the response. */
export function classifyClaimReceipt(input: { before: number; after: number; deadline: number }) {
    const { before, after, deadline } = input;
    assert.ok([before, after, deadline].every(value => Number.isSafeInteger(value) && value >= 0) && before <= after);
    if (after < deadline) return 'before';
    if (before >= deadline) return 'at-or-after';
    return 'overlaps';
}

type TrialTiming = 'before' | 'after' | 'held-wake' | 'restart';

class SeatDeadlineTrial {
    private readonly workspaceId = crypto.randomUUID();
    private readonly scope = '/apps/seat-qualification/workspaces/' + this.workspaceId;
    private readonly groups = '/api/state' + this.scope + '/groups';
    private readonly room = this.groups + '/court';

    private readonly input: SeatDeadlineQualification;
    private readonly timing: TrialTiming;

    constructor(input: SeatDeadlineQualification, timing: TrialTiming) {
        this.input = input;
        this.timing = timing;
    }

    async run(): Promise<boolean> {
        const offer = await this.prepareOffer();
        const deadline = offer.deadlineEpochMs;
        assert.ok(deadline !== null);
        const { claim, expiry, player, next } = this.input;
        const observer = await ViewPushProofSocket.open({ api: this.input.api, session: next,
            scope: { applicationId: 'seat-qualification', workspaceId: this.workspaceId } });
        const origins = this.timing === 'restart' ? [claim] : [claim, expiry];
        const stop = new AbortController();
        const ready = origins.map(() => Promise.withResolvers<void>());
        const load = Promise.allSettled(origins.map((node, index) =>
            this.loadSocket(node, index === 0 ? player : this.input.owner, stop.signal, ready[index]!).catch(error => {
                ready[index]!.reject(error);
                throw error;
            })
        ));
        try {
            await Promise.all(ready.map(lane => lane.promise));
            const opening = await this.measureOffset('offer');
            if (this.timing === 'held-wake') {
                await this.claimWithExpiryWakeHeld(deadline, offer);
                await this.waitForPromotion(observer);
            } else if (this.timing === 'restart') {
                await this.recoverOverdueOffer(deadline, offer, observer);
                await this.claimSeat(deadline, await this.readClaimantGeneration());
            } else {
                await this.claimBeforeOrAfterDeadline(deadline, observer);
            }
            const allocation = await this.readFinalAllocation(claim.origin);
            assert.deepEqual(await this.readFinalAllocation(expiry.origin), allocation);
            console.log(JSON.stringify({ kind: 'allocation', timing: this.timing, workspaceId: this.workspaceId,
                confirmedBy: [claim.peerId, expiry.peerId], ...allocation }));
            const closing = await this.measureOffset('allocation');
            return opening && closing;
        } finally {
            observer.close();
            stop.abort();
            for (const result of await load) if (result.status === 'rejected') throw result.reason;
        }
    }

    private async loadSocket(node: ClockProbeNode, actor: ProofSession, signal: AbortSignal, ready: PromiseWithResolvers<void>) {
        const ticket = await this.input.api.issueWebSocketTicket(actor, node.origin);
        const socket = new WebSocket(toApiWsUrl({ wsBaseUrl: node.origin.replace(/^http/, 'ws'), createWsPath: API_CREATE_WS_PATH,
            sessionId: actor.sessionId, ticket, scope: { applicationId: 'seat-qualification', workspaceId: this.workspaceId } }));
        const start = performance.now();
        let exchanges = 0;
        try {
            await waitForProofCondition(() => socket.readyState === WebSocket.OPEN, 'load socket open');
            while (!signal.aborted) {
                const result = await readSocketClockSample({ readSocket: () => socket, expectedServerPeerId: node.peerId,
                    nowMonotonicMs: () => performance.now(), signal: AbortSignal.timeout(2_000) });
                assert.ok(result.right, 'Authenticated load socket must return a valid matching clock reply');
                exchanges++;
                if (exchanges === 1) ready.resolve();
                await delay(50);
            }
        } finally {
            socket.close();
            console.log(JSON.stringify({ kind: 'load', timing: this.timing, peerId: node.peerId,
                exchanges, elapsedMs: performance.now() - start }));
        }
        assert.ok(exchanges > 0);
    }

    private async readSeat(origin: string, actor: ProofSession) {
        const account = decodeRoomLobbyAccountView(await requestJson(origin, '/api/room-lobbies' + this.scope,
            { method: 'GET', session: actor, signal: AbortSignal.timeout(5_000) }));
        assert.equal(account.principalId, actor.clientId);
        assert.deepEqual(account.scope, { applicationId: 'seat-qualification', workspaceId: this.workspaceId });
        if (account.seat) assert.deepEqual(account.seat.roomRef, { ...account.scope, groupId: 'court' });
        return account.seat;
    }

    private async prepareOffer() {
        const { claim, owner, player, next } = this.input;
        await requestJson(claim.origin, toApiMutationRequestPath(this.groups, crypto.randomUUID()), {
            method: 'POST', session: owner, expectedStatus: 201,
            body: { groupId: 'court', displayName: 'Seat qualification', kind: 'room', joinMode: 'open',
                createdByPrincipalId: owner.clientId, maxMembers: 1, roomLobby: { returnWindowMs: 120000, claimWindowMs: 5000 } }
        });
        const command = (session: ProofSession, operation: 'wait' | 'release') => requestJson(claim.origin,
            toApiMutationRequestPath(this.room, crypto.randomUUID()), { method: 'PUT', session, body: { roomLobby: { operation } } });
        await command(player, 'wait');
        await command(next, 'wait');
        await command(owner, 'release');
        const offer = await this.readSeat(claim.origin, player);
        assert.ok(offer?.status === 'offered');
        assert.equal((await this.readSeat(claim.origin, next))?.status, 'waiting');
        await requestJson(claim.origin, toApiMutationRequestPath(this.room + '/join', crypto.randomUUID()), {
            method: 'POST', session: player, body: { actorPrincipalId: player.clientId }
        });
        return offer;
    }

    private async measureOffset(phase: 'offer' | 'allocation') {
        const { claim, expiry, budgetMs } = this.input;
        try {
            const { calibration, enforcement } = await sampleNodeClockPair(claim, expiry);
            const offset = checkNodeClockOffset({ calibration, enforcement }, performance.now(), budgetMs);
            console.log(JSON.stringify({ kind: 'offset', timing: this.timing, phase, claim, expiry, ...offset, calibration, enforcement }));
            return offset.verdict === 'within';
        } catch (error) {
            console.log(JSON.stringify({ kind: 'offset', timing: this.timing, phase, verdict: 'unavailable', reason: String(error) }));
            return false;
        }
    }

    private async claimTime() {
        const { claim } = this.input;
        return (await sampleNode(claim.origin, claim.peerId)).remoteEpochMs;
    }

    private async waitForClaimTime(target: number) {
        await delay(Math.max(0, target - await this.claimTime()));
    }

    private async claimBeforeOrAfterDeadline(deadline: number, observer: ViewPushProofSocket) {
        const connectionGenerationId = await this.readClaimantGeneration();
        // The early claim leaves at once. The expiry node may take its whole idle ceiling to notice a command the claim
        // node enqueued, so a claim held back until shortly before the deadline can be answered after it.
        if (this.timing === 'after') await this.waitForClaimTime(deadline + 100);
        const after = await this.claimSeat(deadline, connectionGenerationId);
        await delay(Math.max(0, deadline + 100 - after));
        if (this.timing === 'after') await this.waitForPromotion(observer);
    }

    private async claimWithExpiryWakeHeld(deadline: number, offer: NonNullable<RoomLobbyAccountView['seat']>) {
        // Hold only this immutable offer's wake. The AppInbox workers must remain live to return the real claim disposition.
        const database = postgres(this.input.databaseUrl, { max: 1, connect_timeout: 5 });
        const { claim, player, next } = this.input;
        try {
            await database.begin(async transaction => {
                const wakes = await transaction`
                    select ri_resource_id from resource_inbox
                    where ri_topic_id = 'room-lobby.deadline'
                      and (ri_resource::jsonb->'payload'->>'resource')::jsonb->>'kind' = 'seat'
                      and (ri_resource::jsonb->'payload'->>'resource')::jsonb->'roomRef' =
                          ${transaction.json({ ...offer.roomRef })}
                      and (ri_resource::jsonb->'payload'->>'resource')::jsonb->>'dueAtEpochMs' = ${String(deadline)}
                    for update nowait
                `;
                assert.equal(wakes.length, 1, 'Hold exactly the durable wake for the original offer');
                assert.ok(await this.claimTime() < deadline, 'Acquire the offer wake before its deadline');
                await this.waitForClaimTime(deadline + 100);
                assert.ok(await this.claimTime() >= deadline);
                assert.deepEqual(await this.readSeat(claim.origin, player), offer);
                const successor = await this.readSeat(claim.origin, next);
                assert.equal(successor?.status, 'waiting');
                await this.claimSeat(deadline, await this.readClaimantGeneration());
                console.log(JSON.stringify({ kind: 'overdue-offer-refused', workspaceId: this.workspaceId, deadline,
                    claimPeer: claim.peerId, expiryPeer: this.input.expiry.peerId, priorOffer: offer, priorSuccessor: successor }));
            });
        } finally {
            await database.end();
        }
    }

    private async recoverOverdueOffer(deadline: number, offer: NonNullable<RoomLobbyAccountView['seat']>, observer: ViewPushProofSocket) {
        const { expiry, claim, player } = this.input;
        await withExpiryWorkerStopped(this.input, async () => {
            await assert.rejects(fetch(expiry.origin + '/api/time', { redirect: 'error', signal: AbortSignal.timeout(2_000) }),
                'The expiry worker must stop across the cutoff');
            await this.waitForClaimTime(deadline + 100);
            assert.ok(await this.claimTime() >= deadline);
            assert.deepEqual(await this.readSeat(claim.origin, player), offer);
        });
        await sampleNode(expiry.origin, expiry.peerId);
        // Only reads have run since stop. The restarted worker must promote the successor itself.
        await this.waitForPromotion(observer);
        console.log(JSON.stringify({ kind: 'worker-recovery', workspaceId: this.workspaceId, peerId: expiry.peerId, deadline }));
    }

    private async readClaimantGeneration() {
        const { claim, player } = this.input;
        const state = await requestJson(claim.origin, '/api/state' + this.scope + '/clients/' + encodeURIComponent(player.clientId),
            { method: 'GET', session: player, signal: AbortSignal.timeout(5_000) });
        const snapshot = parseAuthoritativeClientSnapshot(JSON.stringify(state), { applicationId: 'seat-qualification', workspaceId: this.workspaceId });
        const connected = snapshot.activeSessions.find(session => session.sessionId === player.sessionId);
        assert.ok(connected, 'The claimant must use its live connection generation');
        return connected.generationId;
    }

    private async claimSeat(deadline: number, connectionGenerationId: string) {
        const { claim, player } = this.input;
        const path = toApiMutationRequestPath(this.room + '/sessions/' + encodeURIComponent(player.sessionId), crypto.randomUUID());
        const before = await this.claimTime();
        const response = await fetch(claim.origin + path, {
            method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(5_000),
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + player.accessToken, 'x-client-id': player.clientId },
            body: JSON.stringify({ generationId: this.workspaceId, connectionGenerationId, publicationKey: null, principalId: player.clientId })
        });
        const after = await this.claimTime();
        const phase = classifyClaimReceipt({ before, after, deadline });
        const code = response.ok ? null : (await response.json()).code;
        await response.body?.cancel().catch(() => undefined);
        console.log(JSON.stringify({ kind: 'claim', timing: this.timing, workspaceId: this.workspaceId,
            deadline, before, after, phase, status: response.status, code }));
        assert.equal(phase, this.timing === 'before' ? 'before' : 'at-or-after', 'Claim did not bracket the intended side');
        assert.equal(response.status, this.timing === 'before' ? 200 : 403);
        if (response.status === 403) assert.equal(code, 'group-admission-closed');
        return after;
    }

    private async waitForPromotion(observer: ViewPushProofSocket) {
        const { claim, next } = this.input;
        // The observer opened before release. Its invalidation can arrive before the claim node projects the seat.
        await observer.waitForFrame(frame => {
            if (!hasViewInvalidatedTopic(frame)) return false;
            const hint = decodeViewInvalidationMessage(frame);
            return hint.resource === 'room-lobby' && hint.principalId === next.clientId &&
                hint.scope.workspaceId === this.workspaceId && hint.scope.applicationId === 'seat-qualification';
        });
        await waitForProofCondition(async () => (await this.readSeat(claim.origin, next))?.status === 'offered',
            'confirmed promotion on the claim node');
    }

    private async readFinalAllocation(origin: string) {
        const { player, next } = this.input;
        const [playerSeat, nextSeat] = await Promise.all([this.readSeat(origin, player), this.readSeat(origin, next)]);
        if (this.timing === 'before') {
            assert.equal(playerSeat?.status, 'present');
            assert.equal(nextSeat?.status, 'waiting');
        } else {
            assert.equal(playerSeat, null);
            assert.equal(nextSeat?.status, 'offered');
        }
        return { playerSeat, nextSeat };
    }

}

export async function qualifySeatDeadline(input: SeatDeadlineQualification) {
    const { claim, expiry, budgetMs } = input;
    assert.notEqual(claim.origin, expiry.origin, 'Need distinct direct origins');
    assert.notEqual(claim.peerId, expiry.peerId, 'Need distinct pinned clock identities');
    assert.ok(Number.isSafeInteger(budgetMs) && budgetMs >= 0);
    await sampleNodeClockPair(claim, expiry);
    let withinBudget = true;
    for (const timing of ['before', 'after', 'held-wake', 'restart'] as const) {
        const within = await new SeatDeadlineTrial(input, timing).run();
        withinBudget = withinBudget && within;
    }
    return { allocation: 'passed', clock: withinBudget ? 'within' : 'unqualified' } as const;
}
