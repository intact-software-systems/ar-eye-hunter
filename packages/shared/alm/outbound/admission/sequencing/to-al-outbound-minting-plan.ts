import type { ALMessage } from '../../../../al-contracts/al-contract.ts';
import type { ALOutboundDispatchPlan } from '../../al-outbound-message-runtime.ts';

/**
 * A room send that names its ordering key: its sender's outbound owns the track's sequence, minting the next one for a
 * send that states none and guarding a stated one against the head (S4-R6). A peer send carries no ordering.
 */
export function isALOutboundSequencedRoomSend(msg: ALMessage): boolean {
    const targets = msg.targets;
    const roomAudience = targets?.mode === 'multicast' ||
        (targets?.mode === 'broadcast' && (targets.scope === 'room' || targets.scope === 'principal') &&
            targets.groupRef !== undefined);
    return roomAudience && msg.ordering?.orderingKey !== undefined;
}

/**
 * The browser carriers' first admission of their own sequenced room send: it asks the outbound for the track's
 * sequence and runs on the durable lane whatever the message's durability, so the head and the sent positions outlive a
 * reload in the one store that holds them (P1: the lanes share no atomic commit). Any later plan keeps the policy its
 * admission captured; a dropping plan writes nothing.
 */
export function toALOutboundMintingPlan<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    stage: 'admission' | 'replan' | 'dequeue' | 'hand-over',
    selfPeerId: string
): ALOutboundDispatchPlan<TPrepared> {
    return stage !== 'admission' || plan.dropReasonCode !== undefined || plan.msg.id.senderId !== selfPeerId ||
            !isALOutboundSequencedRoomSend(plan.msg)
        ? plan
        : { ...plan, mintsSequence: true, lane: 'durable' };
}
