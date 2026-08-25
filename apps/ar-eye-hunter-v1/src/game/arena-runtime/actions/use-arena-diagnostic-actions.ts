import { readWebSocketTicketBackoffState } from '@shared-web/browser/auth/websocket-ticket-http-api.ts';
import { readApiConfig, readIceCandidates } from '@shared-web/browser/connection/connection-http-api.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import { GAME_SNAPSHOT_LANE_ID } from '../../rallar-game-match-adapter.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaPresenceNotice } from '../../squadLink.ts';
import { GAME_AI_LANE_ID, GAME_COMBAT_LANE_ID, GAME_FX_LANE_ID, GAME_MOTION_LANE_ID } from '../../types.ts';
import type { RtcLaneStatus } from '../../types.ts';
import type {
    ArenaConnection,
    ArenaDiagnosticsRefreshOptions,
    ArenaHttpDiagnostics,
    ArenaTransportDiagnostics
} from '../arena-connection-contracts.ts';
import { probeHttp, toErrorMessage } from '../arena-connection-helpers.ts';

interface ArenaDiagnosticActionsInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly currentNetworkSignal: () => AbortSignal;
    readonly diagnosticsRefreshRef: RefObject<Promise<void> | undefined>;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly isNetworkEnabled: () => boolean;
    readonly networkGenerationRef: RefObject<number>;
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly setGameDiagnostics: Dispatch<SetStateAction<RallarGameDiagnostics | undefined>>;
    readonly setHttpDiagnostics: Dispatch<SetStateAction<ArenaHttpDiagnostics>>;
    readonly setPresenceNotices: Dispatch<SetStateAction<readonly ArenaPresenceNotice[]>>;
    readonly setRtcLanes: Dispatch<SetStateAction<readonly RtcLaneStatus[]>>;
    readonly setTransportDiagnostics: Dispatch<SetStateAction<ArenaTransportDiagnostics>>;
    readonly transportDiagnosticsRef: RefObject<ArenaTransportDiagnostics>;
}

interface ArenaDiagnosticsRefreshContext {
    readonly generation: number;
    readonly signal: AbortSignal;
    readonly refreshedAtEpochMs: number;
}

const ARENA_DIAGNOSTIC_LANE_IDS = [
    GAME_MOTION_LANE_ID,
    GAME_COMBAT_LANE_ID,
    GAME_SNAPSHOT_LANE_ID,
    GAME_FX_LANE_ID,
    GAME_AI_LANE_ID
];

export function useArenaDiagnosticActions(
    input: ArenaDiagnosticActionsInput
): Pick<ArenaConnection, 'refreshDiagnostics' | 'requestArenaSync' | 'dismissPresenceNotice'> {
    const refreshDiagnostics = useCallback(
        (options: ArenaDiagnosticsRefreshOptions = {}) => refreshArenaDiagnostics(input, options),
        [
            input.currentNetworkSignal,
            input.isCurrentNetworkGeneration,
            input.isNetworkEnabled
        ]
    );

    const requestArenaSync = useCallback(
        async () => await requestArenaDiagnosticsSync(input),
        [input.isNetworkEnabled]
    );

    const dismissPresenceNotice = useCallback((id: string) => {
        input.setPresenceNotices((previous) => previous.filter((notice) => notice.id !== id));
    }, []);

    return {
        refreshDiagnostics,
        requestArenaSync,
        dismissPresenceNotice
    };
}

function refreshArenaDiagnostics(
    input: ArenaDiagnosticActionsInput,
    options: ArenaDiagnosticsRefreshOptions
): Promise<void> {
    if (!input.isNetworkEnabled()) {
        resetArenaDiagnostics(input);
        return Promise.resolve();
    }
    if (input.diagnosticsRefreshRef.current) {
        return input.diagnosticsRefreshRef.current;
    }

    const context: ArenaDiagnosticsRefreshContext = {
        generation: input.networkGenerationRef.current,
        signal: input.currentNetworkSignal(),
        refreshedAtEpochMs: Date.now()
    };
    const run = runArenaDiagnosticsRefresh(input, options, context);
    const tracked = run.finally(() => {
        if (input.diagnosticsRefreshRef.current === tracked) {
            input.diagnosticsRefreshRef.current = undefined;
        }
    });
    input.diagnosticsRefreshRef.current = tracked;
    return tracked;
}

function resetArenaDiagnostics(input: ArenaDiagnosticActionsInput): void {
    const transport: ArenaTransportDiagnostics = {
        realtimeHealth: [],
        wsTicketBackoff: readWebSocketTicketBackoffState()
    };
    input.transportDiagnosticsRef.current = transport;
    input.setTransportDiagnostics(transport);
    input.setGameDiagnostics(undefined);
    input.setRtcLanes([]);
    input.setHttpDiagnostics({
        apiConfig: { status: 'idle' },
        ice: { status: 'idle' }
    });
}

async function runArenaDiagnosticsRefresh(
    input: ArenaDiagnosticActionsInput,
    options: ArenaDiagnosticsRefreshOptions,
    context: ArenaDiagnosticsRefreshContext
): Promise<void> {
    await refreshArenaTransportDiagnostics(input, options, context);
    const [apiConfig, ice] = await Promise.all([
        probeHttp((signal) => readApiConfig({ signal }), context.signal),
        probeHttp(
            (signal) =>
                readIceCandidates({
                    signal,
                    authSession: input.sessionRef.current ?? null
                }),
            context.signal
        )
    ]);
    if (!isCurrentDiagnosticsRefresh(input, context)) {
        return;
    }
    input.setHttpDiagnostics({ apiConfig, ice });
}

async function refreshArenaTransportDiagnostics(
    input: ArenaDiagnosticActionsInput,
    options: ArenaDiagnosticsRefreshOptions,
    context: ArenaDiagnosticsRefreshContext
): Promise<void> {
    try {
        if (!isCurrentDiagnosticsRefresh(input, context)) {
            return;
        }
        input.setGameDiagnostics(input.arenaMatchRef.current?.diagnostics());
        const next: ArenaTransportDiagnostics = {
            refreshedAtEpochMs: context.refreshedAtEpochMs,
            ws: rallar.ws.status(),
            rtc: rallar.rtc.status({ laneId: GAME_MOTION_LANE_ID }),
            realtimeHealth: rallar.realtime.health({
                laneIds: ARENA_DIAGNOSTIC_LANE_IDS
            }),
            rtcDiagnostics: options.includeRtcStats
                ? await rallar.rtc.diagnostics({ laneIds: ARENA_DIAGNOSTIC_LANE_IDS })
                : input.transportDiagnosticsRef.current.rtcDiagnostics,
            wsTicketBackoff: readWebSocketTicketBackoffState()
        };
        if (!isCurrentDiagnosticsRefresh(input, context)) {
            return;
        }
        input.transportDiagnosticsRef.current = next;
        input.setTransportDiagnostics(next);
    }
    catch (error) {
        recordArenaTransportDiagnosticsError(
            input,
            context,
            error instanceof Error ? error : new Error(String(error))
        );
    }
}

function recordArenaTransportDiagnosticsError(
    input: ArenaDiagnosticActionsInput,
    context: ArenaDiagnosticsRefreshContext,
    error: Error
): void {
    if (!isCurrentDiagnosticsRefresh(input, context)) {
        return;
    }
    input.setTransportDiagnostics((previous) => {
        const next = {
            ...previous,
            refreshedAtEpochMs: context.refreshedAtEpochMs,
            error: toErrorMessage(error)
        };
        input.transportDiagnosticsRef.current = next;
        return next;
    });
}

function isCurrentDiagnosticsRefresh(
    input: ArenaDiagnosticActionsInput,
    context: ArenaDiagnosticsRefreshContext
): boolean {
    return (
        input.isCurrentNetworkGeneration(context.generation) &&
        !context.signal.aborted
    );
}

async function requestArenaDiagnosticsSync(
    input: ArenaDiagnosticActionsInput
): Promise<void> {
    if (!input.isNetworkEnabled()) {
        return;
    }
    const requestedAtEpochMs = Date.now();
    const notice: ArenaPresenceNotice = {
        id: `sync:${requestedAtEpochMs}`,
        kind: 'link-forming',
        message: 'Catching up to the live arena',
        createdAtEpochMs: requestedAtEpochMs
    };
    input.setPresenceNotices((previous) => [...previous, notice].slice(-5));
    await input.arenaMatchRef.current?.requestSync({
        reason: 'diagnostics-drawer',
        requestedAtEpochMs
    });
    if (input.isNetworkEnabled()) {
        input.setGameDiagnostics(input.arenaMatchRef.current?.diagnostics());
    }
}
