import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { decodeGroupPublicationTopicGrants } from '@shared/api/group-publication/group-publication-grants.ts';
import { validateRallarWsUserTopicId, type RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import type { GrantGroupPublicationRequest, RevokeGroupPublicationRequest } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';

const REQUIRED_KEYS = ['requestId', 'topicId', 'publish', 'subscribe'] as const;
/** A body may still carry the actor fields every group route accepts; the route stamps the authenticated actor. */
const OPTIONAL_KEYS = ['reason', 'actorPrincipalId', 'actorSessionId'] as const;

export function decodeGrantGroupPublicationRequest(
    value: unknown
): Either<readonly RallarValidationIssue[], GrantGroupPublicationRequest & Readonly<{ requestId: string; }>> {
    return decodeGroupPublicationRequest(value);
}

export function decodeRevokeGroupPublicationRequest(
    value: unknown
): Either<readonly RallarValidationIssue[], RevokeGroupPublicationRequest & Readonly<{ requestId: string; }>> {
    return decodeGroupPublicationRequest(value);
}

function decodeGroupPublicationRequest(
    value: unknown
): Either<readonly RallarValidationIssue[], GrantGroupPublicationRequest & Readonly<{ requestId: string; }>> {
    if (!isPublicationRequestObject(value)) {
        return Either.ofLeft([issue('$', 'invalid-record', 'A publication grant request must be an object.')]);
    }
    const issues = [...toKeyIssues(value), ...toFieldIssues(value)];
    const request = toPublicationRequest(value);
    return issues.length > 0 || request === null ? Either.ofLeft(issues) : Either.ofRight(request);
}

function toPublicationRequest(
    { requestId, topicId, publish, subscribe, reason }: ApiJsonObject
): (GrantGroupPublicationRequest & Readonly<{ requestId: string; }>) | null {
    return typeof requestId === 'string' && typeof topicId === 'string' && typeof publish === 'boolean' &&
            typeof subscribe === 'boolean' && (reason === undefined || typeof reason === 'string')
        ? { requestId, topicId, publish, subscribe, ...(reason === undefined ? {} : { reason }) }
        : null;
}

function toKeyIssues(request: ApiJsonObject): readonly RallarValidationIssue[] {
    const known: readonly string[] = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
    return [
        ...Object.keys(request).filter((key) => !known.includes(key)).map((key) =>
            issue(`$.${key}`, 'unknown-key', `${key} is not a field of a publication grant request.`)
        ),
        ...REQUIRED_KEYS.filter((key) => !Object.hasOwn(request, key)).map((key) =>
            issue(`$.${key}`, 'missing-key', `${key} is required.`)
        )
    ];
}

function toFieldIssues(request: ApiJsonObject): readonly RallarValidationIssue[] {
    return [
        ...(isNonEmptyString(request.requestId)
            ? []
            : [issue('$.requestId', 'invalid-string', 'requestId must be a non-empty string.')]),
        ...(request.reason === undefined || isNonEmptyString(request.reason)
            ? []
            : [issue('$.reason', 'invalid-string', 'reason must be a non-empty string.')]),
        ...toTopicPermissionIssues(request)
    ];
}

/** D492: the named topic and permissions follow the creation declaration's rule for one topic. */
function toTopicPermissionIssues({ topicId, publish, subscribe }: ApiJsonObject): readonly RallarValidationIssue[] {
    if (typeof topicId !== 'string') {
        return validateRallarWsUserTopicId(topicId, '$.topicId').issues;
    }
    const permissions = Object.fromEntries(
        Object.entries({ publish, subscribe }).filter(([, permission]) => permission !== undefined)
    );
    return decodeGroupPublicationTopicGrants({ [topicId]: permissions }).fold((issues) => issues, () => []);
}

function issue(path: string, code: string, message: string): RallarValidationIssue {
    return { path, code, message };
}

function isNonEmptyString(value: ApiJsonObject[string] | undefined): boolean {
    return typeof value === 'string' && value.length > 0;
}

function isPublicationRequestObject(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
