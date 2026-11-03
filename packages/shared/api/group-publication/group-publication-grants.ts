import { Either } from '../../resilience/Either.ts';
import type { ApiJsonObject, ApiJsonValue } from '../api-json-value.ts';
import { isSameGroupRef } from '../api-type-utils.ts';
import type { AuditStamp, GroupMember, GroupRef, GroupSnapshot, PrincipalId } from '../group-types.ts';
import { validateRallarWsUserTopicId, type RallarValidationIssue } from '../rallar-validation.ts';
import {
    isJsonObject,
    isNonEmptyString,
    presentKeys,
    toIssue,
    toKeyIssues,
    toNonEmptyStringIssues
} from './group-publication-validation-issues.ts';

export interface GroupPublicationTopicPermissions {
    readonly publish: boolean;
    readonly subscribe: boolean;
}

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
        : [toIssue('$', 'invalid-record', 'Publication grant must be an object.')];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(value as GroupPublicationGrant);
}

export function validateGroupPublicationGrant(grant: GroupPublicationGrant): readonly RallarValidationIssue[] {
    return decodeGroupPublicationGrant(grant).fold((issues) => issues, () => []);
}

/** A creation's declared grant: up to 64 exact user topics, each naming publish, subscribe or both; `{}` declares none. */
export function decodeGroupPublicationTopicGrants(
    value: unknown
): Either<readonly RallarValidationIssue[], GroupPublicationTopicGrants> {
    const issues = isJsonObject(value)
        ? toTopicsIssues(value, '$', 0)
        : [toIssue('$', 'invalid-topics', 'Publication grant topics must be an object.')];
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(value as GroupPublicationTopicGrants);
}

/** A snapshot's or delta's grant rows: each a valid row of the group, listed once per principal in principal order. */
export function decodeGroupPublicationGrantList(
    value: unknown,
    ref: GroupRef
): Either<readonly RallarValidationIssue[], readonly GroupPublicationGrant[]> {
    if (!Array.isArray(value)) {
        return Either.ofLeft([toIssue('$', 'invalid-list', 'Publication grants must be an array.')]);
    }
    const issues = toGrantListIssues(value, ref);
    return issues.length > 0 ? Either.ofLeft(issues) : Either.ofRight(value as readonly GroupPublicationGrant[]);
}

function toGrantListIssues(grants: readonly ApiJsonValue[], ref: GroupRef): Issues {
    return grants.flatMap((grant, index) => {
        const path = `$[${index}]`;
        return decodeGroupPublicationGrant(grant).fold(
            (issues) => issues.map((found) => ({ ...found, path: found.path.replace(/^\$/u, path) })),
            (row) => toListedGrantIssues({ row, previous: grants[index - 1], ref, path })
        );
    });
}

interface ListedGrant {
    readonly row: GroupPublicationGrant;
    readonly previous: ApiJsonValue | undefined;
    readonly ref: GroupRef;
    readonly path: string;
}

function toListedGrantIssues({ row, previous, ref, path }: ListedGrant): Issues {
    const previousPrincipalId = isJsonObject(previous) ? previous.principalId : undefined;
    return [
        ...(isSameGroupRef(row, ref)
            ? []
            : [toIssue(path, 'foreign-group', 'Publication grant belongs to another group.')]),
        ...(typeof previousPrincipalId !== 'string' ||
                comparePublicationGrantPrincipalIds(previousPrincipalId, row.principalId) < 0
            ? []
            : [toIssue(path, 'unsorted', 'Publication grants are listed in strictly ascending principalId order.')])
    ];
}

/** The one order of grant rows: code-unit order of the principal id. */
export function comparePublicationGrantPrincipalIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * What a principal may do on one topic: the row's permissions while it is an active member, and never publish as a
 * spectator (D501). A demoted principal keeps its row, so the row and the effective permission can differ.
 */
export function resolveGroupPublicationPermissions(
    snapshot: GroupSnapshot,
    principalId: string,
    topicId: string
): GroupPublicationTopicPermissions {
    return resolveMemberPublicationPermissions(
        snapshot.members.find((candidate) => candidate.principalId === principalId) ?? null,
        snapshot.publicationGrants.find((grant) => grant.principalId === principalId) ?? null,
        topicId
    );
}

/** D501 on one member's own rows: the member row and the grant row of the same principal, either absent. */
export function resolveMemberPublicationPermissions(
    member: GroupMember | null,
    grant: GroupPublicationGrant | null,
    topicId: string
): GroupPublicationTopicPermissions {
    const topics = member?.status === 'active' ? grant?.topics : undefined;
    const permissions = topics !== undefined && Object.hasOwn(topics, topicId) ? topics[topicId] : undefined;
    return {
        publish: member?.role !== 'spectator' && permissions?.publish === true,
        subscribe: permissions?.subscribe === true
    };
}

function toGrantIssues(grant: ApiJsonObject): Issues {
    return [
        ...toKeyIssues(grant, GRANT_KEYS, '$'),
        ...toNonEmptyStringIssues(grant, ['applicationId', 'workspaceId', 'groupId', 'principalId'], '$'),
        ...(grant.topics === undefined ? [] : toTopicsIssues(grant.topics, '$.topics', 1)),
        ...(grant.updated === undefined ? [] : toAuditIssues(grant.updated, '$.updated'))
    ];
}

function toTopicsIssues(topics: ApiJsonValue, path: string, minimumTopics: 0 | 1): Issues {
    if (!isJsonObject(topics)) {
        return [toIssue(path, 'invalid-topics', 'Publication grant topics must be an object.')];
    }
    const entries = Object.entries(topics);
    const max = GROUP_PUBLICATION_GRANT_LIMITS.maxTopicsPerPrincipal;
    return [
        ...(entries.length < minimumTopics || entries.length > max
            ? [
                toIssue(
                    path,
                    'invalid-topic-count',
                    `Publication grants hold ${minimumTopics} to ${max} topics per principal.`
                )
            ]
            : []),
        ...entries.flatMap(([topicId, permissions]) =>
            toTopicIssues(`${path}[${JSON.stringify(topicId)}]`, topicId, permissions)
        )
    ];
}

function toTopicIssues(path: string, topicId: string, permissions: ApiJsonValue): Issues {
    return [...validateRallarWsUserTopicId(topicId, path).issues, ...toPermissionIssues(path, permissions)];
}

function toPermissionIssues(path: string, permissions: ApiJsonValue): Issues {
    if (!isJsonObject(permissions)) {
        return [toIssue(path, 'invalid-permissions', 'Topic permissions must be an object.')];
    }
    const issues = [
        ...toKeyIssues(permissions, PERMISSION_KEYS, path),
        ...presentKeys(permissions, PERMISSION_KEYS)
            .filter((key) => typeof permissions[key] !== 'boolean')
            .map((key) => toIssue(`${path}.${key}`, 'invalid-boolean', `${key} must be a boolean.`))
    ];
    if (issues.length === 0 && permissions.publish !== true && permissions.subscribe !== true) {
        issues.push(toIssue(path, 'empty-permissions', 'A granted topic holds publish, subscribe or both.'));
    }
    return issues;
}

function toAuditIssues(audit: ApiJsonValue, path: string): Issues {
    if (!isJsonObject(audit)) {
        return [toIssue(path, 'invalid-audit-stamp', 'Audit stamp must be an object.')];
    }
    const atEpochMs = audit.atEpochMs;
    return [
        ...toKeyIssues(audit, AUDIT_KEYS, path),
        ...(atEpochMs === undefined || (Number.isSafeInteger(atEpochMs) && (atEpochMs as number) >= 0)
            ? []
            : [toIssue(`${path}.atEpochMs`, 'invalid-timestamp', 'atEpochMs must be a non-negative integer.')]),
        ...(audit.actor === undefined ? [] : toActorIssues(audit.actor, `${path}.actor`)),
        ...presentKeys(audit, ['reason', 'traceId', 'requestId'])
            .filter((key) => audit[key] !== null && !isNonEmptyString(audit[key]))
            .map((key) => toIssue(`${path}.${key}`, 'invalid-string', `${key} must be a non-empty string or null.`))
    ];
}

function toActorIssues(actor: ApiJsonValue, path: string): Issues {
    const kind = isJsonObject(actor) ? actor.kind : null;
    if (!isJsonObject(actor) || (kind !== 'principal' && kind !== 'session' && kind !== 'service')) {
        return [toIssue(path, 'invalid-actor', 'Actor must be a principal, session or service.')];
    }
    const keys = ACTOR_KEYS[kind];
    return [
        ...toKeyIssues(actor, keys, path),
        ...toNonEmptyStringIssues(actor, keys.filter((key) => key !== 'kind'), path)
    ];
}
