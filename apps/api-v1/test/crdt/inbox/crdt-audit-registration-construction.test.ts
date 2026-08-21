import assert from 'node:assert/strict';

import type { AppCrdtInboxService } from '@shared-server/rallar-system/crdt/inbox/\
app-crdt-inbox-service.ts';

import type { CreateApiCrdtInboxServiceInput } from '../../../src/crdt/\
create-api-crdt-inbox-service.ts';

Deno.test('CRDT inbox construction exposes one audit reader registration path', () => {
    const sharedDependenciesHaveTopLevelReader: 'outboxQueueReader' extends keyof AppCrdtInboxService.Dependencies ? true :
        false = false;
    const apiInputHasTopLevelReader: 'outboxQueueReader' extends keyof CreateApiCrdtInboxServiceInput ? true :
        false = false;

    assert.equal(sharedDependenciesHaveTopLevelReader, false);
    assert.equal(apiInputHasTopLevelReader, false);
});
