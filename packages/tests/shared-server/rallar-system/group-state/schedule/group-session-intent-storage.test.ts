import { GROUP_SESSION_INTENTS_NAMESPACE, groupSessionIntentKey } from '@shared-server/rallar-system/group-state/schedule/group-session-intent-storage.ts';
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
