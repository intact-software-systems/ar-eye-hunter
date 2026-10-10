import { RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH } from '@shared-test/rallar-bb-test/composite-result-paths.ts';
import {
    toRallarBlackBoxCompositeResultTree,
    type RallarBlackBoxCompositeResultTreeNode
} from '@shared-test/rallar-bb-test/composite-results.ts';
import type { ControlEventEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRedactionOptions,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import { decodeJsonValue, decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';

interface DistributedAssessmentEvidenceSource {
    readonly manifest: ControlDistributedRunSnapshot['manifest'];
    readonly commandLinks: ControlDistributedRunSnapshot['commandLinks'];
}

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
    if (!result || (result.kind !== 'recipe.run' && result.kind !== 'loop' && result.kind !== 'parallel')) {
        return envelope;
    }
    const node = toRallarBlackBoxCompositeResultTree([result])[0];
    return node ? { ...envelope, result: toCompactedResult(node) } : envelope;
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

/** Retains finite result identity and capture facts, not arbitrary successful child payloads. */
function toCompactedResult(node: RallarBlackBoxCompositeResultTreeNode): RallarBlackBoxTestResult {
    const result = node.entry.result;
    const value = decodeRecord(result.value);
    const composite = result.kind === 'recipe.run' || result.kind === 'loop' || result.kind === 'parallel';
    const readout = value.rtcCapture === undefined
        ? undefined
        : toRtcCaptureReadout(decodeJsonValue(value.rtcCapture)).right;
    const leaf = result.kind === 'recipe.load'
        ? toFiniteFields(value, ['recipeId', 'recipeBodyId'])
        : readout === undefined ? undefined : { ...toFiniteIdentity(value), rtcCapture: readout };
    return {
        commandId: result.commandId,
        kind: result.kind,
        status: result.status,
        ok: result.ok,
        startedAtEpochMs: result.startedAtEpochMs,
        endedAtEpochMs: result.endedAtEpochMs,
        durationMs: result.durationMs,
        ...(result.replayed === undefined ? {} : { replayed: result.replayed }),
        ...(result.error === undefined ? {} : { error: { code: result.error.code, message: result.error.message } }),
        ...(composite
            ? { value: toCompactedCompositeValue(node) }
            : leaf === undefined
            ? {}
            : { value: leaf })
    };
}

function toFiniteIdentity(value: RallarBlackBoxTestRecord): RallarBlackBoxTestRecord {
    const identity = toFiniteFields(value, [
        'status',
        'connection',
        'actor',
        'transport',
        'roomId',
        'applicationId',
        'workspaceId',
        'clientId',
        'sessionId',
        'username',
        'laneId',
        'typeId',
        'topicId'
    ]);
    const document = isJsonRecordValue(value.document)
        ? toFiniteFields(value.document, ['origin', 'timeOrigin'])
        : undefined;
    const scope = isJsonRecordValue(value.scope)
        ? toFiniteFields(value.scope, ['applicationId', 'workspaceId'])
        : typeof value.scope === 'string'
        ? value.scope
        : undefined;
    const roomRef = isJsonRecordValue(value.roomRef)
        ? toFiniteFields(value.roomRef, ['applicationId', 'workspaceId', 'groupId'])
        : undefined;
    return {
        ...identity,
        ...(document === undefined ? {} : { document }),
        ...(scope === undefined ? {} : { scope }),
        ...(roomRef === undefined ? {} : { roomRef })
    };
}

/** A fixed domain field projection; objects and arbitrary payloads never pass this boundary. */
function toFiniteFields(value: RallarBlackBoxTestRecord, fields: readonly string[]): RallarBlackBoxTestRecord {
    return Object.fromEntries(
        fields.flatMap((key) =>
            typeof value[key] === 'string' || (typeof value[key] === 'number' && Number.isFinite(value[key]))
                ? [[key, value[key]]]
                : []
        )
    );
}

function toCompactedCompositeValue(node: RallarBlackBoxCompositeResultTreeNode): RallarBlackBoxTestRecord {
    const value = decodeRecord(node.entry.result.value);
    const failedChildren = Array.isArray(value.results) ? value.results.filter(isFailedCompositeChild) : [];
    const failures = failedChildren.slice(0, COMPACTED_CHILD_FAILURE_LIMIT).map(toCompactedChildFailure);
    const resultCount = typeof value.resultCount === 'number'
        ? value.resultCount
        : Array.isArray(value.results)
        ? value.results.length
        : node.children.length;
    const limited = hasLimitedEvidence(node);
    const {
        results: _results,
        groups: _groups,
        invocation: _invocation,
        recipeId: _recipeId,
        resultsOmitted: _resultsOmitted,
        ...summary
    } = value;
    const identity = node.entry.kind === 'recipe.run'
        ? {
            recipeId: typeof value.recipeId === 'string' ? value.recipeId : undefined,
            invocation: toFiniteFields(decodeRecord(value.invocation), [
                'invocationId',
                'recipeBodyId',
                'run',
                'recipe',
                'step'
            ])
        }
        : {};
    return {
        ...summary,
        ...identity,
        resultCount,
        failureCount: typeof value.failureCount === 'number' ? value.failureCount : failedChildren.length,
        ...(failures.length > 0 ? { failures } : {}),
        resultEvidence: { status: limited ? 'limited' : 'finite', payloadsOmitted: true },
        ...(node.entry.kind === 'parallel'
            ? { groups: toCompactedParallelGroups(node) }
            : { results: node.children.map((child) => toCompactedChild(child, node)) })
    };
}

function toCompactedChild(
    node: RallarBlackBoxCompositeResultTreeNode,
    parent: RallarBlackBoxCompositeResultTreeNode
): RallarBlackBoxTestRecord {
    const position = node.entry.position;
    const result = toCompactedResult(node);
    if (position.kind === 'root' || position.kind === 'recipe-child') {
        return { ...result };
    }
    return {
        ...position,
        commandId: result.commandId,
        path: toRelativeCompositePath(parent.entry.path, node.entry.path),
        sourceRecipePath: toRelativeCompositePath(parent.entry.sourceRecipePath, node.entry.sourceRecipePath),
        result
    };
}

function toCompactedParallelGroups(node: RallarBlackBoxCompositeResultTreeNode): readonly RallarBlackBoxTestRecord[] {
    const value = decodeRecord(node.entry.result.value);
    const groups = Array.isArray(value.groups) ? value.groups : [];
    return groups.slice(0, RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands).map((value, groupIndex) => {
        const group = decodeRecord(value);
        return {
            ...toFiniteFields(group, ['groupId', 'commandCount', 'passed', 'failed', 'durationMs']),
            ...(typeof group.cancelled === 'boolean' ? { cancelled: group.cancelled } : {}),
            results: node.children.filter((child) =>
                child.entry.position.kind === 'parallel-child' && child.entry.position.groupIndex === groupIndex
            )
                .map((child) => toCompactedChild(child, node))
        };
    });
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

/** Compaction writes the owned child-relative path; the reader rebases it exactly once. */
function toRelativeCompositePath(parentPath: string, childPath: string): string {
    return childPath.startsWith(`${parentPath}.`)
        ? `${RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH}${childPath.slice(parentPath.length)}`
        : childPath;
}

function hasLimitedEvidence(node: RallarBlackBoxCompositeResultTreeNode): boolean {
    const value = decodeRecord(node.entry.result.value);
    return (Array.isArray(value.groups) &&
        value.groups.length > RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands) ||
        node.entry.childDecodeIssues.length > 0 ||
        decodeRecord(decodeRecord(node.entry.result.value).resultEvidence).status === 'limited' ||
        node.children.some(hasLimitedEvidence);
}
