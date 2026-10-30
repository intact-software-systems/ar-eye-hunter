import {
    decodeGroupTopicSubscription,
    GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
    validateGroupTopicSubscription,
    type GroupTopicSubscription
} from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { describe, expect, it } from 'vitest';

const SUBSCRIPTION: GroupTopicSubscription = {
    sessionId: 'bob-session',
    principalId: 'bob',
    topicId: 'room.feed',
    connectionGenerationId: 'bob-ws-generation-1',
    leaseExpiresAtEpochMs: 1_000 + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
    admittedAtGroupRevision: 4
};

function decodeIssues(value: unknown): readonly RallarValidationIssue[] {
    return decodeGroupTopicSubscription(value).fold((issues) => issues, () => []);
}

describe('group topic subscription contract', () => {
    it('decodeGroupTopicSubscription returns a complete row unchanged', () => {
        expect(GROUP_TOPIC_SUBSCRIPTION_LEASE_MS).toBe(120_000);
        expect(decodeGroupTopicSubscription(structuredClone(SUBSCRIPTION)).fold(() => undefined, (row) => row))
            .toEqual(SUBSCRIPTION);
    });

    it('refuses an extra key and names its path', () => {
        expect(decodeIssues({ ...SUBSCRIPTION, extra: true }).map((issue) => issue.path)).toEqual(['$.extra']);
    });

    it('refuses a reserved or prefix-less topic id', () => {
        for (const topicId of ['rallar.state', 'feed']) {
            expect(decodeIssues({ ...SUBSCRIPTION, topicId }).map((issue) => issue.path)).toEqual(['$.topicId']);
        }
    });

    it('refuses an empty connectionGenerationId and a non-positive lease', () => {
        expect(decodeIssues({ ...SUBSCRIPTION, connectionGenerationId: '' }).map((issue) => issue.path))
            .toEqual(['$.connectionGenerationId']);
        for (const leaseExpiresAtEpochMs of [0, -1, 1.5]) {
            expect(decodeIssues({ ...SUBSCRIPTION, leaseExpiresAtEpochMs }).map((issue) => issue.path))
                .toEqual(['$.leaseExpiresAtEpochMs']);
        }
    });

    it('refuses a value that is not an object', () => {
        expect(decodeIssues(null).map((issue) => issue.path)).toEqual(['$']);
    });

    it('validateGroupTopicSubscription returns every issue, not the first', () => {
        const issues = validateGroupTopicSubscription({
            ...SUBSCRIPTION,
            sessionId: '',
            topicId: 'feed',
            admittedAtGroupRevision: -1
        });

        expect(issues.map((issue) => issue.path)).toEqual(['$.sessionId', '$.topicId', '$.admittedAtGroupRevision']);
    });
});
