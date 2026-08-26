import type { RallarCrdtIntegrityReport, RallarCrdtValidationIssue } from '@shared/crdt/mod.ts';

import { requireEpoch, requireExactOptionalKeys, requireString } from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';

export function decodeExactIntegrityReport(value: JsonWireValue): RallarCrdtIntegrityReport {
    const report = requireCrdtJsonWireObject(value, 'CRDT integrity report');
    requireExactOptionalKeys({
        value: report,
        required: ['valid', 'issues', 'documentKey', 'checkedUpdateCount', 'sequenceGaps'],
        optional: ['bundleHash'],
        label: 'CRDT integrity report'
    });
    if (typeof report.valid !== 'boolean' || !Array.isArray(report.issues)) {
        throw new TypeError('CRDT integrity report validity is invalid');
    }
    const issues: RallarCrdtValidationIssue[] = [];
    for (const issueValue of report.issues) {
        const issue = requireCrdtJsonWireObject(issueValue, 'CRDT integrity issue');
        requireExactOptionalKeys({
            value: issue,
            required: ['path', 'code', 'message'],
            optional: [],
            label: 'CRDT integrity issue'
        });
        requireString(issue.path, 'integrity issue path');
        requireString(issue.code, 'integrity issue code');
        requireString(issue.message, 'integrity issue message');
        issues.push({ path: issue.path, code: issue.code, message: issue.message });
    }
    if (report.valid !== (issues.length === 0)) {
        throw new TypeError('CRDT integrity report validity differs from issues');
    }
    requireString(report.documentKey, 'integrity documentKey');
    requireEpoch(report.checkedUpdateCount, 'integrity checkedUpdateCount');
    if (
        !Array.isArray(report.sequenceGaps) ||
        report.sequenceGaps.some((gap) => !Number.isSafeInteger(gap) || Number(gap) < 1) ||
        new Set(report.sequenceGaps).size !== report.sequenceGaps.length
    ) {
        throw new TypeError('CRDT integrity sequence gaps are invalid');
    }
    const sequenceGaps = report.sequenceGaps.map(Number);
    if ('bundleHash' in report) {
        requireString(report.bundleHash, 'integrity bundleHash');
        return {
            valid: report.valid,
            issues,
            documentKey: report.documentKey,
            checkedUpdateCount: Number(report.checkedUpdateCount),
            sequenceGaps,
            bundleHash: report.bundleHash
        };
    }
    return {
        valid: report.valid,
        issues,
        documentKey: report.documentKey,
        checkedUpdateCount: Number(report.checkedUpdateCount),
        sequenceGaps
    };
}
