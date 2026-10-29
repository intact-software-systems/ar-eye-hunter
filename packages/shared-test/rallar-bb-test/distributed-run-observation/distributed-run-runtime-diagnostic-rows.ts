import type { ALPublicationStagingOutcome } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { decodeCount } from '../alm/decode-al-volatile-session-report.ts';
import type { ControlRunSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxRuntimeDiagnosticPayload } from '../diagnostics.ts';
import type {
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';
import { decodeFiniteNumber, decodeNonBlankText, decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import {
    computeDistributedRunCorrelatedFailureKeys,
    type DistributedRunMonitorFailureIndex
} from './distributed-run-monitor-failure-index.ts';
import { decodeFirstNonBlankText } from './distributed-run-payload-summary.ts';
import type {
    DistributedRunRuntimeDiagnosticCounts,
    DistributedRunRuntimeDiagnosticRow
} from './distributed-run-row-contracts.ts';
import { toDistributedRunIdentitySummary } from './to-distributed-run-identity-summary.ts';

type ControlEventSnapshot = ControlRunSnapshot['events'][number];
/** Every staging outcome, so an outcome the stage adds is a type error here until the rows can read it. */
const STAGING_OUTCOMES: Readonly<Record<ALPublicationStagingOutcome, true>> = {
    staged: true,
    superseded: true,
    expired: true,
    refused: true,
    cancelled: true
};

export function toDistributedRunRuntimeDiagnosticRows(
    events: readonly ControlEventSnapshot[]
): readonly Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>[] {
    return events
        .map((event, index) => toDistributedRunRuntimeDiagnosticRow(event, index))
        .filter((row): row is Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'> => row !== undefined)
        .sort((left, right) => left.atEpochMs - right.atEpochMs || left.eventId.localeCompare(right.eventId));
}

function toDistributedRunRuntimeDiagnosticRow(
    event: ControlEventSnapshot,
    index: number
): Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'> | undefined {
    const runtimeEvent = decodeRecord(event.payload);
    const payload = decodeRuntimeDiagnosticPayload(event.payload);
    if (!payload) {
        return undefined;
    }

    const data = decodeRecord(payload.data);
    const topic = decodeFirstNonBlankText(
        payload.topic,
        runtimeEvent.topic,
        payload.diagnosticTypeId,
        event.kind
    ) ?? 'runtime.diagnostic';
    const diagnosticTypeId = decodeFirstNonBlankText(payload.diagnosticTypeId, topic) ?? topic;
    const transport = toDiagnosticTransport(decodeFirstNonBlankText(payload.transport, runtimeEvent.transport));
    const severity = toDiagnosticSeverity(decodeFirstNonBlankText(payload.severity, runtimeEvent.severity), event.kind);
    const message = decodeFirstNonBlankText(
        toPublicationDiagnosticMessage(data),
        payload.message,
        runtimeEvent.message,
        payload.reason,
        data.message,
        data.reason
    ) ?? topic;
    const identitySummary = toDistributedRunIdentitySummary(event.payload);

    return {
        eventId: event.eventId ?? `${event.agentId}-${event.commandId ?? 'diagnostic'}-${index}`,
        atEpochMs: decodeFiniteNumber(payload.atEpochMs) ?? decodeFiniteNumber(runtimeEvent.atEpochMs) ??
            event.atEpochMs,
        severity,
        agentId: event.agentId,
        commandId: decodeFirstNonBlankText(payload.commandId, runtimeEvent.commandId, event.commandId),
        transport,
        topic,
        diagnosticTypeId,
        message,
        summary: toDiagnosticSummary({
            message,
            transport,
            typeId: decodeFirstNonBlankText(payload.typeId, data.typeId),
            topicId: decodeFirstNonBlankText(payload.topicId, data.topicId),
            contextId: decodeFirstNonBlankText(payload.contextId, data.contextId),
            resourceId: decodeFirstNonBlankText(payload.resourceId, data.resourceId),
            identitySummary
        }),
        identitySummary,
        ...toDiagnosticContextFields(payload, runtimeEvent, data)
    };
}

/**
 * The readable message of a page's publication diagnostic (D480). Its data is the stage's payload-free event, which
 * carries no message of its own, so the row would otherwise read only its topic. Undefined for data of any other
 * kind, and for a publication event missing a fact the message names.
 */
function toPublicationDiagnosticMessage(data: RallarBlackBoxTestRecord): string | undefined {
    const laneKey = decodeNonBlankText(data.laneKey);
    if (laneKey === undefined) {
        return undefined;
    }
    if (data.kind === 'publication-staging') {
        return toStagingMessage(laneKey, data);
    }
    return data.kind === 'publication-opportunity' ? toOpportunityMessage(laneKey, data) : undefined;
}

function toStagingMessage(laneKey: string, data: RallarBlackBoxTestRecord): string | undefined {
    const outcome = decodeNonBlankText(data.outcome);
    const msgId = decodeNonBlankText(data.msgId);
    return outcome !== undefined && Object.hasOwn(STAGING_OUTCOMES, outcome) && msgId !== undefined
        ? `Publication ${outcome} on ${laneKey}. ${msgId}`
        : undefined;
}

function toOpportunityMessage(laneKey: string, data: RallarBlackBoxTestRecord): string | undefined {
    const selected = decodeCount(data.selected);
    const deferred = decodeCount(data.deferred);
    const expired = decodeCount(data.expired);
    return selected === undefined || deferred === undefined || expired === undefined
        ? undefined
        : `Publication opportunity on ${laneKey}: ${selected} selected, ${deferred} deferred, ${expired} expired.`;
}

function toDiagnosticContextFields(
    payload: RallarBlackBoxTestRecord,
    runtimeEvent: RallarBlackBoxTestRecord,
    data: RallarBlackBoxTestRecord
): Partial<DistributedRunRuntimeDiagnosticRow> {
    return {
        connection: decodeFirstNonBlankText(payload.connection, runtimeEvent.connection),
        actor: decodeFirstNonBlankText(payload.actor, runtimeEvent.actor),
        groupId: decodeFirstNonBlankText(payload.groupId, data.groupId),
        roomId: decodeFirstNonBlankText(payload.roomId, data.roomId),
        laneId: decodeFirstNonBlankText(payload.laneId, data.laneId),
        peerId: decodeFirstNonBlankText(payload.peerId, data.peerId),
        remotePeerId: decodeFirstNonBlankText(payload.remotePeerId, data.remotePeerId),
        senderId: decodeFirstNonBlankText(payload.senderId, data.senderId),
        typeId: decodeFirstNonBlankText(payload.typeId, data.typeId),
        topicId: decodeFirstNonBlankText(payload.topicId, data.topicId),
        contextId: decodeFirstNonBlankText(payload.contextId, data.contextId),
        resourceId: decodeFirstNonBlankText(payload.resourceId, data.resourceId),
        source: decodeFirstNonBlankText(payload.source, runtimeEvent.source)
    };
}

export function toCorrelatedDistributedRunRuntimeDiagnostics(
    diagnostics: readonly Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>[],
    failureIndex: DistributedRunMonitorFailureIndex
): readonly DistributedRunRuntimeDiagnosticRow[] {
    return diagnostics.map((diagnostic) => ({
        ...diagnostic,
        correlatedFailureKeys: computeDistributedRunCorrelatedFailureKeys(diagnostic, failureIndex)
    }));
}

export function computeDistributedRunRuntimeDiagnosticCounts(
    diagnostics: readonly DistributedRunRuntimeDiagnosticRow[]
): DistributedRunRuntimeDiagnosticCounts {
    return {
        total: diagnostics.length,
        info: diagnostics.filter((row) => row.severity === 'info' || row.severity === 'debug').length,
        warning: diagnostics.filter((row) => row.severity === 'warning').length,
        error: diagnostics.filter((row) => row.severity === 'error').length,
        ws: diagnostics.filter((row) => row.transport === 'ws' || row.transport === 'messages.ws').length,
        rtc: diagnostics.filter((row) => row.transport === 'realtime' || row.transport === 'messages.rtc').length,
        http: diagnostics.filter((row) => row.transport === 'http').length,
        runtime: diagnostics.filter((row) => row.transport === undefined).length
    };
}

function decodeRuntimeDiagnosticPayload(
    payload: unknown
): (RallarBlackBoxRuntimeDiagnosticPayload & RallarBlackBoxTestRecord) | undefined {
    const envelope = decodeRecord(payload);
    const nested = decodeRecord(envelope.payload);
    if (isCanonicalRuntimeDiagnosticPayload(nested)) {
        return nested as RallarBlackBoxRuntimeDiagnosticPayload & RallarBlackBoxTestRecord;
    }
    if (isCanonicalRuntimeDiagnosticPayload(envelope)) {
        return envelope as RallarBlackBoxRuntimeDiagnosticPayload & RallarBlackBoxTestRecord;
    }
    return undefined;
}

function isCanonicalRuntimeDiagnosticPayload(value: RallarBlackBoxTestRecord): boolean {
    return value.diagnosticSchemaVersion === 1;
}

function toDiagnosticSeverity(
    value: string | undefined,
    eventKind: string
): RallarBlackBoxTestSeverity {
    if (value === 'debug' || value === 'info' || value === 'warning' || value === 'error') {
        return value;
    }
    return eventKind === 'diagnostic' ? 'warning' : 'info';
}

function toDiagnosticTransport(value: string | undefined): RallarBlackBoxTestTransport | undefined {
    if (
        value === 'ws' ||
        value === 'messages.ws' ||
        value === 'http' ||
        value === 'realtime' ||
        value === 'messages.rtc'
    ) {
        return value;
    }
    return undefined;
}

function toDiagnosticSummary(
    input: Readonly<{
        message: string;
        transport?: RallarBlackBoxTestTransport;
        typeId?: string;
        topicId?: string;
        contextId?: string;
        resourceId?: string;
        identitySummary: string;
    }>
): string {
    const selector = [
        input.typeId ? `type ${input.typeId}` : undefined,
        input.topicId ? `topic ${input.topicId}` : undefined,
        input.contextId ? `context ${input.contextId}` : undefined,
        input.resourceId ? `resource ${input.resourceId}` : undefined
    ].filter(Boolean).join(' / ');
    return [
        input.transport,
        input.message,
        selector,
        input.identitySummary
    ].filter((value): value is string => Boolean(value && value.length > 0)).join(' - ');
}

export function toDiagnosticSeverityTone(severity: RallarBlackBoxTestSeverity): string {
    if (severity === 'error') {
        return 'bad';
    }
    if (severity === 'warning') {
        return 'warn';
    }
    return 'muted';
}
