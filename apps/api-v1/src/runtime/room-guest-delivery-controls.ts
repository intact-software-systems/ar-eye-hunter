import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';

/** Unscoped acknowledgments derive their authority from the room message they answer. */
export class RoomGuestDeliveryControls {
    private readonly deliveredOrigins = new Map<string, string>();
    private readonly submittedOrigins = new Map<string, string>();
    private readonly serverPeerId: string;
    private readonly sessionId: string;

    constructor(serverPeerId: string, sessionId: string) {
        this.serverPeerId = serverPeerId;
        this.sessionId = sessionId;
    }

    permits(frame: ALMessage, direction: 'inbound' | 'outbound'): boolean {
        const control = decodeALControlMessage(frame).right;
        if (!control) return false;
        const own = this.sessionId;
        if (control.type === 'receipt') {
            return direction === 'outbound' && frame.id.senderId === this.serverPeerId &&
                control.payload.originPeerId === own && this.submittedOrigins.has(control.payload.msgId);
        }
        const msgId = control.type === 'ack' ? control.payload.ackedMsgId : control.payload.msgId;
        const body = control.payload;
        if (direction === 'inbound') {
            const origin = this.deliveredOrigins.get(msgId);
            return origin !== undefined && frame.id.senderId === own && body.fromPeerId === own &&
                (body.toPeerId === this.serverPeerId || body.toPeerId === origin) &&
                (!('originPeerId' in body) || (body.originPeerId === origin && body.logicalRecipientPeerId === own));
        }
        return this.submittedOrigins.has(msgId) && body.toPeerId === own &&
            (!('originPeerId' in body) || body.originPeerId === own);
    }

    /** Unscoped delivery controls must refer to a message that crossed this room socket. */
    remember(direction: 'inbound' | 'outbound', frame: ALMessage): void {
        if (isALControlTypeId(frame.payload.typeId) || !frame.delivery ||
            (frame.delivery.reliability === 'best-effort' && frame.delivery.ack === 'none')) return;
        const origins = direction === 'inbound' ? this.submittedOrigins : this.deliveredOrigins;
        origins.set(frame.id.msgId, frame.id.senderId);
        if (origins.size > 1024) origins.delete(origins.keys().next().value!);
    }

}
