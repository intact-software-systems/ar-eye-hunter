import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

import type { OrderedSendSendWindowFigures } from '../compute-ordered-send-send-window-figures.ts';
import { ORDERED_SEND_API_V1_DEFAULTS } from '../ordered-send-api-v1-defaults.ts';
import { ORDERED_SEND_CELL_CONSTANTS, type OrderedSendCellConstants } from '../ordered-send-cell-constants.ts';
import { computeOrderedSendReport, type OrderedSendReport } from '../report/compute-ordered-send-report.ts';
import type { OrderedSendCellRunResult } from '../run-ordered-send-cell.ts';
import type { OrderedSendShape } from '../validate-ordered-send-shape.ts';
import {
    ORDERED_SEND_CELL_LIMITS,
    ORDERED_SEND_DELAYED_ROUND_TRIPS,
    ORDERED_SEND_UNDELAYED_ROUND_TRIPS
} from './ordered-send-cell-limits.ts';

/** The commit the run's code was at, and whether its working tree differed from that commit. */
export interface OrderedSendArtifactSource {
    readonly commit: string;
    readonly dirty: boolean;
}

/** The machine, the runtime and the database server one run had. */
export interface OrderedSendArtifactEnvironment {
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
export interface OrderedSendArtifactLoadAverage {
    readonly atStart: readonly number[];
    readonly atEnd: readonly number[];
}

export interface ToOrderedSendArtifactInput {
    /** The instant the run was started, as an ISO 8601 UTC timestamp. */
    readonly createdAt: string;
    readonly source: OrderedSendArtifactSource;
    readonly environment: OrderedSendArtifactEnvironment;
    readonly loadAverage: OrderedSendArtifactLoadAverage;
    readonly shape: OrderedSendShape;
    readonly observationTailMs: number;
    /** From before the run's first connection to after its last one closed, in milliseconds. */
    readonly wallMs: number;
    readonly run: OrderedSendCellRunResult;
}

/**
 * What one run of the cell leaves behind: what was run, on what, and every figure of it. It holds no database URL
 * and none of the observations the report was computed from.
 */
export interface OrderedSendArtifact extends OrderedSendArtifactSource {
    readonly schema: typeof ORDERED_SEND_ARTIFACT_SCHEMA;
    readonly createdAt: string;
    readonly environment: OrderedSendArtifactEnvironment;
    readonly loadAverage: OrderedSendArtifactLoadAverage;
    readonly shape: OrderedSendShape;
    readonly constants: OrderedSendCellConstants;
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
        readonly sendWindow: OrderedSendSendWindowFigures;
    };
    readonly limits: readonly string[];
    readonly report: OrderedSendReport;
}

const ORDERED_SEND_ARTIFACT_SCHEMA = 'rallar.alm.ordered-send-cell.v1';

export function toOrderedSendArtifact(input: ToOrderedSendArtifactInput): OrderedSendArtifact {
    const { observations, runtime } = input.run;
    const offeredAtMs = computeNumberExtrema(observations.sends.map((send) => send.sentAtMs));
    return {
        schema: ORDERED_SEND_ARTIFACT_SCHEMA,
        createdAt: input.createdAt,
        commit: input.source.commit,
        dirty: input.source.dirty,
        environment: input.environment,
        loadAverage: input.loadAverage,
        shape: input.shape,
        constants: ORDERED_SEND_CELL_CONSTANTS,
        applicationPool: {
            effectiveMaxConnections: runtime.applicationPoolMaxConnections,
            apiV1DefaultMaxConnections: ORDERED_SEND_API_V1_DEFAULTS.applicationPoolMaxConnections
        },
        databaseLatency: {
            delayMs: input.shape.delayMs,
            delayed: ORDERED_SEND_DELAYED_ROUND_TRIPS,
            notDelayed: ORDERED_SEND_UNDELAYED_ROUND_TRIPS
        },
        observation: {
            tailMs: input.observationTailMs,
            firstOfferAtMs: offeredAtMs?.min ?? null,
            lastOfferAtMs: offeredAtMs?.max ?? null,
            endedAtMs: observations.observationEndedAtMs
        },
        run: { wallMs: input.wallMs, sendWindow: runtime.sendWindow },
        limits: ORDERED_SEND_CELL_LIMITS,
        report: computeOrderedSendReport(observations)
    };
}
