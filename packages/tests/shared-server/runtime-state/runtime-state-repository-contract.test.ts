import type { RuntimeStateEntry, RuntimeStateEntryPageOptions, RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { expectTypeOf, it } from 'vitest';

type RequiredPrefixPageRead = (
    namespace: string,
    keyPrefix: string,
    options: RuntimeStateEntryPageOptions
) => Promise<readonly RuntimeStateEntry[]>;

it('requires every runtime-state repository to provide bounded prefix reads', () => {
    expectTypeOf<RuntimeStateRepositoryLike['findEntriesByPrefixPage']>()
        .toEqualTypeOf<RequiredPrefixPageRead>();
});
