import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import type { RallarRoomSession, RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { readRoomMembershipRevocation } from '@shared-web/browser/rooms/read-room-membership-revocation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';
import { useEffect, useState } from 'react';

export interface RoomModerationStateInput {
    readonly session: AuthSession;
    readonly accessCheckIntervalMs: number;
    readonly rooms: Pick<BrowserRallarRooms, 'state' | 'onChange'> & {
        session(room: GroupRef): Pick<RallarRoomSession, 'refresh'>;
    };
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
        let controller = new AbortController();
        const observeRoomState = (next: RallarRoomState): void => {
            const previous = selected;
            const current = next.currentRoomRef;
            const changed = previous ? !current || !isSameGroupRef(previous, current) : !!current;
            if (changed) {
                controller.abort();
                controller = new AbortController();
            }
            selected = current;
            if (current && changed) {
                setNotice(null);
            }
            if (previous && !current) {
                const revoked = next.rooms.find((room) => isSameGroupRef(room.roomRef, previous))?.snapshot.members
                    .find((member) => member.principalId === props.session.clientId)?.status;
                if (revoked === 'banned' || revoked === 'removed') {
                    setNotice(`You were ${revoked} from room ${previous.groupId}. Choose another room.`);
                }
                else {
                    // Collection repair may remove the snapshot before a revoked roster arrives.
                    void checkCurrentRoomAccess({ props, room: previous, signal: controller.signal, setNotice });
                }
            }
            setState(next);
        };
        const unsubscribe = props.rooms.onChange(observeRoomState);
        const stop = startRepeating({
            timers: createDefaultTimers(),
            intervalMs: props.accessCheckIntervalMs,
            firstRun: 'after-interval',
            run: () =>
                selected
                    ? checkCurrentRoomAccess({ props, room: selected, signal: controller.signal, setNotice })
                    : undefined
        });
        return () => {
            controller.abort();
            unsubscribe();
            stop();
        };
    }, [props.rooms, props.session.clientId, props.session.sessionId, props.accessCheckIntervalMs]);
    return { state, notice };
}

interface CheckCurrentRoomAccessInput {
    readonly props: RoomModerationStateInput;
    readonly room: GroupRef;
    readonly signal: AbortSignal;
    readonly setNotice: (notice: string) => void;
}

async function checkCurrentRoomAccess({ props, room, signal, setNotice }: CheckCurrentRoomAccessInput): Promise<void> {
    try {
        await props.rooms.session(room).refresh({ signal, timeoutMs: props.accessCheckIntervalMs });
    }
    catch (error) {
        if (signal.aborted) {
            return;
        }
        const revoked = readRoomMembershipRevocation(error);
        if (revoked && !props.rooms.state().currentRoomRef) {
            setNotice(`You were ${revoked} from room ${room.groupId}. Choose another room.`);
        }
    }
}
