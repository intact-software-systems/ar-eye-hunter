import assert from 'node:assert/strict';

import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';

Deno.test({
    name: 'default server constructs the complete runtime from explicit operational configuration',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
        try {
            const server = await createDefaultRallarServer({
                configuration: decodeApiV1Configuration(validDecodeApiV1ConfigurationInput()),
                databaseLifecycle,
                ws: {
                    allowImplicitUserTopics: false,
                    defaultFanout: 'live-only'
                }
            });

            assert.ok(server.runtime.authSessionRepository);
            assert.ok(server.runtime.groupStateService);
            assert.ok(server.runtime.backgroundTasks);
            server.installSystemTopics().installWebSocketLifecycle();
            await server.runtime.readiness;
            await server.runtime.backgroundTasks.stop();
        }
        finally {
            await databaseLifecycle.close();
        }
    }
});
