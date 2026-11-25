import { resolveRoomGuestSeat, type RoomGuestRequest } from '@shared-server/http/room-guest-request.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { validateJsonMessageSize } from '@shared/api/json-message-validation.ts';
import { onGroupStateSnapshotChange } from '@shared/repository/group-state-snapshots-repository.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';
import { RoomGuestDeliveryControls } from './room-guest-delivery-controls.ts';
import { allowsGuestRoomFrame } from './room-guest-frame-policy.ts';

const RECONCILE_MS = 2_000;
const ROOM_SNAPSHOT_READ = 'room-snapshot';

function readFrame(value: string): ALMessage | undefined {
    if (validateJsonMessageSize(value, AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes).left) {
        return undefined;
    }
    try {
        return decodeALMessageValue(JSON.parse(value)).right;
    }
    catch {
        return undefined;
    }
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
    private closed = false;
    private stopWatching: (() => void) | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private socket: ConnectionContext.Socket | undefined;

    /** One durable read per socket; each flight answers the room revision it began at. */
    private readonly reads = new SingleFlight<typeof ROOM_SNAPSHOT_READ, number>();
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
        this.stopWatching = onGroupStateSnapshotChange((change) => {
            if (!isSameGroupRef(change.groupRef, this.guest.roomRef)) {
                return;
            }
            this.revision++;
            if (change.snapshot && !this.seats(change.snapshot)) {
                this.snapshot = undefined;
                this.socket?.close(1008, 'Guest membership ended');
            }
            else {
                this.snapshot = change.snapshot;
            }
            void this.refresh();
        });
        this.timer = setInterval(() => void this.refresh(), RECONCILE_MS / 2);
        return {
            get readyState() {
                return socket.readyState;
            },
            close: (code, reason) => socket.close(code, reason),
            acceptsOutbound: (text) => {
                const frame = readFrame(text);
                return frame !== undefined && this.permits(frame, 'outbound');
            },
            send: (text) => {
                const frame = readFrame(text);
                if (!frame || !this.permits(frame, 'outbound')) {
                    return 0;
                }
                const written = socket.send(text);
                if (written !== 0) {
                    this.controls.remember('outbound', frame);
                }
                return written;
            }
        };
    }

    async allowsInbound(data: string): Promise<boolean> {
        const frame = readFrame(data);
        if (!frame) {
            return false;
        }
        if (!this.isLive()) {
            await this.refresh();
        }
        if (!this.permits(frame, 'inbound')) {
            return false;
        }
        this.controls.remember('inbound', frame);
        return true;
    }

    close(): void {
        this.closed = true;
        this.revision++;
        this.snapshot = undefined;
        if (this.timer !== undefined) {
            clearInterval(this.timer);
        }
        this.stopWatching?.();
        this.socket = undefined;
    }

    private permits(frame: ALMessage, direction: 'inbound' | 'outbound'): boolean {
        if (!this.isLive() || !this.snapshot) {
            return false;
        }
        if (!isALControlTypeId(frame.payload.typeId)) {
            return allowsGuestRoomFrame(frame, {
                direction,
                guest: this.guest,
                snapshot: this.snapshot,
                now: this.now()
            });
        }
        return this.controls.permits(frame, direction);
    }

    private isLive(): boolean {
        return this.snapshot !== undefined && this.now() - this.checkedAt < RECONCILE_MS && this.seats(this.snapshot);
    }

    private seats(snapshot: GroupSnapshot): boolean {
        return resolveRoomGuestSeat(this.guest, snapshot, this.now()) !== 'expired';
    }

    /**
     * Settles once a read that began after the latest room change has settled. Callers that wake from the same stale
     * read join one follow-up read, because the settled flight is forgotten before any caller resumes.
     */
    private async refresh(): Promise<void> {
        let readRevision = await this.reads.run(ROOM_SNAPSHOT_READ, () => this.readAuthorization());
        while (!this.closed && readRevision !== this.revision) {
            readRevision = await this.reads.run(ROOM_SNAPSHOT_READ, () => this.readAuthorization());
        }
    }

    /** Answers the room revision the read began at; a read from an older revision changes nothing. */
    private async readAuthorization(): Promise<number> {
        const revision = this.revision;
        const startedAt = this.now();
        let snapshot: GroupSnapshot | undefined;
        try {
            snapshot = await this.readSnapshot(this.guest.roomRef);
        }
        catch {
            // A failed read says nothing about the seat: the cached authorization ages out and the next refresh retries.
            return revision;
        }
        if (revision !== this.revision) {
            return revision;
        }
        if (!snapshot || !this.seats(snapshot)) {
            this.snapshot = undefined;
            this.socket?.close(1008, 'Guest room access ended');
            return revision;
        }
        this.snapshot = snapshot;
        this.checkedAt = startedAt;
        return revision;
    }
}
