import { assertRoomGuestSeat, type RoomGuestRequest } from '@shared-server/http/room-guest-request.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { validateJsonMessageSize } from '@shared/api/json-message-validation.ts';
import { onGroupStateSnapshotChange } from '@shared/repository/group-state-snapshots-repository.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';
import { RoomGuestDeliveryControls } from './room-guest-delivery-controls.ts';
import { allowsGuestRoomFrame } from './room-guest-frame-policy.ts';

const RECONCILE_MS = 2_000;

function readFrame(value: string): ALMessage | undefined {
    if (validateJsonMessageSize(value, AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes).left) return undefined;
    try { return decodeALMessageValue(JSON.parse(value)).right; }
    catch { return undefined; }
}

export namespace RoomGuestSocket {
    export interface Input {
        readonly guest: RoomGuestRequest;
        readonly readSnapshot: (room: GroupRef) => Promise<GroupSnapshot | undefined>;
        readonly now: () => number;
        readonly serverPeerId: string;
    }
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

    private readonly controls: RoomGuestDeliveryControls;
    private readonly guest: RoomGuestRequest;
    private readonly readSnapshot: RoomGuestSocket.Input['readSnapshot'];
    private readonly now: () => number;

    constructor({ guest, readSnapshot, now, serverPeerId }: RoomGuestSocket.Input) {
        this.controls = new RoomGuestDeliveryControls(serverPeerId, guest.sessionId);
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
                try {
                    assertRoomGuestSeat(this.guest, change.snapshot, this.now());
                    this.snapshot = change.snapshot;
                }
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
                if (!frame || !this.permits(frame, 'outbound')) return 0;
                const written = socket.send(text);
                if (written !== 0) this.controls.remember('outbound', frame);
                return written;
            }
        };
    }

    async allowsInbound(data: string): Promise<boolean> {
        const frame = readFrame(data);
        if (!frame) return false;
        if (!this.isLive()) await this.refresh();
        if (!this.permits(frame, 'inbound')) return false;
        this.controls.remember('inbound', frame);
        return true;
    }

    close(): void {
        this.revision++;
        this.snapshot = undefined;
        if (this.timer !== undefined) clearInterval(this.timer);
        this.stopWatching?.();
        this.socket = undefined;
    }

    private permits(frame: ALMessage, direction: 'inbound' | 'outbound'): boolean {
        if (!this.isLive() || !this.snapshot) return false;
        if (!isALControlTypeId(frame.payload.typeId)) {
            return allowsGuestRoomFrame(frame, { direction, guest: this.guest, snapshot: this.snapshot, now: this.now() });
        }
        return this.controls.permits(frame, direction);
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
