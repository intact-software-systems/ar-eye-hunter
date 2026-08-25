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

export function useArenaDiagnosticActions(
    input: ArenaDiagnosticActionsInput
): Pick<ArenaConnection, 'refreshDiagnostics' | 'requestArenaSync' | 'dismissPresenceNotice'> {
    const {
        arenaMatchRef,
        currentNetworkSignal,
        diagnosticsRefreshRef,
        isCurrentNetworkGeneration,
        isNetworkEnabled,
        networkGenerationRef,
        sessionRef,
        setGameDiagnostics,
        setHttpDiagnostics,
        setPresenceNotices,
        setRtcLanes,
        setTransportDiagnostics,
        transportDiagnosticsRef
    } = input;

    const refreshDiagnostics = useCallback(async (
        options: ArenaDiagnosticsRefreshOptions = {}
    ) => {
        if (!isNetworkEnabled()) {
            const nextTransport: ArenaTransportDiagnostics = {
                realtimeHealth: [],
                wsTicketBackoff: readWebSocketTicketBackoffState()
            };
            transportDiagnosticsRef.current = nextTransport;
            setTransportDiagnostics(nextTransport);
            setGameDiagnostics(undefined);
            setRtcLanes([]);
            setHttpDiagnostics({
                apiConfig: { status: 'idle' },
                ice: { status: 'idle' }
            });
            return;
        }
        if (diagnosticsRefreshRef.current) {
            return diagnosticsRefreshRef.current;
        }

        const generation = networkGenerationRef.current;
        const signal = currentNetworkSignal();
        const run = (async () => {
            const refreshedAtEpochMs = Date.now();
            try {
                if (!isCurrentNetworkGeneration(generation) || signal.aborted) {
                    return;
                }
                const match = arenaMatchRef.current;
                if (match) {
                    setGameDiagnostics(match.diagnostics());
                }

                const rtcStatus = rallar.rtc.status({ laneId: GAME_MOTION_LANE_ID });
                const nextTransport: ArenaTransportDiagnostics = {
                    refreshedAtEpochMs,
                    ws: rallar.ws.status(),
                    rtc: rtcStatus,
                    realtimeHealth: rallar.realtime.health({
                        laneIds: [
                            GAME_MOTION_LANE_ID,
                            GAME_COMBAT_LANE_ID,
                            GAME_SNAPSHOT_LANE_ID,
                            GAME_FX_LANE_ID,
                            GAME_AI_LANE_ID
                        ]
                    }),
                    rtcDiagnostics: options.includeRtcStats
                        ? await rallar.rtc.diagnostics({
                            laneIds: [
                                GAME_MOTION_LANE_ID,
                                GAME_COMBAT_LANE_ID,
                                GAME_SNAPSHOT_LANE_ID,
                                GAME_FX_LANE_ID,
                                GAME_AI_LANE_ID
                            ]
                        })
                        : transportDiagnosticsRef.current.rtcDiagnostics,
                    wsTicketBackoff: readWebSocketTicketBackoffState()
                };
                if (!isCurrentNetworkGeneration(generation) || signal.aborted) {
                    return;
                }
                transportDiagnosticsRef.current = nextTransport;
                setTransportDiagnostics(nextTransport);
            }
            catch (err) {
                if (!isCurrentNetworkGeneration(generation) || signal.aborted) {
                    return;
                }
                setTransportDiagnostics((previous) => {
                    const next = {
                        ...previous,
                        refreshedAtEpochMs,
                        error: toErrorMessage(
                            err instanceof Error ? err : new Error(String(err))
                        )
                    };
                    transportDiagnosticsRef.current = next;
                    return next;
                });
            }

            const [apiConfig, ice] = await Promise.all([
                probeHttp((signal) => readApiConfig({ signal }), signal),
                probeHttp((signal) =>
                    readIceCandidates({
                        signal,
                        authSession: sessionRef.current ?? null
                    }), signal)
            ]);
            if (!isCurrentNetworkGeneration(generation) || signal.aborted) {
                return;
            }
            setHttpDiagnostics({
                apiConfig,
                ice
            });
        })();

        const tracked = run.finally(() => {
            if (diagnosticsRefreshRef.current === tracked) {
                diagnosticsRefreshRef.current = undefined;
            }
        });
        diagnosticsRefreshRef.current = tracked;
        return tracked;
    }, [currentNetworkSignal, isCurrentNetworkGeneration, isNetworkEnabled]);

    const requestArenaSync = useCallback(async () => {
        if (!isNetworkEnabled()) {
            return;
        }
        const now = Date.now();
        const notice: ArenaPresenceNotice = {
            id: `sync:${now}`,
            kind: 'link-forming',
            message: 'Catching up to the live arena',
            createdAtEpochMs: now
        };
        setPresenceNotices((previous) => [...previous, notice].slice(-5));
        await arenaMatchRef.current?.requestSync({
            reason: 'diagnostics-drawer',
            requestedAtEpochMs: now
        });
        if (!isNetworkEnabled()) {
            return;
        }
        setGameDiagnostics(arenaMatchRef.current?.diagnostics());
    }, [isNetworkEnabled]);

    const dismissPresenceNotice = useCallback((id: string) => {
        setPresenceNotices((previous) => previous.filter((notice) => notice.id !== id));
    }, []);

    return {
        refreshDiagnostics,
        requestArenaSync,
        dismissPresenceNotice
    };
}
