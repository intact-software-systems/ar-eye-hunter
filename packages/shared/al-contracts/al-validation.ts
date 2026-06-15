import type { ALRoute } from './al-contract.ts';
import {
    type RallarJsonPayloadValidationResult,
    type RallarValidationIssue,
    type RallarValidationResult,
    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    failRallarValidation,
    okRallarValidation,
    throwRallarValidation,
    validateRallarJsonPayload,
    validateRallarRouteId,
} from '../api/rallar-validation.ts';

export type ALMessageInputValidation = Readonly<{
    senderId: unknown;
    route: ALRoute;
    typeId: unknown;
    payload: unknown;
    maxPayloadBytes?: number;
}>;

export type ALMessageInputValidationResult = RallarValidationResult & Readonly<{
    payload?: RallarJsonPayloadValidationResult;
}>;

export function validateALMessageInput(
    input: ALMessageInputValidation,
): ALMessageInputValidationResult {
    const issues: RallarValidationIssue[] = [];
    appendIssues(validateRallarRouteId(input.senderId, '$.senderId', 'Sender ID'), issues);
    appendIssues(
        validateRallarRouteId(input.route.topicId, '$.route.topicId', 'Topic ID'),
        issues,
    );
    appendIssues(
        validateRallarRouteId(input.route.contextId, '$.route.contextId', 'Context ID'),
        issues,
    );
    appendIssues(
        validateRallarRouteId(input.route.resourceId, '$.route.resourceId', 'Resource ID'),
        issues,
    );
    appendIssues(validateRallarRouteId(input.typeId, '$.typeId', 'Type ID'), issues);

    const payload = validateRallarJsonPayload(input.payload, {
        path: '$.payload',
        maxBytes: input.maxPayloadBytes ?? RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    });
    appendIssues(payload, issues);

    return issues.length === 0
        ? { ...okRallarValidation(), payload }
        : { ...failRallarValidation(issues), payload };
}

export function assertValidALMessageInput(
    input: ALMessageInputValidation,
): Readonly<{ payload: { serialized: string; byteLength: number } }> {
    const result = validateALMessageInput(input);
    if (!result.ok) {
        throwRallarValidation(result.issues);
    }

    return {
        payload: {
            serialized: result.payload?.serialized ?? JSON.stringify(input.payload),
            byteLength: result.payload?.byteLength ?? 0,
        },
    };
}

function appendIssues(
    result: RallarValidationResult,
    issues: RallarValidationIssue[],
): void {
    issues.push(...result.issues);
}
