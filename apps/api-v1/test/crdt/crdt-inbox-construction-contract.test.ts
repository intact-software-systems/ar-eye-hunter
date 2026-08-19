import assert from 'node:assert/strict';

// deno-fmt-ignore
import type { CreateApiCrdtInboxServiceInput } from '../../src/services/\
create-api-crdt-inbox-service.ts';
// deno-fmt-ignore
import type { createApiMutationInboxFactories } from '../../src/services/\
create-api-mutation-inbox-factories.ts';

type IsRequired<T, TKey extends keyof T> = {} extends Pick<T, TKey> ? false : true;

type MutationFactoryInput = Parameters<typeof createApiMutationInboxFactories>[0];

const REQUIRED_CONSTRUCTION_INPUTS: readonly boolean[] = [
  true satisfies IsRequired<CreateApiCrdtInboxServiceInput, 'currentAuthority'>,
  true satisfies IsRequired<CreateApiCrdtInboxServiceInput, 'policies'>,
  true satisfies IsRequired<MutationFactoryInput, 'currentAuthority'>,
  true satisfies IsRequired<MutationFactoryInput, 'crdtPolicies'>,
];

Deno.test('lower CRDT inbox construction requires resolved authority and policy inputs', () => {
  assert.deepEqual(REQUIRED_CONSTRUCTION_INPUTS, [true, true, true, true]);
});
