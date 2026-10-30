import type { RallarServerWsFanout } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { validateRallarWsUserTopicId, type RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ApiV1GrantedWsTopicConfiguration } from './api-v1-configuration.ts';

type Issues = RallarValidationIssue[];

const TOPIC_KEYS: ReadonlySet<string> = new Set(['topicId', 'typeId', 'fanout', 'serverProducerIds']);
const FANOUTS: ReadonlySet<string> = new Set<RallarServerWsFanout>(['live-only', 'outbox', 'none']);

/** The configured granted topics: exact keys, a user topic id, a known fanout, the producers' ids, each topic once. */
export function decodeApiV1GrantedWsTopics(
    value: unknown
): Either<readonly RallarValidationIssue[], readonly ApiV1GrantedWsTopicConfiguration[]> {
    if (!Array.isArray(value)) {
        return Either.ofLeft([issue('$', 'invalid-list', 'Granted WS topics must be an array.')]);
    }
    const decoded = value.map((topic, index) => decodeGrantedWsTopic(topic, `$[${index}]`));
    const issues = decoded.flatMap((topic) => topic.left ?? []);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const topics = decoded.map((topic) => topic.right!);
    return toDuplicateIssues(topics).length > 0 ? Either.ofLeft(toDuplicateIssues(topics)) : Either.ofRight(topics);
}

function decodeGrantedWsTopic(
    value: unknown,
    path: string
): Either<readonly RallarValidationIssue[], ApiV1GrantedWsTopicConfiguration> {
    if (!isJsonObject(value)) {
        return Either.ofLeft([issue(path, 'invalid-record', 'A granted WS topic must be an object.')]);
    }
    const { topicId, typeId, fanout, serverProducerIds } = value;
    const issues: Issues = [
        ...Object.keys(value).filter((key) => !TOPIC_KEYS.has(key))
            .map((key) => issue(`${path}.${key}`, 'unknown-key', `${key} is not a field of a granted WS topic.`)),
        ...validateRallarWsUserTopicId(topicId, `${path}.topicId`).issues
    ];
    if (typeId !== undefined && !isNonEmptyString(typeId)) {
        issues.push(issue(`${path}.typeId`, 'invalid-string', 'typeId must be a non-empty string.'));
    }
    if (!isFanout(fanout)) {
        issues.push(issue(`${path}.fanout`, 'invalid-fanout', 'fanout must be live-only, outbox or none.'));
    }
    if (!isNonEmptyStringList(serverProducerIds)) {
        issues.push(
            issue(`${path}.serverProducerIds`, 'invalid-list', 'serverProducerIds must list non-empty strings.')
        );
    }
    if (
        issues.length > 0 || !isNonEmptyString(topicId) || !isFanout(fanout) || !isNonEmptyStringList(serverProducerIds)
    ) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        topicId,
        ...(isNonEmptyString(typeId) ? { typeId } : {}),
        fanout,
        serverProducerIds: [...serverProducerIds]
    });
}

function toDuplicateIssues(topics: readonly ApiV1GrantedWsTopicConfiguration[]): Issues {
    const keys = topics.map((topic) => `${topic.topicId}/${topic.typeId ?? '*'}`);
    return keys.length === new Set(keys).size
        ? []
        : [issue('$', 'duplicate-topic', 'Each granted WS topic and type is configured once.')];
}

function issue(path: string, code: string, message: string): RallarValidationIssue {
    return { path, code, message };
}

function isJsonObject(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFanout(value: unknown): value is RallarServerWsFanout {
    return typeof value === 'string' && FANOUTS.has(value);
}

function isNonEmptyStringList(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}
