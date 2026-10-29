import type { RtcLaneStatus } from './arena-contracts.ts';

export type ArenaLinkTone = 'offline' | 'forming' | 'live' | 'degraded' | 'rejoining';

export interface ArenaLinkState {
    readonly tone: ArenaLinkTone;
    readonly label: string;
    readonly detail: string;
    readonly playerCount: number;
    readonly actionNeeded: boolean;
}

export type ArenaPresenceNoticeKind =
    | 'joined'
    | 'left'
    | 'link-forming'
    | 'link-live'
    | 'link-degraded'
    | 'host-change';

export interface ArenaPresenceNotice {
    readonly id: string;
    readonly kind: ArenaPresenceNoticeKind;
    readonly playerName?: string;
    readonly message: string;
    readonly createdAtEpochMs: number;
}

export interface ArenaPresencePlayerSummary {
    readonly sessionId: string;
    readonly username: string;
}

export interface ArenaLinkStateInput {
    readonly connectionState: 'signed-out' | 'connecting' | 'connected' | 'error';
    readonly networkEnabled: boolean;
    readonly roomSelected: boolean;
    readonly playerCount: number;
    readonly rtcLanes: readonly RtcLaneStatus[];
    readonly wsTicketBackoffStatus?: 'idle' | 'cooldown' | 'local-rate-limited' | 'circuit-open';
}

export interface ArenaPresenceNoticeInput {
    readonly previousPlayers: readonly ArenaPresencePlayerSummary[];
    readonly nextPlayers: readonly ArenaPresencePlayerSummary[];
    readonly previousLink?: ArenaLinkState;
    readonly nextLink: ArenaLinkState;
    readonly previousDirectorLabel?: string;
    readonly nextDirectorLabel?: string;
    readonly nowEpochMs: number;
}

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

    return deriveReadyArenaLink(input.rtcLanes, playerCount);
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
            notices.push(
                createNotice({
                    kind: 'joined',
                    nowEpochMs: input.nowEpochMs,
                    message: `${player.username} entered the arena`,
                    entityId: sessionId,
                    playerName: player.username
                })
            );
        }
    }

    for (const [sessionId, player] of previousPlayers) {
        if (!nextPlayers.has(sessionId)) {
            notices.push(
                createNotice({
                    kind: 'left',
                    nowEpochMs: input.nowEpochMs,
                    message: `${player.username} lost signal`,
                    entityId: sessionId,
                    playerName: player.username
                })
            );
        }
    }

    appendArenaLinkNotice(input, notices);

    if (
        input.previousDirectorLabel &&
        input.nextDirectorLabel &&
        input.previousDirectorLabel !== input.nextDirectorLabel
    ) {
        notices.push(
            createNotice({
                kind: 'host-change',
                nowEpochMs: input.nowEpochMs,
                message: input.nextDirectorLabel === 'you' ? 'You run this arena' : 'Arena host is changing'
            })
        );
    }

    return notices;
}

export function toPresencePlayerSummaries<T>(
    players: ReadonlyMap<string, T>,
    readUsername: (player: T) => string
): readonly ArenaPresencePlayerSummary[] {
    return [...players].map(([sessionId, player]) => ({
        sessionId,
        username: readUsername(player)
    }));
}

interface ArenaPresenceNoticeCreation {
    readonly kind: ArenaPresenceNoticeKind;
    readonly nowEpochMs: number;
    readonly message: string;
    readonly entityId?: string;
    readonly playerName?: string;
}

function createNotice(
    { kind, nowEpochMs, message, entityId = kind, playerName }: ArenaPresenceNoticeCreation
): ArenaPresenceNotice {
    return {
        id: `${kind}:${entityId}:${nowEpochMs}`,
        kind,
        playerName,
        message,
        createdAtEpochMs: nowEpochMs
    };
}
function deriveReadyArenaLink(rtcLanes: readonly RtcLaneStatus[], playerCount: number): ArenaLinkState {
    const readyPeers = rtcLanes.reduce((sum, lane) => sum + lane.readyPeers, 0);
    const notReadyPeers = rtcLanes.reduce((sum, lane) => sum + lane.notReadyPeers, 0);
    const hasClosedLane = rtcLanes.some((lane) => lane.status === 'closed' || lane.status === 'unavailable');
    const hasPartialLane = rtcLanes.some((lane) => lane.status === 'partial');

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
function appendArenaLinkNotice(input: ArenaPresenceNoticeInput, notices: ArenaPresenceNotice[]): void {
    if (input.previousLink && input.previousLink.tone !== input.nextLink.tone) {
        if (input.nextLink.tone === 'live' && input.nextLink.playerCount > 1) {
            notices.push(createNotice({ kind: 'link-live', nowEpochMs: input.nowEpochMs, message: 'Squad linked' }));
        }
        else if (input.nextLink.tone === 'forming') {
            notices.push(
                createNotice({ kind: 'link-forming', nowEpochMs: input.nowEpochMs, message: 'Squad link forming' })
            );
        }
        else if (
            input.nextLink.tone === 'degraded' ||
            input.nextLink.tone === 'rejoining'
        ) {
            notices.push(
                createNotice({ kind: 'link-degraded', nowEpochMs: input.nowEpochMs, message: input.nextLink.label })
            );
        }
    }
}
