import type { RallarTypedMessageChannel } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRoomRealtimeJsonChannel } from '@shared-web/browser/rallar-realtime-facade.ts';
import { isAcceptedRealtimeSendResult } from '@shared-web/browser/realtime/browser-realtime-send-runtime.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

import { decodeTownMatchFrame, type TownMatchFrame } from './match-protocol.ts';

export namespace TownMatchTransport {
    export interface Dependencies {
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
        const live = frame.action.kind === 'controls' || frame.action.kind === 'poses';
        const wire = JSON.stringify(frame);
        const acceptedPeers = live ? await this.writeRealtime(frame, wire) : [];
        if (this.lifetime.signal.aborted) {
            return;
        }
        const missing = recipientPeerIds.filter((peerId) => !acceptedPeers.includes(peerId));
        if (live) {
            this.liveSend = missing.length === 0 ? 'rtc' : acceptedPeers.length > 0 ? 'mixed' : 'ws';
        }
        if (missing.length > 0) {
            const sent = await this.dependencies.reliable.sendWs(wire, {
                recipientPeerIds: missing,
                ttlMs: live ? 250 : 2000,
                reliability: 'best-effort',
                ack: 'none'
            });
            const delivery = sent.lifecycle();
            if (delivery.state === 'failed' || delivery.state === 'rejected') {
                throw new Error('Match traffic could not reach Rallar. Waiting to reconnect.');
            }
        }
    }

    stop(): void {
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
