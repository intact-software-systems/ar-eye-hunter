import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../../protocol/exact-object-decoding.ts';
import { decodeExactDocumentRef } from './crdt-mutation-value-codec.ts';

export function decodeExactValidationResult(value: object): void {
    const validation = requireRecord(value, 'CRDT validation result');
    requireExactKeys(validation, ['valid', 'issues'], 'CRDT validation result');
    if (typeof validation.valid !== 'boolean' || !Array.isArray(validation.issues)) {
        throw new TypeError('CRDT validation result is invalid');
    }
    for (const issue of validation.issues) {
        const fields = requireRecord(issue, 'CRDT validation issue');
        requireExactKeys(fields, ['path', 'code', 'message'], 'CRDT validation issue');
        for (const field of ['path', 'code', 'message']) {
            requireString(fields[field], `validation issue ${field}`);
        }
    }
    if (validation.valid !== (validation.issues.length === 0)) {
        throw new TypeError('CRDT validation result differs from issues');
    }
}

export function decodeExactIntegrityReport(value: object): void {
    const report = requireRecord(value, 'CRDT integrity report');
    requireExactOptionalKeys({
        value: report,
        required: ['valid', 'issues', 'documentKey', 'checkedUpdateCount', 'sequenceGaps'],
        optional: ['bundleHash'],
        label: 'CRDT integrity report'
    });
    if (typeof report.valid !== 'boolean' || !Array.isArray(report.issues)) {
        throw new TypeError('CRDT integrity report validity is invalid');
    }
    for (const issue of report.issues) {
        const fields = requireRecord(issue, 'CRDT integrity issue');
        requireExactKeys(fields, ['path', 'code', 'message'], 'CRDT integrity issue');
        for (const field of ['path', 'code', 'message']) {
            requireString(fields[field], `issue ${field}`);
        }
    }
    if (report.valid !== (report.issues.length === 0)) {
        throw new TypeError('CRDT integrity report validity differs from issues');
    }
    requireString(report.documentKey, 'integrity documentKey');
    requireEpoch(report.checkedUpdateCount, 'integrity checkedUpdateCount');
    if (
        !Array.isArray(report.sequenceGaps) ||
        report.sequenceGaps.some((gap) => !Number.isSafeInteger(gap) || gap < 1) ||
        new Set(report.sequenceGaps).size !== report.sequenceGaps.length
    ) {
        throw new TypeError('CRDT integrity sequence gaps are invalid');
    }
    if ('bundleHash' in report) {
        requireString(report.bundleHash, 'integrity bundleHash');
    }
}

export function decodeExactErasureRequest(value: object): void {
    const request = requireRecord(value, 'CRDT erasure request');
    requireExactKeys(
        request,
        ['document', 'requestedAtEpochMs', 'requestedBy', 'reason', 'mode'],
        'CRDT erasure request'
    );
    decodeExactDocumentRef(request.document, 'CRDT erasure document');
    requireEpoch(request.requestedAtEpochMs, 'erasure requestedAtEpochMs');
    requireString(request.requestedBy, 'erasure requestedBy');
    requireString(request.reason, 'erasure reason');
    requireOneOf(request.mode, ['destroy-document', 'redact-payloads'] as const, 'erasure mode');
}

export function decodeExactErasureAuditEvent(value: object): void {
    const event = requireRecord(value, 'CRDT erasure audit event');
    requireExactKeys(
        event,
        ['kind', 'atEpochMs', 'documentKey', 'principalId', 'reason', 'metadata'],
        'CRDT erasure audit event'
    );
    requireOneOf(event.kind, ['erase', 'redact'] as const, 'erasure audit kind');
    requireEpoch(event.atEpochMs, 'erasure audit atEpochMs');
    for (const field of ['documentKey', 'principalId', 'reason']) {
        requireString(event[field], `erasure audit ${field}`);
    }
    const metadata = requireRecord(event.metadata, 'CRDT erasure audit metadata');
    requireExactKeys(metadata, ['mode'], 'CRDT erasure audit metadata');
    requireOneOf(metadata.mode, ['destroy-document', 'redact-payloads'] as const, 'audit mode');
}
