import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from '../db/api-v1-test-pglite-database.ts';

Deno.test('default server construction reads no process environment below the startup boundary', async () => {
    const createDefaultUrl = new URL(
        '../../src/composition/create-default-rallar-server.ts',
        import.meta.url
    ).href;
    const decodeUrl = new URL(
        '../../src/configuration/decode-api-v1-configuration.ts',
        import.meta.url
    ).href;
    const fixtureUrl = new URL(
        '../configuration/api-v1-configuration-test-fixture.ts',
        import.meta.url
    ).href;
    const databaseUrl = new URL(
        '../db/api-v1-test-pglite-database.ts',
        import.meta.url
    ).href;
    const source = `
        import { createDefaultRallarServer } from ${JSON.stringify(createDefaultUrl)};
        import { decodeApiV1Configuration } from ${JSON.stringify(decodeUrl)};
        import { validDecodeApiV1ConfigurationInput } from ${JSON.stringify(fixtureUrl)};
        import { createApiV1TestPGliteDatabaseLifecycle } from ${JSON.stringify(databaseUrl)};

        let environmentDenied = false;
        try {
            Deno.env.get('API_V1_CONSTRUCTION_PERMISSION_PROBE');
        }
        catch (error) {
            environmentDenied = error instanceof Deno.errors.NotCapable;
        }
        if (!environmentDenied) {
            throw new Error('Expected environment access to fail');
        }
        const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
        const server = await createDefaultRallarServer({
            configuration: decodeApiV1Configuration(validDecodeApiV1ConfigurationInput()),
            databaseLifecycle
        });
        await server.runtime.readiness;
        await server.runtime.backgroundTasks.stop();
        Deno.exit(0);
    `;

    const testModule = await Deno.makeTempFile({ suffix: '.ts' });
    await Deno.writeTextFile(testModule, source);
    let output: Deno.CommandOutput;
    try {
        output = await new Deno.Command(Deno.execPath(), {
            args: [
                'run',
                `--config=${fileURLToPath(new URL('../../deno.json', import.meta.url))}`,
                '--allow-read',
                '--allow-write',
                '--no-prompt',
                testModule
            ],
            stdout: 'piped',
            stderr: 'piped'
        }).output();
    }
    finally {
        await Deno.remove(testModule);
    }

    assert.equal(
        output.success,
        true,
        new TextDecoder().decode(output.stderr)
    );
});

Deno.test('default server construction closes the database lifecycle after partial failure', async () => {
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
