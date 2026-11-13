import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';

test('default server construction reads no process environment below the startup boundary', async () => {
    // The composition injects its environment and configuration at the startup boundary; nothing below reads process.env.
    const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    try {
        const server = await createDefaultRallarServer({
            configuration: decodeApiV1Configuration(validDecodeApiV1ConfigurationInput()),
            databaseLifecycle
        });
        await server.runtime.readiness;
        await server.runtime.backgroundTasks.stop();
    }
    finally {
        await databaseLifecycle.close();
    }
});

test('default server construction closes the database lifecycle after partial failure', async () => {
    const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const configuration = decodeApiV1Configuration(validDecodeApiV1ConfigurationInput());
    let closeCalls = 0;

    await assert.rejects(
        () =>
            createDefaultRallarServer({
                configuration: {
                    ...configuration,
                    authentication: {
                        ...configuration.authentication,
                        credentialSecret: 'invalid'
                    }
                },
                databaseLifecycle: {
                    ...databaseLifecycle,
                    close: () => {
                        closeCalls += 1;
                        return databaseLifecycle.close();
                    }
                }
            }),
        /RALLAR_AUTH_CREDENTIAL_SECRET/u
    );

    assert.equal(closeCalls, 1);
});
