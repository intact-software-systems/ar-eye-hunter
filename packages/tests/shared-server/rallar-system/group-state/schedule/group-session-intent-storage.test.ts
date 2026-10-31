import {
    decodeGroupSessionIntentKey,
    GROUP_SESSION_INTENTS_NAMESPACE,
    groupSessionIntentKey
} from '@shared-server/rallar-system/group-state/schedule/group-session-intent-storage.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { createAuthorityHarness, SCOPE } from '../inbox/group-state-inbox-test-runtime.ts';

const ref = { ...SCOPE, groupId: 'scheduled-room' };

describe('private scheduled-session interest storage', () => {
    it('paginates only the current account and refuses a foreign cursor', async () => {
        const harness = await createAuthorityHarness([]);
        const alice = { ...ref, principalId: 'alice', reviewedScheduleRevision: 1 };
        const bob = { ...ref, groupId: 'unlisted-secret', principalId: 'bob', reviewedScheduleRevision: 1 };
        for (const intent of [alice, bob]) {
            await harness.runtimeRepository.upsert(
                GROUP_SESSION_INTENTS_NAMESPACE,
                groupSessionIntentKey(intent, intent.principalId),
                JSON.stringify(intent),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
        }
        expect(await harness.repository.listSessionIntentsPage(SCOPE, 'alice', null))
            .toEqual({ intents: [alice], nextKey: null });
        await expect(harness.repository.listSessionIntentsPage(SCOPE, 'alice', groupSessionIntentKey(bob, 'bob')))
            .rejects.toThrow('different account or scope');
    });

    it('keeps delimiter and percent-bearing account and room identities isolated', async () => {
        const harness = await createAuthorityHarness([]);
        const scoped = { applicationId: 'app:ws=x', workspaceId: '%:group=x', groupId: 'room:principal=other' };
        const accounts = ['alice', 'alice:group=room', 'alice%3Agroup%3Droom'];
        const keys = accounts.map((principalId) => groupSessionIntentKey(scoped, principalId));
        expect(new Set(keys).size).toBe(3);
        expect(keys[1]).toBe('app=app%3Aws%3Dx:ws=%25%3Agroup%3Dx:principal=alice%3Agroup%3Droom:group=room%3Aprincipal%3Dother');
        for (const principalId of accounts) {
            const intent = { ...scoped, principalId, reviewedScheduleRevision: 1 };
            const key = groupSessionIntentKey(scoped, principalId);
            expect(decodeGroupSessionIntentKey(key)).toEqual({ ...scoped, principalId });
            await harness.runtimeRepository.upsert(GROUP_SESSION_INTENTS_NAMESPACE, key, JSON.stringify(intent), NEVER_EXPIRE_AT_TIMESTAMP);
            expect(await harness.repository.listSessionIntentsPage(scoped, principalId, null)).toEqual({ intents: [intent], nextKey: null });
        }
        for (const key of [keys[0].replace('alice', '%61lice'), keys[0] + ':extra=x', keys[0].replace('alice', '')]) {
            expect(() => decodeGroupSessionIntentKey(key)).toThrow();
        }
    });

    it('retirement selects every account interest in exactly the retired room', async () => {
        const harness = await createAuthorityHarness([]);
        for (const [principalId, groupId] of [['alice', ref.groupId], ['bob', ref.groupId], ['alice', 'keep-room']]) {
            const intent = { ...ref, groupId, principalId, reviewedScheduleRevision: 1 };
            await harness.runtimeRepository.upsert(
                GROUP_SESSION_INTENTS_NAMESPACE,
                groupSessionIntentKey(intent, principalId),
                JSON.stringify(intent),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
        }
        const retired = await harness.repository.readRetirementEntries(ref);
        expect(
            retired.filter((entry) => entry.namespace === GROUP_SESSION_INTENTS_NAMESPACE)
                .map((entry) => entry.entry.key).sort()
        )
            .toEqual([groupSessionIntentKey(ref, 'alice'), groupSessionIntentKey(ref, 'bob')].sort());
    });

    it.each([
        ['malformed record', { invalid: true }],
        ['wrong application', { ...ref, applicationId: 'other', principalId: 'alice', reviewedScheduleRevision: 1 }],
        ['wrong workspace', { ...ref, workspaceId: 'other', principalId: 'alice', reviewedScheduleRevision: 1 }],
        ['wrong group', { ...ref, groupId: 'other', principalId: 'alice', reviewedScheduleRevision: 1 }],
        ['wrong account', { ...ref, principalId: 'bob', reviewedScheduleRevision: 1 }]
    ])('fails direct, page and retirement reads as typed corruption for %s', async (_label, value) => {
        const harness = await createAuthorityHarness([]);
        await harness.runtimeRepository.upsert(
            GROUP_SESSION_INTENTS_NAMESPACE,
            groupSessionIntentKey(ref, 'alice'),
            JSON.stringify(value),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await Promise.all([
            expect(harness.repository.findSessionIntentEntry(ref, 'alice')),
            expect(harness.repository.listSessionIntentsPage(SCOPE, 'alice', null)),
            expect(harness.repository.readRetirementEntries(ref))
        ].map((assertion) => assertion.rejects.toMatchObject({ code: 'group-state-repository-invariant-corruption' })));
    });

    it('rejects a payload whose account differs from the private physical key', async () => {
        const harness = await createAuthorityHarness([]);
        await harness.runtimeRepository.upsert(
            GROUP_SESSION_INTENTS_NAMESPACE,
            groupSessionIntentKey(ref, 'alice'),
            JSON.stringify({ ...ref, principalId: 'bob', reviewedScheduleRevision: 1 }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await expect(harness.repository.findSessionIntentEntry(ref, 'alice')).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    });
});
