import type { RallarReadinessExpectation, RallarRtcRoomLaneWaitResult } from '@shared-web/browser/rallar.ts';

export interface RallarGameLaneReadyOptions {
    readonly laneIds?: readonly string[];
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly connect?: boolean;
    readonly expect?: RallarReadinessExpectation;
}

export interface RallarGamePeerReadiness {
    readonly status:
        | 'open'
        | 'partial'
        | 'not-ready'
        | 'empty'
        | 'not-connected'
        | 'timeout'
        | 'aborted'
        | 'failed'
        | 'over-capacity'
        | 'no-room';
    readonly roomId?: string;
    readonly laneIds: readonly string[];
    readonly readyPeerIds: readonly string[];
    readonly notReadyPeerIds: readonly string[];
    readonly missingPeerIds: readonly string[];
    readonly extraPeerIds: readonly string[];
    readonly observedCount: number;
    readonly expectedCount?: number;
    readonly lanes: readonly RallarRtcRoomLaneWaitResult[];
    readonly reason?: string;
}
