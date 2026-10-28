import assert from 'node:assert/strict';

import { createRelicGame } from '@relic-hunters/mod.ts';

import { withPGliteSql } from '@api-v1/test/db/pglite-auth-test-harness.ts';
import { createTracedApiTestApp } from '@api-v1/test/services/create-traced-api-test-app.ts';
import { initRelicGameRoutes } from '../src/relic-game-routes.ts';
import { installRelicHunterGame } from '../src/relic-game-service.ts';
import {
    createRelicTestStack,
    drainRelicTestInbox,
    readRelicPublicationTraces,
    RELIC_TEST_GAME_ID
} from './relic-game-test-runtime.ts';

Deno.test('a Relic REST reset publishes under the x-request-id of its request', async () => {
    await withPGliteSql(async (database) => {
        const stack = await createRelicTestStack(database);
        const relicGame = installRelicHunterGame({
            ws: { serverPeerId: 'default-qbox-server', defineTopic: () => {}, on: () => {} }
        }, {
            mode: 'authenticated',
            inbox: stack.services.relicGameInboxService,
            mutations: stack.services.relicGameMutations,
            createInitialState: async (gameId) => createRelicGame(gameId, gameId, Date.now()),
            readSession: (sessionId) => stack.sessions.findBySessionId(sessionId)
        });
        const app = initRelicGameRoutes(createTracedApiTestApp(), { relicGame, sessions: stack.sessions });

        const response = await drainRelicTestInbox(
            stack.reader,
            Promise.resolve(app.request(`/api/relic/games/${RELIC_TEST_GAME_ID}/reset/requests/traced-reset`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${stack.owner.accessToken}`,
                    'x-client-id': stack.owner.clientId,
                    'x-request-id': 'trace-relic-rest-reset'
                }
            }))
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-request-id'), 'trace-relic-rest-reset');
        const traces = await readRelicPublicationTraces(database);
        assert.ok(traces.length > 0);
        assert.deepEqual(new Set(traces), new Set(['trace-relic-rest-reset']));
    });
});
