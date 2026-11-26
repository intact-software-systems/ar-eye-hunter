import type { RallarTypedMessageChannel } from '@shared-web/browser/rallar-core.ts';
import type { RallarRoomRealtimeJsonChannel } from '@shared-web/browser/rallar-realtime.ts';
import { isAcceptedRealtimeSendResult } from '@shared-web/browser/realtime/browser-realtime-send-runtime.ts';
import { isALDeliveryAdmitted, isALDeliveryTerminal } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

import { decodeTownMatchFrame, type TownMatchFrame } from '../match-protocol.ts';

export namespace TownMatchTransport {
    export interface Dependencies {
        readonly timers: Pick<Timers, 'nowMs'>;
        readonly reliable: Pick<RallarTypedMessageChannel<string>, 'sendWs' | 'onWs'>;
        readonly realtime: Pick<RallarRoomRealtimeJsonChannel<string>, 'send' | 'on'>;
    }
    export interface Reception {
        readonly frame: TownMatchFrame;
        readonly senderId: string;
        readonly targetRoomRef: GroupRef | undefined;
        readonly transport: 'rtc' | 'ws';
    }
    export type Receiver = (reception: Reception) => Promise<void>;
}

/** Game transport policy: expiring live frames prefer RTC; agreement always uses WS. */
export class TownMatchTransport {
    private readonly dependencies: TownMatchTransport.Dependencies;
    private readonly subscriptions = new SubscriptionScope();
    private readonly lifetime = new AbortController();
    private readonly retryAfter = new Map<string, number>();
    private liveSend: 'rtc' | 'ws' | 'mixed' | 'none' = 'none';

    constructor(dependencies: TownMatchTransport.Dependencies) {
        this.dependencies = dependencies;
    }

    getLiveSend(): 'rtc' | 'ws' | 'mixed' | 'none' {
        return this.liveSend;
    }

    start(receiver: TownMatchTransport.Receiver): void {
        this.subscriptions.add(this.dependencies.reliable.onWs(async (payload, message) => {
            const frame = decodeTownMatchFrame(payload).right;
            if (frame && !this.lifetime.signal.aborted) {
                await receiver({
                    frame,
                    senderId: message.senderId,
                    targetRoomRef: readALTargetGroupRef(message.raw),
                    transport: 'ws'
                });
            }
        }));
        this.subscriptions.add(this.dependencies.realtime.on(async (message) => {
            const frame = decodeTownMatchFrame(message.data).right;
            if (
                frame && !this.lifetime.signal.aborted &&
                (frame.action.kind === 'controls' || frame.action.kind === 'poses')
            ) {
                await receiver({ frame, senderId: message.peerId, targetRoomRef: frame.roomRef, transport: 'rtc' });
            }
        }));
    }

    async write(frame: TownMatchFrame, recipientPeerIds: readonly string[]): Promise<void> {
        if (this.lifetime.signal.aborted || recipientPeerIds.length === 0) {
            return;
        }
        const wire = JSON.stringify(frame);
        if (frame.action.kind !== 'controls' && frame.action.kind !== 'poses') {
            await this.writeAgreement(frame, wire, recipientPeerIds);
            return;
        }
        const acceptedPeers = await this.writeRealtime(frame, wire);
        if (this.lifetime.signal.aborted) return;
        const missing = recipientPeerIds.filter(peer => !acceptedPeers.includes(peer));
        this.liveSend = missing.length === 0 ? 'rtc' : acceptedPeers.length > 0 ? 'mixed' : 'ws';
        if (missing.length === 0) return;
        const sent = await this.sendWs(wire, missing, 250);
        const delivery = sent.lifecycle();
        if (delivery.state === 'failed' || delivery.state === 'rejected') {
            throw new Error('Match traffic could not reach Rallar. Waiting to reconnect.');
        }
    }

    /** Repeat a lost agreement at most once a second per peer; failed admissions can retry immediately. */
    private async writeAgreement(frame: TownMatchFrame, wire: string, recipients: readonly string[]): Promise<void> {
        const now = this.dependencies.timers.nowMs();
        for (const [key, deadline] of this.retryAfter) {
            if (deadline <= now) this.retryAfter.delete(key);
        }
        const action = frame.action;
        // ACK/commit/recovery envelopes have new send sequences even when they name the same checkpoint.
        const decision = 'proposalSequence' in action ? [action.proposalSequence, action.digest] : [frame.sequence];
        if (action.kind === 'recover') decision.push(action.checkpointEpoch, Number(action.committed));
        const retryAt = now + 1000;
        const reserved = new Map<string, string>();
        for (const peer of recipients) {
            const key = JSON.stringify([peer, frame.matchId, frame.epoch, action.kind, ...decision]);
            if (this.retryAfter.has(key)) continue;
            this.retryAfter.set(key, retryAt);
            reserved.set(key, peer);
        }
        if (reserved.size === 0) return;
        const release = () => {
            for (const key of reserved.keys()) {
                // A slow admission can settle after a newer retry has reserved the same peer.
                if (this.retryAfter.get(key) === retryAt) this.retryAfter.delete(key);
            }
        };
        try {
            const handle = await this.sendWs(wire, [...reserved.values()], 2000);
            const delivery = handle.lifecycle();
            if (isALDeliveryAdmitted(delivery)) return;
            if (isALDeliveryTerminal(delivery)) {
                throw new Error('Match traffic could not reach Rallar. Waiting to reconnect.');
            }
            // Admission can arrive after sendWs returns. Let the host continue ticking while it settles.
            void handle.wait({
                until: ['accepted', 'queued', 'transport-accepted', 'acknowledged'],
                timeoutMs: 2000,
                signal: this.lifetime.signal
            }).then(outcome => {
                if (!isALDeliveryAdmitted(outcome.lifecycle)) release();
            }, release);
        }
        catch (error) {
            release();
            throw error;
        }
    }

    private sendWs(wire: string, recipientPeerIds: readonly string[], ttlMs: number) {
        return this.dependencies.reliable.sendWs(wire, {
            recipientPeerIds,
            ttlMs,
            reliability: 'best-effort',
            ack: 'none'
        });
    }

    stop(): void {
        this.retryAfter.clear();
        this.lifetime.abort();
        this.subscriptions.unsubscribe();
    }

    private async writeRealtime(frame: TownMatchFrame, wire: string): Promise<readonly string[]> {
        try {
            const result = await this.dependencies.realtime.send(wire, {
                waitForReady: false,
                openTimeoutMs: 0,
                maxAgeMs: 100,
                key: JSON.stringify([frame.roomRef, frame.epoch, frame.matchId, frame.action.kind]),
                signal: this.lifetime.signal
            });
            return result.results.filter(isAcceptedRealtimeSendResult).map((peer) => peer.peerId);
        }
        catch {
            // A failed RTC attempt uses the same scoped frame on WS; the receiver deduplicates it.
            return [];
        }
    }
}
