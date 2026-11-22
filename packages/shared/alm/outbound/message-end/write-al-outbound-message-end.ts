import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import { toALOutboundMessageEndBundle } from './to-al-outbound-message-end-bundle.ts';

/**
 * What ending a message wrote: the stored row was marked ended, there was no row to mark (none in this store, one
 * already ended, or one whose retention ran out under the commit), or the sender's fence moved under the commit,
 * which names the message's deadline for the end retained as work.
 */
export type ALOutboundMessageEndOutcome =
    | Readonly<{ kind: 'ended' | 'nothing-to-end'; }>
    | Readonly<{ kind: 'conflict'; expiresAtMs: number; }>;

/**
 * Ends one message in a commit of its own with the bundle every terminal settlement commits, and states nothing:
 * the caller already stated the cancel, and a hand-over states none. A row already ended writes nothing again.
 */
export async function writeALOutboundMessageEnd<TPrepared>(
    admissionStore: ALOutboundAdmissionStore<TPrepared>,
    msgId: string
): Promise<ALOutboundMessageEndOutcome> {
    const read = await admissionStore.readMessageEnd(msgId);
    const stored = read.storedMessage;
    if (stored === undefined || stored.ended) {
        return { kind: 'nothing-to-end' };
    }
    const status = await admissionStore.commitBundle(toALOutboundMessageEndBundle<TPrepared>({
        senderId: stored.reference.senderId,
        msgId,
        stored,
        expectedVersion: read.clientRecord?.version,
        messageVersion: read.messageVersion,
        openReceipt: read.pendingAck,
        firstHopWait: read.firstHopWait
    }));
    if (status === 'conflict') {
        return { kind: 'conflict', expiresAtMs: stored.reference.expiresAtMs };
    }
    return { kind: status === 'committed' ? 'ended' : 'nothing-to-end' };
}
