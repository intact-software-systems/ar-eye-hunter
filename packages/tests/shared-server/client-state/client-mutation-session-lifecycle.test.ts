import { describe, expect, it } from 'vitest';

import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { computeClientSessionConnect } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-session-connect.ts';
import { computeClientSessionDisconnect } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-session-disconnect.ts';
import { computeClientSessionExpiry } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-session-expiry.ts';
import { computeClientSessionHeartbeat } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-session-heartbeat.ts';

import {
  connectCommand,
  disconnectCommand,
  emptyRead,
  expiryCommand,
  heartbeatCommand,
  readAfterWrite,
  requireWrite,
  sessionFrom,
} from './client-mutation-compute-test-fixtures.ts';

describe('client session lifecycle compute', () => {
  it('routes connect and heartbeat directly to their named family owners', async () => {
    const connect = await connectCommand();
    const connectRead = emptyRead(connect);
    const connected = requireWrite(
      computeClientSessionConnect({
        command: connect,
        read: connectRead,
      }),
    );
    expect(computeClientMutation({ command: connect, read: connectRead })).toEqual(connected);
    expect(sessionFrom(connected)).toMatchObject({
      generationId: 'generation-1',
      generationVersion: 1,
      status: 'active',
      connectedAtEpochMs: 2_000,
      expiresAtEpochMs: 8_000,
    });

    const heartbeat = await heartbeatCommand();
    const heartbeatRead = readAfterWrite(heartbeat, connected);
    const heartbeated = requireWrite(
      computeClientSessionHeartbeat({
        command: heartbeat,
        read: heartbeatRead,
      }),
    );
    expect(computeClientMutation({ command: heartbeat, read: heartbeatRead })).toEqual(heartbeated);
    expect(sessionFrom(heartbeated)).toMatchObject({
      presenceState: 'away',
      lastHeartbeatAtEpochMs: 3_000,
      expiresAtEpochMs: 9_000,
    });
  });

  it('routes disconnect and expiry while rejecting stale generations as non-persisted no-ops', async () => {
    const connect = await connectCommand();
    const connected = requireWrite(
      computeClientMutation({
        command: connect,
        read: emptyRead(connect),
      }),
    );
    const disconnect = await disconnectCommand();
    const disconnectRead = readAfterWrite(disconnect, connected);
    const disconnected = requireWrite(
      computeClientSessionDisconnect({
        command: disconnect,
        read: disconnectRead,
      }),
    );
    expect(computeClientMutation({ command: disconnect, read: disconnectRead })).toEqual(
      disconnected,
    );
    expect(sessionFrom(disconnected)).toMatchObject({
      status: 'disconnected',
      disconnectedAtEpochMs: 4_000,
      disconnectReason: 'closed',
    });

    const stale = await disconnectCommand('disconnect-stale', 'generation-stale');
    expect(
      computeClientSessionDisconnect({
        command: stale,
        read: readAfterWrite(stale, connected),
      }),
    ).toMatchObject({ outcome: 'no-op', persistIdempotency: false });

    const expiry = await expiryCommand();
    const expiryRead = readAfterWrite(expiry, connected);
    const expired = requireWrite(computeClientSessionExpiry({ command: expiry, read: expiryRead }));
    expect(computeClientMutation({ command: expiry, read: expiryRead })).toEqual(expired);
    expect(sessionFrom(expired)).toMatchObject({
      status: 'expired',
      disconnectedAtEpochMs: 8_000,
      disconnectReason: 'expired',
    });
  });
});
