import { expect, it } from 'vitest';

import * as sharedServer from '@shared-server/mod.ts';

it('publishes state services while keeping event persistence behind feature owners', () => {
    expect(sharedServer.createClientStateService).toBeTypeOf('function');
    expect(sharedServer.createGroupStateService).toBeTypeOf('function');

    expect(sharedServer).not.toHaveProperty('createClientStateEventRepository');
    expect(sharedServer).not.toHaveProperty('createGroupStateEventRepository');
    expect(sharedServer).not.toHaveProperty('PSqlClientStateEventRepository');
    expect(sharedServer).not.toHaveProperty('PSqlGroupStateEventRepository');
});
