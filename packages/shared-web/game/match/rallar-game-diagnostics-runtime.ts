import type { RallarRealtimeLaneHealth, RallarRtcStatus, RallarWsStatus } from '@shared-web/browser/rallar.ts';
import type { RallarGameHostCapability, RallarGameHostElectionResult } from '../director/election.ts';
import type {
    RallarGameDirectorAppointmentEligibility,
    RallarGameHostAppointResult
} from '../director/rallar-game-director-appointment-contracts.ts';
import type { RallarGameLaneIds } from '../transport/lanes.ts';
import { deriveRallarGameDiagnostics, type RallarGameDiagnostics } from './diagnostics.ts';
import type { RallarGameRallarFacade } from './rallar-game-match-contracts.ts';
import type { RallarGamePeerReadiness } from './rallar-game-match-egress-contracts.ts';
import type { RallarGameMatchStatus } from './rallar-game-match-status.ts';

export namespace RallarGameDiagnosticsRuntime {
    export interface Input {
        readonly rallar: RallarGameRallarFacade;
        readonly laneIds: RallarGameLaneIds;
        readStatus(): RallarGameMatchStatus;
        readElection(): RallarGameHostElectionResult;
        readAppointment(): RallarGameDirectorAppointmentEligibility;
        readLastAppointment(): RallarGameHostAppointResult | undefined;
        readPeerReadiness(): RallarGamePeerReadiness | undefined;
        readCapabilities(): readonly RallarGameHostCapability[];
    }
}

/** Reads transport health and assembles the public game diagnostics view. */
export class RallarGameDiagnosticsRuntime {
    private readonly input: RallarGameDiagnosticsRuntime.Input;

    constructor(input: RallarGameDiagnosticsRuntime.Input) {
        this.input = input;
    }

    read(): RallarGameDiagnostics {
        return deriveRallarGameDiagnostics({
            status: this.input.readStatus(),
            election: this.input.readElection(),
            appointment: this.input.readAppointment(),
            lastAppointment: this.input.readLastAppointment(),
            peerReadiness: this.input.readPeerReadiness(),
            rtcStatus: this.safeReadRtcStatus(this.input.laneIds.input),
            wsStatus: this.safeReadWsStatus(),
            realtimeHealth: this.safeReadRealtimeHealth(),
            capabilities: this.input.readCapabilities()
        });
    }

    private safeReadRtcStatus(laneId: string): RallarRtcStatus | undefined {
        try {
            return this.input.rallar.rtc.status({ laneId });
        }
        catch {
            return undefined;
        }
    }

    private safeReadWsStatus(): RallarWsStatus | undefined {
        try {
            return this.input.rallar.ws.status();
        }
        catch {
            return undefined;
        }
    }

    private safeReadRealtimeHealth(): readonly RallarRealtimeLaneHealth[] {
        try {
            return this.input.rallar.realtime.health({
                laneIds: [
                    this.input.laneIds.input,
                    this.input.laneIds.intent,
                    this.input.laneIds.snapshot,
                    this.input.laneIds.metrics,
                    this.input.laneIds.replication
                ]
            });
        }
        catch {
            return [];
        }
    }
}
