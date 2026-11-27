import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

import type { RoomSendProcessFigures } from '../compute-room-send-process-figures.ts';
import { computeRoomSendReport, type RoomSendReport } from '../report/compute-room-send-report.ts';
import { ROOM_SEND_API_V1_DEFAULTS } from '../room-send-api-v1-defaults.ts';
import { ROOM_SEND_CELL_CONSTANTS, type RoomSendCellConstants } from '../room-send-cell-constants.ts';
import type {
    RoomSendCellAck,
    RoomSendCellObservations,
    RoomSendCellSend
} from '../room-send-cell-observations.ts';
import type { RoomSendCellRunResult } from '../run-room-send-cell.ts';
import type { RoomSendShape } from '../validate-room-send-shape.ts';
import {
    computeRoomSendDeclinedRepairSummary,
    type RoomSendDeclinedRepairSummary
} from './compute-room-send-declined-repair-summary.ts';
import {
    ROOM_SEND_CELL_LIMITS,
    ROOM_SEND_DELAYED_ROUND_TRIPS,
    ROOM_SEND_UNDELAYED_ROUND_TRIPS
} from './room-send-cell-limits.ts';

/** The commit the run's code was at, the branch it was checked out on, and whether its working tree differed. */
export interface RoomSendArtifactSource {
    readonly commit: string;
    readonly branch: string;
    readonly dirty: boolean;
}

/** The machine, the runtime and the database server one run had. */
export interface RoomSendArtifactEnvironment {
    readonly host: {
        readonly cpuModel: string;
        readonly cpuCount: number;
        readonly totalMemoryBytes: number;
    };
    readonly os: {
        readonly platform: string;
        readonly release: string;
        readonly architecture: string;
    };
    readonly bunVersion: string;
    readonly postgresServerVersion: string;
}

/** The machine's load average over 1, 5 and 15 minutes, read before the run opened a connection and after it ended. */
export interface RoomSendArtifactLoadAverage {
    readonly atStart: readonly number[];
    readonly atEnd: readonly number[];
}

export interface ToRoomSendArtifactInput {
    /** The instant the run was started, as an ISO 8601 UTC timestamp. */
    readonly createdAt: string;
    readonly source: RoomSendArtifactSource;
    readonly environment: RoomSendArtifactEnvironment;
    readonly loadAverage: RoomSendArtifactLoadAverage;
    readonly shape: RoomSendShape;
    /** The options the invocation gave, as `RoomSendCellOptions.givenOptions` holds them: never the database URL. */
    readonly givenOptions: Readonly<Record<string, string>>;
    readonly observationTailMs: number;
    /** From before the run's first connection to after its last one closed, in milliseconds. */
    readonly wallMs: number;
    readonly run: RoomSendCellRunResult;
}

/**
 * What an artifact keeps of a run's observations: how many of each there were; in full, each with its instants, the
 * later offers, the receipts, the controls, the unclassified controls and the sends the stand-in ended, each under a
 * thousand entries in every reference run; and of the repairs the stand-in declined, 7,111 in one reference run, a
 * summary. The first offers, the ACKs, the arrivals and the hand-offs are counted only, but for the first offers and
 * the ACKs that threw; a later offer that threw is in `resends` with the others.
 */
export interface RoomSendArtifactObservations {
    readonly counts: Readonly<Record<Exclude<keyof RoomSendCellObservations, 'observationEndedAtMs'>, number>>;
    readonly thrownSends: readonly RoomSendCellSend[];
    readonly resends: RoomSendCellObservations['resends'];
    readonly thrownAcks: readonly RoomSendCellAck[];
    readonly receipts: RoomSendCellObservations['receipts'];
    readonly controls: RoomSendCellObservations['controls'];
    readonly unclassifiedControls: RoomSendCellObservations['unclassifiedControls'];
    readonly sendEnds: RoomSendCellObservations['sendEnds'];
    readonly declinedRepairs: RoomSendDeclinedRepairSummary;
}

/**
 * What one run of the cell leaves behind: what was run, on what, every figure of it, and the observations
 * `RoomSendArtifactObservations` keeps. It holds no database URL: the invocation's options are kept without it,
 * and an error's message is cleared of anything URL-shaped when it is recorded.
 */
export interface RoomSendArtifact extends RoomSendArtifactSource {
    readonly schema: typeof ROOM_SEND_ARTIFACT_SCHEMA;
    readonly createdAt: string;
    readonly invocation: {
        readonly givenOptions: Readonly<Record<string, string>>;
    };
    readonly environment: RoomSendArtifactEnvironment;
    readonly loadAverage: RoomSendArtifactLoadAverage;
    readonly shape: RoomSendShape;
    readonly constants: RoomSendCellConstants;
    /** The pool each instance ran with, beside the one an API instance starts with by default. */
    readonly applicationPool: {
        readonly effectiveMaxConnections: number;
        readonly apiV1DefaultMaxConnections: number;
    };
    readonly databaseLatency: {
        readonly delayMs: number;
        readonly delayed: readonly string[];
        readonly notDelayed: readonly string[];
    };
    /**
     * How long the run observed. Every instant is a reading of the run's monotonic clock, in milliseconds; an offer
     * is null when the run offered no send.
     */
    readonly observation: {
        /** How long the run was to observe after its last offer. */
        readonly tailMs: number;
        readonly firstOfferAtMs: number | null;
        readonly lastOfferAtMs: number | null;
        readonly endedAtMs: number;
    };
    readonly run: {
        readonly wallMs: number;
        /** The loop's lag and the process's processor time from the window's opening to its last offer. */
        readonly sendWindow: RoomSendProcessFigures;
        /** The same from the last offer to the end of observation. */
        readonly tail: RoomSendProcessFigures;
    };
    readonly limits: readonly string[];
    readonly observations: RoomSendArtifactObservations;
    readonly report: RoomSendReport;
}

const ROOM_SEND_ARTIFACT_SCHEMA = 'rallar.alm.room-send-cell.v1';

export function toRoomSendArtifact(input: ToRoomSendArtifactInput): RoomSendArtifact {
    const { observations, runtime } = input.run;
    const offeredAtMs = computeNumberExtrema(observations.sends.map((send) => send.sentAtMs));
    return {
        schema: ROOM_SEND_ARTIFACT_SCHEMA,
        createdAt: input.createdAt,
        commit: input.source.commit,
        branch: input.source.branch,
        dirty: input.source.dirty,
        invocation: { givenOptions: input.givenOptions },
        environment: input.environment,
        loadAverage: input.loadAverage,
        shape: input.shape,
        constants: ROOM_SEND_CELL_CONSTANTS,
        applicationPool: {
            effectiveMaxConnections: runtime.applicationPoolMaxConnections,
            apiV1DefaultMaxConnections: ROOM_SEND_API_V1_DEFAULTS.applicationPoolMaxConnections
        },
        databaseLatency: {
            delayMs: input.shape.delayMs,
            delayed: ROOM_SEND_DELAYED_ROUND_TRIPS,
            notDelayed: ROOM_SEND_UNDELAYED_ROUND_TRIPS
        },
        observation: {
            tailMs: input.observationTailMs,
            firstOfferAtMs: offeredAtMs?.min ?? null,
            lastOfferAtMs: offeredAtMs?.max ?? null,
            endedAtMs: observations.observationEndedAtMs
        },
        run: { wallMs: input.wallMs, sendWindow: runtime.sendWindow, tail: runtime.tail },
        limits: ROOM_SEND_CELL_LIMITS,
        observations: toArtifactObservations(observations),
        report: computeRoomSendReport(observations)
    };
}

function toArtifactObservations(observations: RoomSendCellObservations): RoomSendArtifactObservations {
    return {
        counts: {
            sends: observations.sends.length,
            resends: observations.resends.length,
            acks: observations.acks.length,
            arrivals: observations.arrivals.length,
            handOffs: observations.handOffs.length,
            receipts: observations.receipts.length,
            controls: observations.controls.length,
            unclassifiedControls: observations.unclassifiedControls.length,
            sendEnds: observations.sendEnds.length,
            declinedRepairs: observations.declinedRepairs.length
        },
        thrownSends: observations.sends.filter((send) => send.acceptance === 'threw'),
        resends: observations.resends,
        thrownAcks: observations.acks.filter((ack) => ack.acceptance === 'threw'),
        receipts: observations.receipts,
        controls: observations.controls,
        unclassifiedControls: observations.unclassifiedControls,
        sendEnds: observations.sendEnds,
        declinedRepairs: computeRoomSendDeclinedRepairSummary(observations.declinedRepairs)
    };
}
