import {
    useEffect,
    useRef,
    useState,
    type RefObject
} from 'react';

import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toScopedRoomKey } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';

export interface RoomHostingCode {
    readonly sessionKey: string;
    readonly response: GroupJoinCodeResponse;
}

export type RoomHostingPending =
    | { readonly kind: 'creating'; readonly sessionKey: string; }
    | { readonly kind: 'rotating'; readonly sessionKey: string; readonly room: GroupRef; };

export interface RoomHostingState {
    readonly busy: boolean;
    readonly code: GroupJoinCodeResponse | undefined;
    readonly error: string | undefined;
    readonly pendingOperation: RefObject<RoomHostingPending | undefined>;
    readonly setPending: (pending: RoomHostingPending | undefined) => void;
    readonly setError: (error: string | undefined) => void;
    readonly setCode: (code: RoomHostingCode | undefined) => void;
}

export interface RoomHostingIdentity {
    readonly session: AuthSession | undefined;
    readonly roomId: string | undefined;
    readonly snapshot: GroupSnapshot | undefined;
}

export function useRoomHostingState(identity: RoomHostingIdentity): RoomHostingState {
    const [pending, setPending] = useState<RoomHostingPending | undefined>();
    const pendingOperation = useRef<RoomHostingPending | undefined>(undefined);
    const [error, setError] = useState<string | undefined>();
    const [code, setCode] = useState<RoomHostingCode | undefined>();
    const sessionKey = identity.session ? toAuthSessionKey(identity.session) : undefined;
    const roomKey = identity.snapshot ? toScopedRoomKey(identity.snapshot.group) : undefined;
    useEffect(() => {
        setCode((current) =>
            current && current.sessionKey === sessionKey &&
                matchesHostingRoom(current.response.snapshot.group, identity)
                ? current
                : undefined
        );
        const active = pendingOperation.current;
        if (
            active && (active.sessionKey !== sessionKey ||
                active.kind === 'rotating' && !matchesHostingRoom(active.room, identity))
        ) {
            pendingOperation.current = undefined;
            setPending(undefined);
        }
        setError(undefined);
    }, [sessionKey, identity.roomId, roomKey]);
    useEffect(() => () => {
        pendingOperation.current = undefined;
    }, []);
    return {
        busy: pending !== undefined && pending.sessionKey === sessionKey &&
            (pending.kind === 'creating' || matchesHostingRoom(pending.room, identity)),
        code: code && code.sessionKey === sessionKey && matchesHostingRoom(code.response.snapshot.group, identity)
            ? code.response
            : undefined,
        error,
        pendingOperation,
        setPending,
        setError,
        setCode
    };
}

function matchesHostingRoom(room: GroupRef, identity: RoomHostingIdentity): boolean {
    return (identity.roomId === undefined || room.groupId === identity.roomId) &&
        (!identity.snapshot || isSameGroupRef(room, identity.snapshot.group));
}
