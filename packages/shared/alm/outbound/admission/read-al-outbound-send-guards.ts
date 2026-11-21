import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALAdmissionReadSession } from '../../al-admission-work-backend.ts';
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALOutboundAdmissionReads } from './al-outbound-admission-reads.ts';

/** What a prepared send rechecks before its carrier runs: an ended or superseded message reads no receipt. */
export type ALOutboundSendGuards =
    | Readonly<{ kind: 'ended'; }>
    | Readonly<{ kind: 'superseded'; }>
    | Readonly<{ kind: 'current'; receiptState: ALOutboundPendingAckSnapshot | undefined; }>;

export async function readALOutboundSendGuards<TPrepared>(
    reads: ALOutboundAdmissionReads<TPrepared>,
    session: ALAdmissionReadSession,
    message: ALMessage
): Promise<ALOutboundSendGuards> {
    const stored = await reads.readStoredMessage(session, message.id.msgId);
    if (stored?.ended) {
        return { kind: 'ended' };
    }
    if (await reads.isStoredMessageSuperseded(session, message, stored)) {
        return { kind: 'superseded' };
    }
    const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
    return { kind: 'current', receiptState: await reads.readReceiptState(session, receipt) };
}
