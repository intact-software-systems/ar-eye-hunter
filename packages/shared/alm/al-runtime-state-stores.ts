import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan, ALReceiptMode } from '../al-contracts/al-policy.ts';
import type { Key } from '../queuebox/ResourceEntry.ts';

export interface ALBufferedOrderedMessageSnapshot {
    readonly trackKey: string;
    readonly seq: number;
    readonly msg: ALMessage;
    readonly plan: ALMessageHandlingPlan;
}

export interface ALOutboundSentMessageSnapshot {
    readonly msgId: string;
    readonly msg: ALMessage;
    readonly outboxKey: Key | null;
    readonly supersedenceKey: string | null;
}

export interface ALOutboundPendingAckSnapshot {
    readonly msgId: string;
    /** Types both peer lists: next-hop ids under `hop` and `subtree`, logical recipient ids under `receiver`. */
    readonly mode: ALReceiptMode;
    readonly expectedPeerIds: readonly string[];
    readonly ackedPeerIds: readonly string[];
    /** Expected recipients that answered they are not in the audience: neither confirmed nor owed a retry. */
    readonly outsideAudiencePeerIds: readonly string[];
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly attempts: number;
    readonly deadlineAtMs: number;
}

export interface ALOutboundRepairAttemptSnapshot {
    readonly msgId: string;
    readonly attempts: number;
}

export interface ALOutboundNotYetInSyncRetrySnapshot {
    readonly msgId: string;
    readonly attempts: number;
    readonly pendingEffectId: string;
}
