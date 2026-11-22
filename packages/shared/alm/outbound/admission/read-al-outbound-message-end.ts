import type { ALAdmissionReadSession } from '../../al-admission-work-backend.ts';
import type { ALOutboundMessageEndRead } from '../message-end/to-al-outbound-message-end-bundle.ts';
import type { ALOutboundAdmissionReads } from './al-outbound-admission-reads.ts';

/**
 * What the end of one message marks and deletes, read without planning the message. A message with no stored row
 * reads nothing else: its row names the sender whose fence and receipt the end needs.
 */
export async function readALOutboundMessageEnd<TPrepared>(
    reads: ALOutboundAdmissionReads<TPrepared>,
    session: ALAdmissionReadSession,
    msgId: string
): Promise<ALOutboundMessageEndRead> {
    const senderId = (await reads.readStoredMessage(session, msgId))?.reference.senderId;
    if (senderId === undefined) {
        return { storedMessage: undefined, messageVersion: undefined };
    }
    const [clientRecord, messageVersion] = await Promise.all([
        reads.readClientRecord(session, senderId),
        reads.readMessageVersion(session, { originPeerId: senderId, msgId })
    ]);
    // Read after the versions that fence it, as `readRepairMessage` reads it, so they agree.
    const [storedMessage, pendingAck, firstHopWait] = await Promise.all([
        reads.readStoredMessage(session, msgId),
        reads.readPendingAck(session, { originPeerId: senderId, msgId }),
        reads.readFirstHopWait(session, msgId)
    ]);
    return { storedMessage, clientRecord, messageVersion, pendingAck, firstHopWait };
}
