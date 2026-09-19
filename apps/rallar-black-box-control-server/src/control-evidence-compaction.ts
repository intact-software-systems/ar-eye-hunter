import type { ControlEventEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRedactionOptions
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

type DistributedAssessmentEvidenceSource = Pick<ControlDistributedRunSnapshot, 'manifest' | 'commandLinks'>;

export interface StoredControlResultInput {
    readonly envelope: ControlResultEnvelope;
    readonly command: RallarBlackBoxTestCommand | undefined;
    readonly preserveReloadEvidence: boolean;
    readonly distributedRuns: Iterable<
        Pick<ControlDistributedRunSnapshot, 'manifest' | 'commandLinks' | 'controlRunId'>
    >;
}

/** One compaction decision for ordinary results and completed reload roots; retention bounds remain separately owned. */
export function toStoredControlResultEnvelope(input: StoredControlResultInput): ControlResultEnvelope {
    const { envelope } = input;
    const assessmentOwnsResult = Array.from(input.distributedRuns).some((distributedRun) =>
        distributedRun.controlRunId === envelope.runId &&
        toDistributedAssessmentEvidenceCommandIds(distributedRun).includes(envelope.commandId)
    );
    return input.preserveReloadEvidence || isAlmConformanceRecipeCommand(input.command) || assessmentOwnsResult
        ? envelope
        : toCompactedResultEnvelope(envelope);
}

const COMPACTED_CHILD_FAILURE_LIMIT = 20;

export function toCompactedControlReport(
    envelope: ControlEventEnvelope,
    redaction: RallarBlackBoxTestRedactionOptions | undefined
): ControlEventEnvelope {
    return {
        ...envelope,
        payload: redactRallarBlackBoxValue(toCompactedReportPayload(envelope.payload), redaction)
    };
}

export function toControlReportDedupeKey(envelope: ControlEventEnvelope): string {
    const payload = envelope.payload;
    const report = isJsonRecordValue(payload) && isJsonRecordValue(payload.payload) ? payload.payload : undefined;
    const reportId = typeof report?.reportId === 'string' ? report.reportId : undefined;
    return [
        envelope.runId,
        envelope.agentId,
        envelope.eventId ?? reportId ?? envelope.atEpochMs
    ].join('\u0000');
}

export function toCompactedResultEnvelope(envelope: ControlResultEnvelope): ControlResultEnvelope {
    const result = envelope.result;
    const value = result?.value;
    if (!result || !isJsonRecordValue(value) || !Array.isArray(value.results)) {
        return envelope;
    }

    return {
        ...envelope,
        result: {
            ...result,
            value: toCompactedCompositeValue(value)
        }
    };
}

export function toDistributedAssessmentEvidenceCommandIds(
    distributedRun: DistributedAssessmentEvidenceSource
): readonly string[] {
    if (
        (distributedRun.manifest.groupAssertions?.length ?? 0) === 0 &&
        distributedRun.manifest.metadata.family !== 'alm-conformance'
    ) {
        return [];
    }
    return distributedRun.commandLinks
        .filter((link) => link.phase === 'start')
        .map((link) => link.commandId);
}

/** Keep local ALM roots intact within normal finite result limits; only distributed owners extend those limits. */
export function isAlmConformanceRecipeCommand(command: RallarBlackBoxTestCommand | undefined): boolean {
    return command?.kind === 'recipe.run' && command.recipe?.metadata?.profile === 'alm-conformance';
}

function toCompactedReportPayload(payload: ControlEventEnvelope['payload']): ControlEventEnvelope['payload'] {
    if (!isJsonRecordValue(payload) || !isJsonRecordValue(payload.payload)) {
        return payload;
    }
    const nestedReport = payload.payload;
    const compactedReport = toCompactedReport(nestedReport);
    return compactedReport === nestedReport ? payload : { ...payload, payload: compactedReport };
}

function toCompactedReport(report: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
    const resultCount = Array.isArray(report.results) ? report.results.length : undefined;
    const eventCount = Array.isArray(report.events) ? report.events.length : undefined;
    if (resultCount === undefined && eventCount === undefined) {
        return report;
    }

    const { results: _results, events: _events, ...rest } = report;
    const summary = isJsonRecordValue(rest.summary) ? rest.summary : {};
    return {
        ...rest,
        summary: {
            ...summary,
            ...(resultCount === undefined ? {} : { omittedResultCount: resultCount }),
            ...(eventCount === undefined ? {} : { omittedEventCount: eventCount })
        }
    };
}

function toCompactedCompositeValue(value: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
    const resultCount = Array.isArray(value.results) ? value.results.length : 0;
    const failedChildren: readonly RallarBlackBoxTestRecord[] = Array.isArray(value.results)
        ? value.results.filter(isFailedCompositeChild)
        : [];
    const failures = failedChildren.slice(0, COMPACTED_CHILD_FAILURE_LIMIT).map(toCompactedChildFailure);
    const { results: _results, ...rest } = value;
    return {
        ...rest,
        resultCount,
        failureCount: failedChildren.length,
        ...(failures.length > 0 ? { failures } : {}),
        resultsOmitted: true
    };
}

function isFailedCompositeChild(child: unknown): child is RallarBlackBoxTestRecord {
    if (!isJsonRecordValue(child)) {
        return false;
    }
    return child.ok === false || (isJsonRecordValue(child.result) && child.result.ok === false);
}

function toCompactedChildFailure(child: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
    const result = isJsonRecordValue(child.result) ? child.result : undefined;
    const error = isJsonRecordValue(child.error)
        ? child.error
        : isJsonRecordValue(result?.error)
        ? result.error
        : undefined;
    return {
        commandId: child.commandId ?? result?.commandId,
        kind: child.kind ?? result?.kind,
        status: child.status ?? result?.status,
        ok: child.ok ?? result?.ok,
        error: error ? { code: error.code, message: error.message } : undefined
    };
}
