import type {
    AdminSupportExplainRequestRequest,
    AdminSupportFact,
    AdminSupportJsonObject,
    AdminSupportNarrativeResponse,
    AdminSupportSuggestedAction,
    AdminSupportTimelineItem,
    AdminSupportWarning
} from '@shared/api/admin-support/admin-support-types.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { AdminSupportQueueEntryRead } from '../admin-support-contracts.ts';
import { adminSupportNarrativeBase, type AdminSupportNarrativeBase } from './admin-support-narrative-base.ts';
import { toAdminSupportTimelineItem } from './admin-support-timeline.ts';

interface ProjectQueueAdminSupportInput extends AdminSupportNarrativeBase {
    readonly queueKey: Key;
    readonly inbox: AdminSupportQueueEntryRead | undefined;
    readonly result: AdminSupportQueueEntryRead | undefined;
}

export function projectQueueAdminSupportNarrative(
    input: ProjectQueueAdminSupportInput
): AdminSupportNarrativeResponse {
    const facts = [
        ...entryFacts('inbox', input.inbox),
        ...entryFacts('result', input.result)
    ];
    const timeline = [
        ...entryTimeline('inbox', input.inbox),
        ...entryTimeline('result', input.result)
    ];
    const warnings: AdminSupportWarning[] = [];
    if (!input.inbox) {
        warnings.push({
            code: 'queue-inbox-row-missing',
            message: 'No matching resource_inbox row was found for the QueueBox key.',
            source: 'resource_inbox'
        });
    }
    if (!input.result) {
        warnings.push({
            code: 'queue-result-row-missing',
            message: 'No matching resource_inbox_results row was found for the QueueBox key.',
            source: 'resource_inbox_results'
        });
    }
    return {
        ...adminSupportNarrativeBase(input, { kind: 'queue-item', queueKey: input.queueKey }),
        facts,
        timeline,
        warnings,
        likelyCauses: queueLikelyCauses(input.inbox, input.result),
        suggestedActions: queueSuggestedActions(input.inbox, input.result),
        rawRefs: [`queue:${toQueueKeyRef(input.queueKey)}`]
    };
}

export function projectRequestAdminSupportNarrative(
    base: AdminSupportNarrativeBase,
    request: AdminSupportExplainRequestRequest,
    queueNarrative?: AdminSupportNarrativeResponse
): AdminSupportNarrativeResponse {
    if (queueNarrative) {
        return {
            ...queueNarrative,
            target: {
                kind: 'request',
                requestId: request.requestId,
                idempotencyKey: request.idempotencyKey,
                queueKey: request.queueKey,
                target: request.target
            }
        };
    }
    return {
        ...adminSupportNarrativeBase(base, {
            kind: 'request',
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            target: request.target
        }),
        facts: [{
            label: 'request.search',
            source: 'admin-support',
            value: 'not-run',
            certainty: 'unavailable'
        }],
        timeline: [],
        warnings: [{
            code: 'unsupported-global-request-search',
            message: 'Request explanation requires queueKey or a specific target in phase 1.',
            source: 'admin-support'
        }],
        likelyCauses: [],
        suggestedActions: [{
            code: 'provide-queue-key',
            label: 'Provide a QueueBox key or scoped target to explain this request',
            severity: 'info'
        }],
        rawRefs: []
    };
}

function entryFacts(
    prefix: 'inbox' | 'result',
    entry: AdminSupportQueueEntryRead | undefined
): readonly AdminSupportFact[] {
    if (!entry) {
        return [
            {
                label: `${prefix}.status`,
                source: prefix === 'inbox' ? 'resource_inbox' : 'resource_inbox_results',
                value: 'missing',
                certainty: 'unavailable'
            }
        ];
    }

    return [
        {
            label: `${prefix}.status`,
            source: entry.source,
            value: entry.status,
            certainty: 'exact'
        },
        {
            label: `${prefix}.typeId`,
            source: entry.source,
            value: entry.typeId,
            certainty: 'exact'
        },
        {
            label: `${prefix}.attempts`,
            source: entry.source,
            value: entry.attempts,
            certainty: 'exact'
        },
        {
            label: `${prefix}.payload`,
            source: entry.source,
            value: readPayloadMetadata(entry.payload),
            certainty: 'exact',
            redacted: true
        }
    ];
}

function entryTimeline(
    prefix: 'inbox' | 'result',
    entry: AdminSupportQueueEntryRead | undefined
): readonly AdminSupportTimelineItem[] {
    if (!entry) {
        return [];
    }
    return [
        toAdminSupportTimelineItem({
            atEpochMs: entry.createdAtEpochMs,
            source: entry.source,
            eventType: `${prefix}.created`,
            summary: 'Queue row was created.'
        }),
        toAdminSupportTimelineItem({
            atEpochMs: entry.startedAtEpochMs,
            source: entry.source,
            eventType: `${prefix}.started`,
            summary: 'Queue row processing started.'
        }),
        toAdminSupportTimelineItem({
            atEpochMs: entry.endedAtEpochMs,
            source: entry.source,
            eventType: `${prefix}.ended`,
            summary: 'Queue row processing ended.'
        }),
        toAdminSupportTimelineItem({
            atEpochMs: entry.nextRetryAtEpochMs,
            source: entry.source,
            eventType: `${prefix}.next-retry`,
            summary: 'Queue row is scheduled for retry.'
        }),
        toAdminSupportTimelineItem({
            atEpochMs: entry.expiresAtEpochMs,
            source: entry.source,
            eventType: `${prefix}.expires`,
            summary: 'Queue row expires.'
        })
    ].filter((item): item is AdminSupportTimelineItem => item !== undefined);
}

function queueLikelyCauses(
    inbox: AdminSupportQueueEntryRead | undefined,
    result: AdminSupportQueueEntryRead | undefined
): readonly string[] {
    const causes = [];
    if (inbox?.status === 'RETRY') {
        causes.push('Queue item is waiting for retry.');
    }
    if (inbox?.status === 'RESERVED') {
        causes.push('Queue item is reserved by a worker.');
    }
    if (result?.status === 'FAILED') {
        causes.push('Durable result row recorded a failed operation.');
    }
    if (!inbox && result) {
        causes.push('Queue inbox row is missing but a durable result exists.');
    }
    return causes;
}

function queueSuggestedActions(
    inbox: AdminSupportQueueEntryRead | undefined,
    result: AdminSupportQueueEntryRead | undefined
): readonly AdminSupportSuggestedAction[] {
    const actions: AdminSupportSuggestedAction[] = [];
    if (inbox?.status === 'RETRY' || inbox?.status === 'RESERVED') {
        actions.push({
            code: 'wait-or-inspect-worker',
            label: 'Check worker health before retry intervention',
            severity: 'warning'
        });
    }
    if (result) {
        actions.push({
            code: 'inspect-result-row',
            label: 'Inspect the durable result row',
            severity: 'info'
        });
    }
    return actions;
}

function readPayloadMetadata(payload: string): AdminSupportJsonObject {
    const byteLength = new TextEncoder().encode(payload).length;
    try {
        const parsed = decodeJsonWireValue(JSON.parse(payload), 'QueueBox payload');
        if (Array.isArray(parsed)) {
            return {
                byteLength,
                jsonKind: 'array',
                itemCount: parsed.length
            };
        }
        if (parsed !== null && typeof parsed === 'object') {
            return {
                byteLength,
                jsonKind: 'object',
                topLevelKeys: Object.keys(parsed).sort()
            };
        }
        return {
            byteLength,
            jsonKind: parsed === null ? 'null' : typeof parsed
        };
    }
    catch {
        return {
            byteLength,
            jsonKind: 'invalid-json'
        };
    }
}

function toQueueKeyRef(key: Key): string {
    return `${key.topicId}/${key.resourceId}/${key.contextId}`;
}
