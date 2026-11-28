import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import { decodeTransportFaultActedCounts } from '@shared/transport-faults/to-transport-fault-acted-counts.ts';

import { decodeALOutboundPublicationStageReport } from '../../../alm/decode-al-outbound-publication-stage-report.ts';
import {
    decodeFiniteNumber,
    decodeNonNegativeInteger,
    decodeRecord
} from '../../../runtime/decode-runtime-result-values.ts';

import type { PublicationWorkloadLoss } from './validate-publication-workload-loss.ts';

/** What one publisher of a room left: a value is `undefined` where the command's result holds none. */
export interface PublicationWorkloadPublisherResults {
    readonly agentId: string;
    /** The `value` of the result of the publisher's `loop`. */
    readonly loop: ApiJsonValue | undefined;
    /** The `value` of the result of the `stats` the publisher read after its window. */
    readonly stats: ApiJsonValue | undefined;
    /** The `value` of the result of the publisher's loss release; a point with no loss arms none and has none. */
    readonly lossRelease: ApiJsonValue | undefined;
}

export interface PublicationWorkloadPublisherFigures {
    readonly agentId: string;
    /**
     * The loop's `passed`: the sends the harness submitted. A live send returns as soon as its value is staged or
     * refused, so this is not what the stage handed to a carrier; `publicationStage.counters.admitted` is.
     */
    readonly submittedSends: number;
    readonly completedIterations: number;
    readonly elapsedMs: number;
    /**
     * The loop's `pacing.achievedRateHz`: its iterations, whether their send was accepted or not, as the n - 1
     * intervals between them over the loop's elapsed time, which includes the last child, to four places. `null`
     * where the loop states none, as a loop of one iteration does: the record is written as JSON, which keeps a `null`.
     */
    readonly achievedIterationRateHz: number | null;
    /** The publisher page's publication stage as its `stats` read it: holdings, limits, counters and figures. */
    readonly publicationStage: ALOutboundPublicationStageReport;
    /**
     * The release's `acted.drop`: the sends this publisher's fault dropped. Over `ws` each is a socket write and a
     * frame no recipient got; over `rtc` each is a send to one next hop that its channel refused, and the publisher's
     * page submits the frame to that next hop again 50 ms later. `null` for a point with no loss, whose recipes arm
     * none: never 0 in its place.
     */
    readonly droppedSends: number | null;
}

type PublicationWorkloadLoopFigures = Omit<
    PublicationWorkloadPublisherFigures,
    'agentId' | 'publicationStage' | 'droppedSends'
>;

/**
 * The left names every field of the publisher's three result values that cannot be read, each issue starting with the
 * field's path: under `<path>.loop` a field of the loop's result, under `<path>.stats` one of the page's stage, and at
 * `<path>.lossRelease` a release a seeded point lacks or a point with no loss has.
 */
export function decodePublicationWorkloadPublisherFigures(
    publisher: PublicationWorkloadPublisherResults,
    path: string,
    loss: PublicationWorkloadLoss
): Either<readonly string[], PublicationWorkloadPublisherFigures> {
    const loop = decodeLoopFigures(publisher.loop, `${path}.loop`);
    const publicationStage = decodePublicationStage(publisher.stats, `${path}.stats.rallar.alm`);
    const droppedSends = decodeDroppedSends(publisher.lossRelease, `${path}.lossRelease`, loss);
    if (loop.right === undefined || publicationStage.right === undefined || droppedSends.right === undefined) {
        return Either.ofLeft([...(loop.left ?? []), ...(publicationStage.left ?? []), ...(droppedSends.left ?? [])]);
    }
    return Either.ofRight({
        agentId: publisher.agentId,
        ...loop.right,
        publicationStage: publicationStage.right,
        droppedSends: droppedSends.right
    });
}

function decodeLoopFigures(
    loop: ApiJsonValue | undefined,
    path: string
): Either<readonly string[], PublicationWorkloadLoopFigures> {
    const record = decodeRecord(loop);
    const pacing = decodeRecord(record.pacing);
    const submittedSends = decodeNonNegativeInteger(record.passed);
    const childResultCount = decodeNonNegativeInteger(record.childResultCount);
    const completedIterations = decodeNonNegativeInteger(pacing.completedIterations);
    const elapsedMs = decodeFiniteNumber(pacing.elapsedMs);
    const achievedRateHz = decodeFiniteNumber(pacing.achievedRateHz);
    const issues = [
        ...(submittedSends === undefined ? [`${path}.passed must be a whole number of at least 0`] : []),
        ...validateLoopChildResultCount(childResultCount, completedIterations, path),
        ...(completedIterations === undefined
            ? [`${path}.pacing.completedIterations must be a whole number of at least 0`]
            : []),
        ...(elapsedMs === undefined || elapsedMs < 0
            ? [`${path}.pacing.elapsedMs must be a finite number of at least 0`]
            : []),
        ...(pacing.achievedRateHz !== undefined && achievedRateHz === undefined
            ? [`${path}.pacing.achievedRateHz must be a finite number where the loop states one`]
            : [])
    ];
    if (
        issues.length > 0 || submittedSends === undefined || completedIterations === undefined ||
        elapsedMs === undefined
    ) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        submittedSends,
        completedIterations,
        elapsedMs,
        achievedIterationRateHz: achievedRateHz ?? null
    });
}

/**
 * The family's loop holds one send, so it ran one child per iteration. A loop that ran another number is not the
 * family's, and its `passed` would not count submitted sends.
 */
function validateLoopChildResultCount(
    childResultCount: number | undefined,
    completedIterations: number | undefined,
    path: string
): readonly string[] {
    if (childResultCount === undefined) {
        return [`${path}.childResultCount must be a whole number of at least 0`];
    }
    return completedIterations === undefined || childResultCount === completedIterations
        ? []
        : [`${path}.childResultCount must be ${path}.pacing.completedIterations, one child per iteration`];
}

/** The stage decoder names each bad field under `publication.`, the block `stats.rallar.alm` holds it in. */
function decodePublicationStage(
    stats: ApiJsonValue | undefined,
    almUsagePath: string
): Either<readonly string[], ALOutboundPublicationStageReport> {
    const { publication } = decodeRecord(decodeRecord(decodeRecord(stats).rallar).alm);
    return isApiJsonObject(publication)
        ? decodeALOutboundPublicationStageReport(publication)
            .mapLeft((issues) => issues.map((issue) => `${almUsagePath}.${issue}`))
        : Either.ofLeft([`${almUsagePath}.publication must be an object: the stats of a page that connected`]);
}

/** A seeded point's publisher released its fault and read its counts; a point with no loss injected none. */
function decodeDroppedSends(
    lossRelease: ApiJsonValue | undefined,
    path: string,
    loss: PublicationWorkloadLoss
): Either<readonly string[], number | null> {
    if (loss.kind !== 'seeded') {
        return lossRelease === undefined
            ? Either.ofRight(null)
            : Either.ofLeft([`${path} must be absent: a point with no loss arms no fault`]);
    }
    if (lossRelease === undefined) {
        return Either.ofLeft([`${path} must be the value of the publisher's loss release`]);
    }
    return decodeTransportFaultActedCounts(decodeRecord(lossRelease).acted).flatMap(
        (issue) => Either.ofLeft([`${path}.acted must be the fault's acted counts: ${issue}`]),
        (acted) => Either.ofRight(acted.drop)
    );
}
