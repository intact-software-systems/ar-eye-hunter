import { describe, expect, it } from 'vitest';

import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { createAuthorityHarness } from '../inbox/group-state-inbox-test-runtime.ts';

const ref = { applicationId: 'app', workspaceId: 'workspace', groupId: 'session-room' };
const key = 'app=app:ws=workspace:group=session-room';
const namespace = 'group-state:session-reservations';
const value = { ...ref, scheduleRevision: 1, principalIds: ['alice'] };

describe('private session reservation storage', () => {
    it('reads the exact scoped private row and includes it in room retirement', async () => {
        const harness = await createAuthorityHarness([]);
        await harness.runtimeRepository.upsert(namespace, key, JSON.stringify(value), NEVER_EXPIRE_AT_TIMESTAMP);
        await harness.runtimeRepository.upsert(
            namespace,
            'app=app:ws=other:group=session-room',
            JSON.stringify({ ...value, workspaceId: 'other' }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        expect((await harness.repository.findSessionReservationsEntry(ref))?.value).toEqual(value);
        expect(await harness.repository.readRetirementEntries(ref)).toContainEqual({
            namespace,
            entry: expect.objectContaining({ key, value: JSON.stringify(value) })
        });
        expect((await harness.repository.readRetirementEntries(ref)).filter((entry) => entry.namespace === namespace))
            .toHaveLength(1);
    });

    it.each([
        { ...value, applicationId: 'foreign' },
        { ...value, workspaceId: 'foreign' },
        { ...value, groupId: 'foreign' },
        { ...value, principalIds: ['alice', 'alice'] },
        { ...value, scheduleRevision: 0 },
        { ...value, extra: true }
    ])('fails as typed corruption for an invalid stored row %j', async (corrupt) => {
        const harness = await createAuthorityHarness([]);
        await harness.runtimeRepository.upsert(namespace, key, JSON.stringify(corrupt), NEVER_EXPIRE_AT_TIMESTAMP);

        await expect(harness.repository.findSessionReservationsEntry(ref)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
        await expect(harness.repository.readRetirementEntries(ref)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    });
});
