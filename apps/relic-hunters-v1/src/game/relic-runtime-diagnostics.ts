import type { RelicPublicSnapshot, RelicRoundTransitionEvent } from '@relic-hunters/mod.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import type { ALDeliveryState } from '@shared-web/browser/rallar.ts';
import type { RallarGameAuthorityClientStatus } from '@shared/rallar-game/mod.ts';
import type { RelicHuntersRuntime, RelicHuntersRuntimePhase } from './relic-hunters-runtime.ts';
import type { RelicSnapshotRejectionReason, RelicSnapshotSource } from './relic-snapshot-ordering.ts';

export const RELIC_SNAPSHOT_TRANSPORT = 'rallar-ws+rtc';

export type RelicCommandTransport = 'ws' | 'rest';

export interface RelicRuntimeDiagnostics {
    readonly phase: RelicHuntersRuntimePhase;
    readonly commandTransport: RelicCommandTransport;
    readonly lastCommandDelivery: ALDeliveryState | undefined;
    readonly snapshotTransport: typeof RELIC_SNAPSHOT_TRANSPORT;
    readonly authenticated: boolean;
    readonly middlewareConnected: boolean;
    readonly roomReady: boolean;
    readonly snapshotReady: boolean;
    readonly wsListenerReady: boolean;
    readonly roomListenerReady: boolean;
    readonly rtcReady: boolean;
    readonly authorityReady: boolean;
    readonly authorityPhase: RallarGameAuthorityClientStatus['phase'] | undefined;
    readonly authorityPeerAssistReadyPeers: number;
    readonly roomId: string | undefined;
    readonly commandInFlight: string | undefined;
    readonly ignoredSnapshotCount: number;
    readonly lastSnapshotSource: RelicSnapshotSource | undefined;
    readonly lastAcceptedSnapshot: RelicRuntimeSnapshotSummary | undefined;
    readonly lastIgnoredSnapshotReason: RelicSnapshotRejectionReason | undefined;
    readonly lastIgnoredSnapshot: RelicRuntimeSnapshotSummary | undefined;
    readonly lastHydratedAtEpochMs: number | undefined;
    readonly roundTransitionCues: readonly string[];
    readonly lastError: string | undefined;
}

export interface RelicRuntimeSnapshotSummary {
    readonly source: RelicSnapshotSource;
    readonly gameId: string;
    readonly roomId: string;
    readonly phase: string;
    readonly round: number;
    readonly updatedAtEpochMs: number;
    readonly playerCount: number;
    readonly submittedCount: number;
    readonly eventCount: number;
    readonly roomInvestigationCount: number;
}

export function createInitialRelicRuntimeDiagnostics(session: AuthSession | undefined): RelicRuntimeDiagnostics {
    return {
        phase: session ? 'connecting' : 'signed-out',
        commandTransport: 'ws',
        lastCommandDelivery: undefined,
        snapshotTransport: RELIC_SNAPSHOT_TRANSPORT,
        authenticated: !!session,
        middlewareConnected: false,
        roomReady: false,
        snapshotReady: false,
        wsListenerReady: false,
        roomListenerReady: false,
        rtcReady: false,
        authorityReady: false,
        authorityPhase: undefined,
        authorityPeerAssistReadyPeers: 0,
        roomId: undefined,
        commandInFlight: undefined,
        ignoredSnapshotCount: 0,
        lastSnapshotSource: undefined,
        lastAcceptedSnapshot: undefined,
        lastIgnoredSnapshotReason: undefined,
        lastIgnoredSnapshot: undefined,
        lastHydratedAtEpochMs: undefined,
        roundTransitionCues: [],
        lastError: undefined
    };
}

export function toRelicRuntimeSnapshotSummary(
    snapshot: RelicPublicSnapshot,
    source: RelicSnapshotSource
): RelicRuntimeSnapshotSummary {
    return {
        source,
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        phase: snapshot.phase,
        round: snapshot.round,
        updatedAtEpochMs: snapshot.updatedAtEpochMs,
        playerCount: snapshot.players.length,
        submittedCount: snapshot.submittedPlayerIds.length,
        eventCount: snapshot.events.length,
        roomInvestigationCount: snapshot.roomInvestigations.length
    };
}

export function toRelicRoomDiagnostics(
    state: RelicHuntersRuntime.Connection,
    authority: RallarGameAuthorityClientStatus | undefined,
    connected = state.diagnostics.middlewareConnected
): Partial<RelicRuntimeDiagnostics> {
    const roomReady = !!state.roomId;
    return {
        roomId: state.roomId,
        roomReady,
        snapshotReady: !!state.snapshot,
        rtcReady: connected && roomReady,
        authorityReady: connected && roomReady && !!authority?.started,
        authorityPhase: authority?.phase,
        authorityPeerAssistReadyPeers: authority?.peerAssist.readyPeerIds.length ?? 0
    };
}

export interface AcceptedRelicSnapshotDiagnosticsInput {
    readonly state: RelicHuntersRuntime.Connection;
    readonly authority: RallarGameAuthorityClientStatus | undefined;
    readonly snapshot: RelicPublicSnapshot;
    readonly source: RelicSnapshotSource;
    readonly nowEpochMs: number;
}

export function toAcceptedRelicSnapshotDiagnostics(
    { state, authority, snapshot, source, nowEpochMs }: AcceptedRelicSnapshotDiagnosticsInput
): RelicRuntimeDiagnostics {
    return {
        ...state.diagnostics,
        ...toRelicRoomDiagnostics(state, authority),
        snapshotReady: true,
        lastSnapshotSource: source,
        lastAcceptedSnapshot: toRelicRuntimeSnapshotSummary(snapshot, source),
        lastIgnoredSnapshotReason: undefined,
        lastIgnoredSnapshot: undefined,
        lastHydratedAtEpochMs: nowEpochMs
    };
}

export interface IgnoredRelicSnapshotDiagnosticsInput {
    readonly diagnostics: RelicRuntimeDiagnostics;
    readonly snapshot: RelicPublicSnapshot;
    readonly source: RelicSnapshotSource;
    readonly reason: RelicSnapshotRejectionReason;
}

export function toIgnoredRelicSnapshotDiagnostics(
    { diagnostics, snapshot, source, reason }: IgnoredRelicSnapshotDiagnosticsInput
): Partial<RelicRuntimeDiagnostics> {
    return {
        ignoredSnapshotCount: diagnostics.ignoredSnapshotCount + 1,
        lastIgnoredSnapshotReason: reason,
        lastIgnoredSnapshot: toRelicRuntimeSnapshotSummary(snapshot, source)
    };
}

/** Retain a bounded presentation history alongside the other runtime observations. */
export function toRelicRoundTransitionDiagnostics(
    diagnostics: RelicRuntimeDiagnostics,
    event: RelicRoundTransitionEvent
): RelicRuntimeDiagnostics {
    return {
        ...diagnostics,
        roundTransitionCues: [...diagnostics.roundTransitionCues, `${event.round}:${event.transition}`].slice(-16)
    };
}
