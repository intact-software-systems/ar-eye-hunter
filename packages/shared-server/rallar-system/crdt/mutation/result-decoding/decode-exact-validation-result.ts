import type {
    RallarCrdtValidationIssue,
    RallarCrdtValidationResult
} from '@shared/crdt/mod.ts';

import {
    requireExactKeys,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';

export function decodeExactValidationResult(value: JsonWireValue): RallarCrdtValidationResult {
    const validation = requireCrdtJsonWireObject(value, 'CRDT validation result');
    requireExactKeys(validation, ['valid', 'issues'], 'CRDT validation result');
    if (typeof validation.valid !== 'boolean' || !Array.isArray(validation.issues)) {
        throw new TypeError('CRDT validation result is invalid');
    }
    const issues: RallarCrdtValidationIssue[] = [];
    for (const issueValue of validation.issues) {
        const issue = requireCrdtJsonWireObject(issueValue, 'CRDT validation issue');
        requireExactKeys(issue, ['path', 'code', 'message'], 'CRDT validation issue');
        requireString(issue.path, 'validation issue path');
        requireString(issue.code, 'validation issue code');
        requireString(issue.message, 'validation issue message');
        issues.push({
            path: issue.path,
            code: issue.code,
            message: issue.message
        });
    }
    if (validation.valid !== (issues.length === 0)) {
        throw new TypeError('CRDT validation result differs from issues');
    }
    return {
        valid: validation.valid,
        issues
    };
}
