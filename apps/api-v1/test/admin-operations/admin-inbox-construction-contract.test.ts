import type { CreateApiAdminInboxServiceInput } from '../../src/admin-operations/create-api-admin-inbox-service.ts';

type IsRequired<T, TKey extends keyof T> = Record<never, never> extends Pick<T, TKey> ? false :
    true;

const constructionRequirements: readonly true[] = [
    true satisfies IsRequired<CreateApiAdminInboxServiceInput, 'currentAuthority'>
];

Deno.test('admin inbox construction requires current authority', () => {
    if (constructionRequirements.some((requirement) => !requirement)) {
        throw new Error('Admin inbox construction requirements changed');
    }
});
