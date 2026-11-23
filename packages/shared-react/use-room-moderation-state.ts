import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { RoomAccessObservation } from '@shared-web/browser/state-read/watch-room-access.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { useEffect, useState } from 'react';

export interface RoomModerationStateInput {
    readonly session: AuthSession;
    readonly rooms: Pick<BrowserRallarRooms, 'onChange' | 'watchAccess'>;
}

interface RoomModerationObservation {
    readonly state: RallarRoomState | undefined;
    readonly notice: string | null;
}

export function useRoomModerationState(props: RoomModerationStateInput): RoomModerationObservation {
    const [state, setState] = useState<RallarRoomState>();
    const [notice, setNotice] = useState<string | null>(null);
    useEffect(() => {
        let selected: GroupRef | undefined;
        let watch: AbortController | undefined;
        let lastStatus: RoomAccessObservation['status'] = 'stale';

        function observeAccess(room: GroupRef): void {
            const lifetime = new AbortController();
            watch = lifetime;
            lastStatus = 'stale';
            props.rooms.watchAccess(room, access => {
                if (lifetime.signal.aborted) return;
                lastStatus = access.status;
                if (access.status === 'stale') return;
                if (access.status === 'denied' && access.reason !== 'unavailable') {
                    setNotice(`You were ${access.reason} from room ${room.groupId}. Choose another room.`);
                }
                if (!selected) lifetime.abort();
            }, { signal: lifetime.signal });
        }

        const unsubscribe = props.rooms.onChange(next => {
            setState(next);
            const previous = selected;
            const current = next.currentRoomRef;
            if (previous && current && isSameGroupRef(previous, current)) return;
            if (!previous && !current) return;
            selected = current;
            if (current) {
                watch?.abort();
                setNotice(null);
                observeAccess(current);
            } else if (previous) {
                const member = next.rooms.find(room => isSameGroupRef(room.roomRef, previous))?.snapshot.members
                    .find(row => row.principalId === props.session.clientId);
                if (member?.status === 'banned' || member?.status === 'removed') {
                    watch?.abort();
                    setNotice(`You were ${member.status} from room ${previous.groupId}. Choose another room.`);
                } else if (lastStatus === 'current') {
                    // Collection repair cleared the room without a pending access read. Recheck it once.
                    watch?.abort();
                    observeAccess(previous);
                } else if (lastStatus === 'denied') {
                    watch?.abort();
                }
            }
        });
        return () => {
            watch?.abort();
            unsubscribe();
        };
    }, [props.rooms, props.session.clientId, props.session.sessionId]);
    return { state, notice };
}
