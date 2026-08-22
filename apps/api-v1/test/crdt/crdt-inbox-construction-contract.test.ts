import assert from 'node:assert/strict';

import type { CreateApiCrdtInboxServiceInput } from '../../src/crdt/\
create-api-crdt-inbox-service.ts';

import type { createApiCrdtInboxFactory } from '../../src/crdt/\
create-api-crdt-inbox-factory.ts';

type IsRequired<T, TKey extends keyof T> = Record<never, never> extends Pick<T, TKey> ? false :
    true;

type CrdtFactoryInput = Parameters<typeof createApiCrdtInboxFactory>[0];

const REQUIRED_CONSTRUCTION_INPUTS: readonly boolean[] = [
    true satisfies IsRequired<CreateApiCrdtInboxServiceInput, 'currentAuthority'>,
    true satisfies IsRequired<CreateApiCrdtInboxServiceInput, 'policies'>,
    true satisfies IsRequired<CrdtFactoryInput, 'currentAuthority'>,
    true satisfies IsRequired<CrdtFactoryInput, 'policies'>
];

Deno.test('lower CRDT inbox construction requires resolved authority and policy inputs', () => {
    assert.deepEqual(REQUIRED_CONSTRUCTION_INPUTS, [true, true, true, true]);
});
