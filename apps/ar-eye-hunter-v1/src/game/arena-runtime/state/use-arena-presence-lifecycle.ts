import {
    useCallback,
    useEffect,
    useMemo
} from 'react';
import type {
    Dispatch,
    RefObject,
    SetStateAction
} from 'react';

import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import {
    deriveArenaLinkState,
    deriveArenaPresenceNotices,
    toPresencePlayerSummaries,
    type ArenaLinkState,
    type ArenaPresenceNotice,
    type ArenaPresencePlayerSummary
} from '../../squadLink.ts';
import type { RemotePlayer, RtcLaneStatus } from '../../types.ts';
import type { ArenaConnectionState, ArenaTransportDiagnostics } from '../arena-connection-contracts.ts';

interface ArenaPresenceLifecycleInput {
    readonly connectionState: ArenaConnectionState;
    readonly directorStatus: RallarDirectorStatus;
    readonly isNetworkEnabled: () => boolean;
    readonly presenceDirectorLabelRef: RefObject<string | undefined>;
    readonly presenceInitializedRef: RefObject<boolean>;
    readonly presenceLinkRef: RefObject<ArenaLinkState | undefined>;
    readonly presenceNotices: readonly ArenaPresenceNotice[];
    readonly presencePlayersRef: RefObject<readonly ArenaPresencePlayerSummary[]>;
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly roomId: string | undefined;
    readonly rtcLanes: readonly RtcLaneStatus[];
    readonly session: AuthSession | undefined;
    readonly spectating: boolean;
    readonly setPresenceNotices: Dispatch<SetStateAction<readonly ArenaPresenceNotice[]>>;
    readonly transportDiagnostics: ArenaTransportDiagnostics;
}

export function useArenaPresenceLifecycle(input: ArenaPresenceLifecycleInput) {
    const {
        connectionState,
        isNetworkEnabled,
        remotePlayers,
        roomId,
        rtcLanes,
        session,
        setPresenceNotices,
        transportDiagnostics
    } = input;
    const linkPlayerCount = (session && roomId && !input.spectating ? 1 : 0) + remotePlayers.size;
    const linkState = useMemo(() =>
        deriveArenaLinkState({
            connectionState,
            networkEnabled: isNetworkEnabled(),
            roomSelected: Boolean(roomId),
            playerCount: linkPlayerCount,
            rtcLanes,
            wsTicketBackoffStatus: transportDiagnostics.wsTicketBackoff?.status
        }), [
        connectionState,
        isNetworkEnabled,
        linkPlayerCount,
        roomId,
        rtcLanes,
        transportDiagnostics.wsTicketBackoff?.status
    ]);
    const presencePlayers = useMemo(
        () =>
            toPresencePlayerSummaries(
                remotePlayers,
                (player) => (player as RemotePlayer).pose.username
            ),
        [remotePlayers]
    );
    useArenaPresenceTransitions(input, presencePlayers, linkState);
    useArenaPresenceExpiry(input);

    const dismissPresenceNotice = useCallback((id: string) => {
        setPresenceNotices((previous) => previous.filter((notice) => notice.id !== id));
    }, [setPresenceNotices]);

    return { dismissPresenceNotice, linkState };
}

function useArenaPresenceTransitions(
    input: ArenaPresenceLifecycleInput,
    presencePlayers: readonly ArenaPresencePlayerSummary[],
    linkState: ArenaLinkState
): void {
    const {
        directorStatus,
        presenceInitializedRef,
        presencePlayersRef,
        presenceLinkRef,
        presenceDirectorLabelRef,
        setPresenceNotices
    } = input;
    const directorNoticeLabel = directorStatus.isDirector
        ? 'you'
        : directorStatus.isFresh
        ? 'peer mode'
        : 'host changing';

    useEffect(() => {
        if (!presenceInitializedRef.current) {
            presenceInitializedRef.current = true;
            presencePlayersRef.current = presencePlayers;
            presenceLinkRef.current = linkState;
            presenceDirectorLabelRef.current = directorNoticeLabel;
            return;
        }

        const notices = deriveArenaPresenceNotices({
            previousPlayers: presencePlayersRef.current,
            nextPlayers: presencePlayers,
            previousLink: presenceLinkRef.current,
            nextLink: linkState,
            previousDirectorLabel: presenceDirectorLabelRef.current,
            nextDirectorLabel: directorNoticeLabel,
            nowEpochMs: Date.now()
        });
        presencePlayersRef.current = presencePlayers;
        presenceLinkRef.current = linkState;
        presenceDirectorLabelRef.current = directorNoticeLabel;
        if (notices.length > 0) {
            setPresenceNotices((previous) => [...previous, ...notices].slice(-5));
        }
    }, [
        directorNoticeLabel,
        linkState,
        presenceDirectorLabelRef,
        presenceInitializedRef,
        presenceLinkRef,
        presencePlayers,
        presencePlayersRef,
        setPresenceNotices
    ]);
}

function useArenaPresenceExpiry(input: ArenaPresenceLifecycleInput): void {
    const { presenceNotices, setPresenceNotices } = input;
    useEffect(() => {
        if (presenceNotices.length === 0) {
            return;
        }
        const interval = window.setInterval(() => {
            const now = Date.now();
            setPresenceNotices((previous) => previous.filter((notice) => now - notice.createdAtEpochMs < 6_500));
        }, 1_000);
        return () => window.clearInterval(interval);
    }, [presenceNotices.length, setPresenceNotices]);
}
