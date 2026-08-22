import type { RtcLaneStatus } from './types.ts';

export type ArenaLinkTone = 'offline' | 'forming' | 'live' | 'degraded' | 'rejoining';

export type ArenaLinkState = Readonly<{
    tone: ArenaLinkTone;
    label: string;
    detail: string;
    playerCount: number;
    actionNeeded: boolean;
}>;

export type ArenaPresenceNoticeKind =
    | 'joined'
    | 'left'
    | 'link-forming'
    | 'link-live'
    | 'link-degraded'
    | 'host-change';

export type ArenaPresenceNotice = Readonly<{
    id: string;
    kind: ArenaPresenceNoticeKind;
    playerName?: string;
    message: string;
    createdAtEpochMs: number;
}>;

export type ArenaPresencePlayerSummary = Readonly<{
    sessionId: string;
    username: string;
}>;

export type ArenaLinkStateInput = Readonly<{
    connectionState: 'signed-out' | 'connecting' | 'connected' | 'error';
    networkEnabled: boolean;
    roomSelected: boolean;
    playerCount: number;
    rtcLanes: readonly RtcLaneStatus[];
    wsTicketBackoffStatus?: 'idle' | 'cooldown' | 'local-rate-limited' | 'circuit-open';
}>;

export type ArenaPresenceNoticeInput = Readonly<{
    previousPlayers: readonly ArenaPresencePlayerSummary[];
    nextPlayers: readonly ArenaPresencePlayerSummary[];
    previousLink?: ArenaLinkState;
    nextLink: ArenaLinkState;
    previousDirectorLabel?: string;
    nextDirectorLabel?: string;
    nowEpochMs: number;
}>;

export function deriveArenaLinkState(input: ArenaLinkStateInput): ArenaLinkState {
    const playerCount = Math.max(0, Math.floor(input.playerCount));
    if (input.connectionState === 'signed-out') {
        return {
            tone: 'offline',
            label: 'Offline preview',
            detail: 'Log in to join squad chaos.',
            playerCount,
            actionNeeded: true
        };
    }

    if (input.connectionState === 'error') {
        return {
            tone: 'degraded',
            label: 'Arena link shaky',
            detail: 'Connection needs attention.',
            playerCount,
            actionNeeded: true
        };
    }

    if (
        input.wsTicketBackoffStatus === 'cooldown' ||
        input.wsTicketBackoffStatus === 'local-rate-limited' ||
        input.wsTicketBackoffStatus === 'circuit-open'
    ) {
        return {
            tone: 'rejoining',
            label: 'Rejoining arena...',
            detail: 'Connection is cooling down before retry.',
            playerCount,
            actionNeeded: false
        };
    }

    if (input.connectionState === 'connecting' || !input.roomSelected || !input.networkEnabled) {
        return {
            tone: 'forming',
            label: 'Opening arena...',
            detail: input.roomSelected ? 'Syncing squad systems.' : 'Choose or create an arena.',
            playerCount,
            actionNeeded: !input.roomSelected
        };
    }

    if (playerCount <= 1) {
        return {
            tone: 'live',
            label: 'Solo arena',
            detail: 'No squadmates linked yet.',
            playerCount,
            actionNeeded: false
        };
    }

    const readyPeers = input.rtcLanes.reduce((sum, lane) => sum + lane.readyPeers, 0);
    const notReadyPeers = input.rtcLanes.reduce((sum, lane) => sum + lane.notReadyPeers, 0);
    const hasClosedLane = input.rtcLanes.some((lane) => lane.status === 'closed' || lane.status === 'unavailable');
    const hasPartialLane = input.rtcLanes.some((lane) => lane.status === 'partial');

    if (hasClosedLane && readyPeers === 0 && notReadyPeers > 0) {
        return {
            tone: 'degraded',
            label: 'Squad link shaky',
            detail: 'Some hunters may look delayed.',
            playerCount,
            actionNeeded: false
        };
    }

    if (hasPartialLane || notReadyPeers > 0 || readyPeers === 0) {
        return {
            tone: 'forming',
            label: 'Squad link forming',
            detail: 'Syncing squad movement.',
            playerCount,
            actionNeeded: false
        };
    }

    return {
        tone: 'live',
        label: `${playerCount} hunters linked`,
        detail: 'Movement is live.',
        playerCount,
        actionNeeded: false
    };
}

export function deriveArenaPresenceNotices(
    input: ArenaPresenceNoticeInput
): readonly ArenaPresenceNotice[] {
    const notices: ArenaPresenceNotice[] = [];
    const previousPlayers = new Map(input.previousPlayers.map((player) => [
        player.sessionId,
        player
    ]));
    const nextPlayers = new Map(input.nextPlayers.map((player) => [
        player.sessionId,
        player
    ]));

    for (const [sessionId, player] of nextPlayers) {
        if (!previousPlayers.has(sessionId)) {
            notices.push(createNotice(
                'joined',
                input.nowEpochMs,
                `${player.username} entered the arena`,
                sessionId,
                player.username
            ));
        }
    }

    for (const [sessionId, player] of previousPlayers) {
        if (!nextPlayers.has(sessionId)) {
            notices.push(createNotice(
                'left',
                input.nowEpochMs,
                `${player.username} lost signal`,
                sessionId,
                player.username
            ));
        }
    }

    if (input.previousLink && input.previousLink.tone !== input.nextLink.tone) {
        if (input.nextLink.tone === 'live' && input.nextLink.playerCount > 1) {
            notices.push(createNotice(
                'link-live',
                input.nowEpochMs,
                'Squad linked'
            ));
        }
        else if (input.nextLink.tone === 'forming') {
            notices.push(createNotice(
                'link-forming',
                input.nowEpochMs,
                'Squad link forming'
            ));
        }
        else if (
            input.nextLink.tone === 'degraded' ||
            input.nextLink.tone === 'rejoining'
        ) {
            notices.push(createNotice(
                'link-degraded',
                input.nowEpochMs,
                input.nextLink.label
            ));
        }
    }

    if (
        input.previousDirectorLabel &&
        input.nextDirectorLabel &&
        input.previousDirectorLabel !== input.nextDirectorLabel
    ) {
        notices.push(createNotice(
            'host-change',
            input.nowEpochMs,
            input.nextDirectorLabel === 'you' ? 'You run this arena' : 'Arena host is changing'
        ));
    }

    return notices;
}

export function toPresencePlayerSummaries(
    players: ReadonlyMap<string, unknown>,
    readUsername: (player: unknown) => string
): readonly ArenaPresencePlayerSummary[] {
    return [...players].map(([sessionId, player]) => ({
        sessionId,
        username: readUsername(player)
    }));
}

function createNotice(
    kind: ArenaPresenceNoticeKind,
    nowEpochMs: number,
    message: string,
    entityId: string = kind,
    playerName?: string
): ArenaPresenceNotice {
    return {
        id: `${kind}:${entityId}:${nowEpochMs}`,
        kind,
        playerName,
        message,
        createdAtEpochMs: nowEpochMs
    };
}
