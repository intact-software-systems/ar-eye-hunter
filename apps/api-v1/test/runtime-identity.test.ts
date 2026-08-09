import assert from 'node:assert/strict';

import {
  myProcessInstanceId,
  myPublisherId,
  myRtcTopologyStreamId,
  myServerId,
} from '../src/runtime/runtime-identity.ts';

Deno.test('runtime identity uses one full process UUID for QueueBox and topology delivery', () => {
  assert.match(
    myProcessInstanceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.equal(myPublisherId, myProcessInstanceId);
  assert.equal(myRtcTopologyStreamId, myProcessInstanceId);
  assert.equal(myServerId, `server-${myProcessInstanceId.substring(0, 8)}`);
});
