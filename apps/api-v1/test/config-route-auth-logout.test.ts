import assert from 'node:assert/strict';
import { closeLiveAuthSessionSocket } from '../src/routes/config-route.ts';

Deno.test('logout websocket cleanup closes only the current auth session socket', () => {
  const calls: Array<{ sessionId: string; code?: number; reason?: string }> = [];

  closeLiveAuthSessionSocket('session-a', {
    readMiddleware: () =>
      ({
        wsQBoxServerService: {
          socket: {
            closeConnection(
              sessionId: string,
              code?: number,
              reason?: string,
            ): boolean {
              calls.push({ sessionId, code, reason });
              return true;
            },
          },
        },
      }) as never,
  });

  assert.deepEqual(calls, [
    {
      sessionId: 'session-a',
      code: 1000,
      reason: 'auth-logout',
    },
  ]);
});

Deno.test('logout websocket cleanup is best effort when middleware is unavailable', () => {
  const warnings: unknown[][] = [];

  assert.doesNotThrow(() =>
    closeLiveAuthSessionSocket('session-a', {
      readMiddleware: () => {
        throw new Error('Middleware not initialised');
      },
      logger: {
        warn: (...args: unknown[]) => warnings.push(args),
      },
    })
  );
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to close live websocket session after logout/);
});
