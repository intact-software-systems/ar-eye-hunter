import { isSameGroupRef } from '../api-type-utils.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';
import { assertValidRallarJsonPayload, assertValidRallarRouteId } from '../rallar-validation.ts';
import {
    ADMIN_SUPPORT_FACT_CERTAINTIES,
    ADMIN_SUPPORT_SUGGESTED_ACTION_SEVERITIES,
    type AdminSupportFact,
    type AdminSupportJsonValue,
    type AdminSupportNarrativeResponse,
    type AdminSupportSuggestedAction,
    type AdminSupportTimelineItem,
    type AdminSupportWarning
} from './admin-support-types.ts';

/** The room inspector requests an unfiltered group explanation; another target must never be displayed. */
export function decodeAdminGroupNarrative(value: unknown, roomRef: GroupRef): AdminSupportNarrativeResponse {
    const response = requireRecord(value, 'Room explanation');
    requireExactOptionalKeys({
        value: response,
        required: [
            'target',
            'generatedAtEpochMs',
            'facts',
            'timeline',
            'warnings',
            'likelyCauses',
            'suggestedActions',
            'rawRefs'
        ],
        optional: ['serverId'],
        label: 'Room explanation'
    });
    const groupRef = decodeNarrativeTarget(response.target, roomRef);
    requireEpoch(response.generatedAtEpochMs, 'Explanation time');
    const serverId = decodeOptionalString(response.serverId, 'Explanation server');
    const facts = decodeList(response.facts, decodeFact);
    if (new Set(facts.map((fact) => fact.label)).size !== facts.length) {
        throw new TypeError('Room explanation repeats a fact');
    }
    return {
        target: { kind: 'group', groupRef },
        generatedAtEpochMs: response.generatedAtEpochMs,
        ...(serverId === undefined ? {} : { serverId }),
        facts,
        timeline: decodeList(response.timeline, decodeTimelineItem),
        warnings: decodeList(response.warnings, decodeWarning),
        likelyCauses: decodeList(response.likelyCauses, decodeNarrativeString),
        suggestedActions: decodeList(response.suggestedActions, decodeSuggestedAction),
        rawRefs: decodeList(response.rawRefs, decodeNarrativeString)
    };
}

function decodeNarrativeTarget(value: unknown, expected: GroupRef): GroupRef {
    const target = requireRecord(value, 'Explanation target');
    requireExactKeys(target, ['kind', 'groupRef'], 'Explanation target');
    requireOneOf(target.kind, ['group'], 'Explanation target kind');
    const ref = requireRecord(target.groupRef, 'Explanation group identity');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Explanation group identity');
    const groupRef = {
        applicationId: assertValidRallarRouteId(ref.applicationId),
        workspaceId: assertValidRallarRouteId(ref.workspaceId),
        groupId: assertValidRallarRouteId(ref.groupId)
    };
    if (!isSameGroupRef(groupRef, expected)) {
        throw new TypeError('Room explanation contains a foreign room');
    }
    return groupRef;
}

function decodeFact(value: unknown): AdminSupportFact {
    const fact = requireRecord(value, 'Support fact');
    requireExactOptionalKeys({
        value: fact,
        required: ['label', 'source', 'value', 'certainty'],
        optional: ['redacted'],
        label: 'Support fact'
    });
    requireString(fact.label, 'Fact label');
    requireString(fact.source, 'Fact source');
    assertValidRallarJsonPayload(fact.value);
    if (fact.redacted !== undefined && typeof fact.redacted !== 'boolean') {
        throw new TypeError('Fact redaction flag must be boolean');
    }
    return {
        label: fact.label,
        source: fact.source,
        value: fact.value as AdminSupportJsonValue,
        certainty: requireOneOf(fact.certainty, ADMIN_SUPPORT_FACT_CERTAINTIES, 'Fact certainty'),
        ...(fact.redacted === undefined ? {} : { redacted: fact.redacted })
    };
}

function decodeWarning(value: unknown): AdminSupportWarning {
    const warning = requireRecord(value, 'Support warning');
    requireExactOptionalKeys({
        value: warning,
        required: ['code', 'message'],
        optional: ['source'],
        label: 'Support warning'
    });
    requireString(warning.code, 'Warning code');
    requireString(warning.message, 'Warning message');
    const source = decodeOptionalString(warning.source, 'Warning source');
    return { code: warning.code, message: warning.message, ...(source === undefined ? {} : { source }) };
}

function decodeTimelineItem(value: unknown): AdminSupportTimelineItem {
    const item = requireRecord(value, 'Support timeline item');
    requireExactOptionalKeys({
        value: item,
        required: ['source', 'eventType', 'summary'],
        optional: ['atEpochMs', 'rawRef'],
        label: 'Support timeline item'
    });
    requireString(item.source, 'Timeline source');
    requireString(item.eventType, 'Timeline event type');
    requireString(item.summary, 'Timeline summary');
    if (item.atEpochMs !== undefined) {
        requireEpoch(item.atEpochMs, 'Timeline time');
    }
    const rawRef = decodeOptionalString(item.rawRef, 'Timeline reference');
    return {
        source: item.source,
        eventType: item.eventType,
        summary: item.summary,
        ...(item.atEpochMs === undefined ? {} : { atEpochMs: item.atEpochMs }),
        ...(rawRef === undefined ? {} : { rawRef })
    };
}

function decodeSuggestedAction(value: unknown): AdminSupportSuggestedAction {
    const action = requireRecord(value, 'Support suggested action');
    requireExactOptionalKeys({
        value: action,
        required: ['code', 'label', 'severity'],
        optional: ['operationRef'],
        label: 'Support suggested action'
    });
    requireString(action.code, 'Action code');
    requireString(action.label, 'Action label');
    const operationRef = decodeOptionalString(action.operationRef, 'Action operation reference');
    return {
        code: action.code,
        label: action.label,
        severity: requireOneOf(action.severity, ADMIN_SUPPORT_SUGGESTED_ACTION_SEVERITIES, 'Action severity'),
        ...(operationRef === undefined ? {} : { operationRef })
    };
}

function decodeList<T>(value: unknown, decodeItem: (item: unknown) => T): readonly T[] {
    if (!Array.isArray(value)) {
        throw new TypeError('Room explanation evidence must be an array');
    }
    return value.map(decodeItem);
}

function decodeNarrativeString(value: unknown): string {
    requireString(value, 'Explanation text');
    return value;
}

function decodeOptionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    requireString(value, label);
    return value;
}
