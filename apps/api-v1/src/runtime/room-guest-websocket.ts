import { decodeStateSyncMessage } from '@shared-server/rallar-system/state-sync/state-sync-payload.ts';
import { type ALMessage, readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { validateJsonMessageSize } from '@shared/api/json-message-validation.ts';
import { decodeStateSnapshotPage, isStateSnapshotTopic } from '@shared/api/state-snapshot-page.ts';
import { RALLAR_CRDT_APP_TOPIC_ID, RALLAR_CRDT_ROOM_TOPIC_ID } from '@shared/crdt/crdt-types.ts';
import { decodeRtcSignalingEnvelope } from '@shared/webrtc/decode-rtc-signaling-message.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';
import { assertRoomGuestSeat, type RoomGuestRequest } from '@shared-server/http/room-guest-request.ts';
import { onGroupStateSnapshotChange } from '@shared/repository/group-state-snapshots-repository.ts';

const middlewareTopics = new Set<string>(Object.values(AppTopics));
const RECONCILE_MS = 2_000;

export function allowsGuestRoomFrame(
    message: ALMessage, direction: 'inbound' | 'outbound', guest: RoomGuestRequest, snapshot: GroupSnapshot, now: number
): boolean {
    const inbound = direction === 'inbound';
    if (inbound && message.id.senderId !== guest.sessionId) return false;
    const topic = message.route.topicId;
    if (topic === AppTopics.rtcSignaling) {
        const signal = decodeRtcSignalingEnvelope(message).right;
        if (!signal || (inbound ? signal.fromId : signal.toId) !== guest.sessionId) return false;
        const peerId = inbound ? signal.toId : signal.fromId;
        const peer = snapshot.activeSessions.find(row => row.sessionId === peerId && row.disconnectedAtEpochMs === null &&
            row.expiresAtEpochMs > now);
        if (!peer) return false;
        const member = snapshot.members.find(row => row.principalId === peer.principalId);
        if (!member || member.status !== 'active') return false;
        if (member.guestLease) {
            try { assertRoomGuestSeat({ roomRef: guest.roomRef, sessionId: peerId, clientId: member.principalId }, snapshot, now); }
            catch { return false; }
        }
        return true;
    }
    if (topic === RALLAR_CRDT_APP_TOPIC_ID || topic === RALLAR_CRDT_ROOM_TOPIC_ID ||
        message.payload.typeId === RALLAR_CRDT_APP_TOPIC_ID || message.payload.typeId === RALLAR_CRDT_ROOM_TOPIC_ID) return false;
    if (inbound && middlewareTopics.has(message.payload.typeId)) return false;
    if (middlewareTopics.has(topic) || isALControlTypeId(message.payload.typeId)) {
        if (inbound) return false;
        if (topic === AppTopics.clientStateEvent) {
            const sync = decodeStateSyncMessage(message);
            return sync.kind === 'decoded' && sync.payload.kind === 'client-event' &&
                sync.payload.event.principalId === guest.clientId && sync.payload.event.applicationId === guest.roomRef.applicationId &&
                sync.payload.event.workspaceId === guest.roomRef.workspaceId;
        }
        if (isStateSnapshotTopic(topic)) {
            const page = decodeStateSnapshotPage(message, guest.roomRef).right;
            return !!page && ((page.scope.kind === 'group' && page.scope.resourceId === guest.roomRef.groupId) ||
                (topic === AppTopics.clientStateSnapshot && page.scope.kind === 'principal' &&
                    page.scope.resourceId === guest.clientId));
        }
        if (topic !== AppTopics.groupStateEvent) return false;
    }
    const peerId = message.targets?.mode === 'unicast' ? message.targets.toPeerId : undefined;
    const target = readALTargetGroupRef(message);
    return target !== undefined && isSameGroupRef(target, guest.roomRef) &&
        (peerId === undefined || (inbound ? snapshot.activeSessions.some(row => row.sessionId === peerId &&
                row.disconnectedAtEpochMs === null && row.expiresAtEpochMs > now) : peerId === guest.sessionId));
}

function readFrame(value: unknown): ALMessage | undefined {
    if (typeof value !== 'string' || validateJsonMessageSize(value, AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes).left) return undefined;
    try { return decodeALMessageValue(JSON.parse(value)).right; }
    catch { return undefined; }
}

/** Room updates invalidate outgoing authority immediately. Missed notifications are bounded by a durable refresh. */
export class RoomGuestSocket {
    private snapshot: GroupSnapshot | undefined;
    private checkedAt = 0;
    private revision = 0;
    private refreshing: Promise<void> | undefined;
    private stopWatching: (() => void) | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private socket: ConnectionContext.Socket | undefined;

    private readonly guest: RoomGuestRequest;
    private readonly readSnapshot: (room: GroupRef) => Promise<GroupSnapshot | undefined>;
    private readonly now: () => number;

    constructor(guest: RoomGuestRequest, readSnapshot: (room: GroupRef) => Promise<GroupSnapshot | undefined>, now: () => number) {
        this.guest = guest;
        this.readSnapshot = readSnapshot;
        this.now = now;
    }

    async authorizeUpgrade(): Promise<boolean> {
        await this.refresh();
        return this.isLive();
    }

    wrap(socket: ConnectionContext.Socket): ConnectionContext.Socket {
        this.socket = socket;
        this.stopWatching = onGroupStateSnapshotChange(change => {
            if (!isSameGroupRef(change.groupRef, this.guest.roomRef)) return;
            if (change.snapshot) {
                try { assertRoomGuestSeat(this.guest, change.snapshot, this.now()); }
                catch {
                    this.snapshot = undefined;
                    this.socket?.close(1008, 'Guest membership ended');
                }
            } else {
                this.snapshot = undefined;
            }
            this.revision++;
            void this.refresh();
        });
        this.timer = setInterval(() => void this.refresh(), RECONCILE_MS / 2);
        return {
            get readyState() { return socket.readyState; },
            close: (code, reason) => socket.close(code, reason),
            send: text => {
                const frame = readFrame(text);
                return frame && this.isLive() && allowsGuestRoomFrame(frame, 'outbound', this.guest, this.snapshot!, this.now())
                    ? socket.send(text) : 0;
            }
        };
    }

    async allowsInbound(data: unknown): Promise<boolean> {
        const frame = readFrame(data);
        if (!frame) return false;
        await this.refresh();
        return this.isLive() && allowsGuestRoomFrame(frame, 'inbound', this.guest, this.snapshot!, this.now());
    }

    close(): void {
        this.revision++;
        this.snapshot = undefined;
        if (this.timer !== undefined) clearInterval(this.timer);
        this.stopWatching?.();
        this.socket = undefined;
    }

    private isLive(): boolean {
        if (!this.snapshot || this.now() - this.checkedAt >= RECONCILE_MS) return false;
        try {
            assertRoomGuestSeat(this.guest, this.snapshot, this.now());
            return true;
        } catch { return false; }
    }

    private refresh(): Promise<void> {
        if (this.refreshing) return this.refreshing;
        const revision = this.revision;
        const started = this.now();
        this.refreshing = this.readSnapshot(this.guest.roomRef).then(snapshot => {
            if (revision !== this.revision) return;
            if (snapshot) assertRoomGuestSeat(this.guest, snapshot, this.now());
            this.snapshot = snapshot;
            this.checkedAt = started;
            if (!snapshot) this.socket?.close(1008, 'Guest room access ended');
        }).catch(() => {
            if (revision !== this.revision) return;
            this.snapshot = undefined;
            this.socket?.close(1008, 'Guest room access unavailable');
        }).finally(() => { this.refreshing = undefined; });
        return this.refreshing;
    }
}
