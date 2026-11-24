import type { RoomGuestRequest } from '@shared-server/http/room-guest-request.ts';
import { type ALMessage, readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import { RALLAR_CRDT_APP_TOPIC_ID, RALLAR_CRDT_ROOM_TOPIC_ID } from '@shared/crdt/crdt-types.ts';
import { decodeRtcSignalingEnvelope } from '@shared/webrtc/decode-rtc-signaling-message.ts';
import { allowsGuestStateSync } from './room-guest-state-sync.ts';

const middlewareTopics = new Set<string>(Object.values(AppTopics));
const crdtTopics = new Set<string>([RALLAR_CRDT_APP_TOPIC_ID, RALLAR_CRDT_ROOM_TOPIC_ID]);

export interface GuestRoomFrameContext {
    readonly direction: 'inbound' | 'outbound';
    readonly guest: RoomGuestRequest;
    readonly snapshot: GroupSnapshot;
    readonly now: number;
}

export function allowsGuestRoomFrame(message: ALMessage, context: GuestRoomFrameContext): boolean {
    const { direction, guest, snapshot, now } = context;
    const inbound = direction === 'inbound';
    if (inbound && message.id.senderId !== guest.sessionId) return false;
    const topic = message.route.topicId;
    if (topic === AppTopics.rtcSignaling) {
        const signal = decodeRtcSignalingEnvelope(message).right;
        if (!signal || (inbound ? signal.fromId : signal.toId) !== guest.sessionId) return false;
        const peerId = inbound ? signal.toId : signal.fromId;
        return isLiveRoomPeer(snapshot, peerId, now);
    }
    if (crdtTopics.has(topic) || crdtTopics.has(message.payload.typeId)) return false;
    if (inbound && middlewareTopics.has(message.payload.typeId)) return false;
    if (middlewareTopics.has(topic) || isALControlTypeId(message.payload.typeId)) {
        if (inbound) return false;
        if (topic !== AppTopics.groupStateEvent) return allowsGuestStateSync(message, guest);
    }
    if (message.targets?.mode === 'broadcast' && message.targets.scope === 'principal') return false;
    const peerId = message.targets?.mode === 'unicast' ? message.targets.toPeerId : undefined;
    const target = readALTargetGroupRef(message);
    return target !== undefined && isSameGroupRef(target, guest.roomRef) &&
        (peerId === undefined || (inbound ? isLiveRoomPeer(snapshot, peerId, now) : peerId === guest.sessionId));
}

function isLiveRoomPeer(snapshot: GroupSnapshot, sessionId: string, now: number): boolean {
    const peer = snapshot.activeSessions.find(row => row.sessionId === sessionId &&
        row.disconnectedAtEpochMs === null && row.expiresAtEpochMs > now);
    const member = peer && snapshot.members.find(row => row.principalId === peer.principalId);
    return member?.status === 'active' && (!member.guestLease || roomGuestAccessMode(snapshot.group, member, now) !== 'expired');
}

