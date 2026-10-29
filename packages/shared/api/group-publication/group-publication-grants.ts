import { Either } from '../../resilience/Either.ts';
import type { ApiJsonObject, ApiJsonValue } from '../api-json-value.ts';
import type { AuditStamp, GroupRef, PrincipalId } from '../group-types.ts';
import { validateRallarWsUserTopicId, type RallarValidationIssue } from '../rallar-validation.ts';

export interface GroupPublicationTopicPermissions {
    readonly publish: boolean;
    readonly subscribe: boolean;
}

/** Exact topic ids to the permissions the principal holds on each; a missing topic holds none. */
export type GroupPublicationTopicGrants = Readonly<Record<string, GroupPublicationTopicPermissions>>;

/** One principal's publication rights in one group: absent means no rights, and an empty row is never stored. */
export type GroupPublicationGrant =
    & GroupRef
    & Readonly<{
        principalId: PrincipalId;
        topics: GroupPublicationTopicGrants;
        updated: AuditStamp;
    }>;

export const GROUP_PUBLICATION_GRANT_LIMITS = { maxTopicsPerPrincipal: 64 } as const;

type Issues = RallarValidationIssue[];

const GRANT_KEYS = ['applicationId', 'workspaceId', 'groupId', 'principalId', 'topics', 'updated'] as const;
const PERMISSION_KEYS = ['publish', 'subscribe'] as const;
const AUDIT_KEYS = ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'] as const;
const ACTOR_KEYS = {
    principal: ['kind', 'principalId'],
    session: ['kind', 'sessionId', 'principalId'],
    service: ['kind', 'serviceId']
} as const;

export function decodeGroupPublicationGrant(
    value: unknown
): Either<readonly RallarValidationIssue[], GroupPublicationGrant> {
    const issues = isJsonObject(value)
        ? toGrantIssues(value)
        : [issue('$', 'invalid-record', 'Publication grant must be an object.')];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(value as GroupPublicationGrant);
}

/** Every issue the row has, in key order; an empty list is a valid row. */
export function validateGroupPublicationGrant(grant: GroupPublicationGrant): readonly RallarValidationIssue[] {
    return decodeGroupPublicationGrant(grant).fold((issues) => issues, () => []);
}

function toGrantIssues(grant: ApiJsonObject): Issues {
    return [
        ...toKeyIssues(grant, GRANT_KEYS, '$'),
        ...toNonEmptyStringIssues(grant, ['applicationId', 'workspaceId', 'groupId', 'principalId'], '$'),
        ...(grant.topics === undefined ? [] : toTopicsIssues(grant.topics, '$.topics')),
        ...(grant.updated === undefined ? [] : toAuditIssues(grant.updated, '$.updated'))
    ];
}

function toTopicsIssues(topics: ApiJsonValue, path: string): Issues {
    if (!isJsonObject(topics)) {
        return [issue(path, 'invalid-topics', 'Publication grant topics must be an object.')];
    }
    const entries = Object.entries(topics);
    const max = GROUP_PUBLICATION_GRANT_LIMITS.maxTopicsPerPrincipal;
    if (entries.length === 0 || entries.length > max) {
        return [issue(path, 'invalid-topic-count', `Publication grants hold 1 to ${max} topics per principal.`)];
    }
    return entries.flatMap(([topicId, permissions]) =>
        toTopicIssues(`${path}[${JSON.stringify(topicId)}]`, topicId, permissions)
    );
}

function toTopicIssues(path: string, topicId: string, permissions: ApiJsonValue): Issues {
    const topicIssues = validateRallarWsUserTopicId(topicId, path).issues;
    if (topicIssues.length > 0) {
        return [...topicIssues];
    }
    if (!isJsonObject(permissions)) {
        return [issue(path, 'invalid-permissions', 'Topic permissions must be an object.')];
    }
    const issues = [
        ...toKeyIssues(permissions, PERMISSION_KEYS, path),
        ...presentKeys(permissions, PERMISSION_KEYS)
            .filter((key) => typeof permissions[key] !== 'boolean')
            .map((key) => issue(`${path}.${key}`, 'invalid-boolean', `${key} must be a boolean.`))
    ];
    if (issues.length === 0 && permissions.publish !== true && permissions.subscribe !== true) {
        issues.push(issue(path, 'empty-permissions', 'A granted topic holds publish, subscribe or both.'));
    }
    return issues;
}

function toAuditIssues(audit: ApiJsonValue, path: string): Issues {
    if (!isJsonObject(audit)) {
        return [issue(path, 'invalid-audit-stamp', 'Audit stamp must be an object.')];
    }
    const atEpochMs = audit.atEpochMs;
    return [
        ...toKeyIssues(audit, AUDIT_KEYS, path),
        ...(atEpochMs === undefined || (Number.isSafeInteger(atEpochMs) && (atEpochMs as number) >= 0)
            ? []
            : [issue(`${path}.atEpochMs`, 'invalid-timestamp', 'atEpochMs must be a non-negative integer.')]),
        ...(audit.actor === undefined ? [] : toActorIssues(audit.actor, `${path}.actor`)),
        ...presentKeys(audit, ['reason', 'traceId', 'requestId'])
            .filter((key) => audit[key] !== null && typeof audit[key] !== 'string')
            .map((key) => issue(`${path}.${key}`, 'invalid-string', `${key} must be a string or null.`))
    ];
}

function toActorIssues(actor: ApiJsonValue, path: string): Issues {
    const kind = isJsonObject(actor) ? actor.kind : null;
    if (!isJsonObject(actor) || (kind !== 'principal' && kind !== 'session' && kind !== 'service')) {
        return [issue(path, 'invalid-actor', 'Actor must be a principal, session or service.')];
    }
    const keys = ACTOR_KEYS[kind];
    return [
        ...toKeyIssues(actor, keys, path),
        ...toNonEmptyStringIssues(actor, keys.filter((key) => key !== 'kind'), path)
    ];
}

/** An unknown key and a missing key, each reported once. */
function toKeyIssues(record: ApiJsonObject, keys: readonly string[], path: string): Issues {
    return [
        ...Object.keys(record).filter((key) => !keys.includes(key)).map((key) =>
            issue(`${path}.${key}`, 'unknown-key', `${key} is not a field of this record.`)
        ),
        ...keys.filter((key) => !Object.hasOwn(record, key)).map((key) =>
            issue(`${path}.${key}`, 'missing-key', `${key} is required.`)
        )
    ];
}

function toNonEmptyStringIssues(record: ApiJsonObject, keys: readonly string[], path: string): Issues {
    return presentKeys(record, keys)
        .filter((key) => typeof record[key] !== 'string' || record[key].length === 0)
        .map((key) => issue(`${path}.${key}`, 'invalid-string', `${key} must be a non-empty string.`));
}

function presentKeys<Key extends string>(record: ApiJsonObject, keys: readonly Key[]): readonly Key[] {
    return keys.filter((key) => Object.hasOwn(record, key));
}

function issue(path: string, code: string, message: string): RallarValidationIssue {
    return { path, code, message };
}

function isJsonObject(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
