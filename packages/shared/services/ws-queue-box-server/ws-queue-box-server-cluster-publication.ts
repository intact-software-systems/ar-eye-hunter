import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { toALOutboundCanonicalKey } from '../../alm/outbound/al-outbound-canonical-message.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundSettledSendResult
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import { EnqueuedType } from '../../api/api-config.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '../queue-box-utilities.ts';
import type { WsQueueBoxServerPreparedMessage } from './ws-queue-box-server-outbound-planning.ts';
import {
    isWsQueueBoxServerReceiptRow,
    toWsQueueBoxServerReceiptRepublishDelayMs
} from './ws-queue-box-server-receipt-row.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export namespace WsQueueBoxServerClusterPublication {
    /** Hands one durable outbox row to every other instance, and delivers it to this instance's own targets. */
    export type Publisher = (message: ALMessage, entry: ResourceEntry) => Promise<void>;

    export interface Dependencies {
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        /** The outbound owner's canonical scope, which locates the outbox row a publication names. */
        readonly canonicalScope: string;
        readonly clock: ALOutboundMessageRuntime.Clock;
    }

    export type ClusterPreparedMessage = Exclude<WsQueueBoxServerPreparedMessage, { kind: 'recipient'; }>;
}

/**
 * The cluster publisher a composition registers, and what the server publishes through it: every
 * dequeued outbox row once, except a receipt, which publishes itself from its own send attempts until
 * its origin has a session on this instance or the row expires at its deadline plus the receipt grace.
 */
export class WsQueueBoxServerClusterPublication {
    readonly #dependencies: WsQueueBoxServerClusterPublication.Dependencies;
    #publisher: WsQueueBoxServerClusterPublication.Publisher | undefined;

    constructor(dependencies: WsQueueBoxServerClusterPublication.Dependencies) {
        this.#dependencies = dependencies;
    }

    setPublisher(publisher: WsQueueBoxServerClusterPublication.Publisher): void {
        this.#publisher = publisher;
    }

    hasPublisher(): boolean {
        return this.#publisher !== undefined;
    }

    async writeDequeuedRow(message: ALMessage, entry: ResourceEntry): Promise<void> {
        if (!isWsQueueBoxServerReceiptRow(message)) {
            await this.#publisher?.(message, entry);
        }
    }

    async writePreparedMessage(
        prepared: WsQueueBoxServerClusterPublication.ClusterPreparedMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundSettledSendResult> {
        return prepared.kind === 'cluster-local-complete'
            ? { status: 'sent', submissionAttempted: true }
            : await this.writeReceiptRow(lifecycle.canonicalMessage);
    }

    /** The publisher also delivers to this instance, so a receipt whose origin is here now completes. */
    private async writeReceiptRow(message: ALMessage): Promise<ALOutboundSettledSendResult> {
        const originIsHere = this.#dependencies.targetResolution.resolveOutboundRecipients(message).length > 0;
        await this.#publisher?.(message, {
            ...QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX),
            key: toALOutboundCanonicalKey(this.#dependencies.canonicalScope, message)
        });
        return originIsHere ? { status: 'sent', submissionAttempted: true } : {
            status: 'not-ready',
            submissionAttempted: false,
            retryAfterMs: toWsQueueBoxServerReceiptRepublishDelayMs(message, this.#dependencies.clock.nowMs()),
            reason: 'WS receipt origin has no session on this instance'
        };
    }
}
