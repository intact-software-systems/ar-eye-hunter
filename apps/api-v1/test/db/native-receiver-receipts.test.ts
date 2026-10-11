import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

Deno.test('automatic fourteen-receiver receipts complete through native API WebSockets after held ACK release', async () => {
    const apiConfigurationUrl = new URL('../../deno.json', import.meta.url);
    const rootConfigurationUrl = new URL('../../../../deno.json', import.meta.url);
    const [apiImports, rootImports] = await Promise.all([
        readNativeReceiptDenoImports(apiConfigurationUrl),
        readNativeReceiptDenoImports(rootConfigurationUrl)
    ]);
    const browserTarget = rootImports['@shared-web/'];
    assert.ok(browserTarget, 'The root configuration must own the browser package mapping');
    const nativeReceiptImports: Record<string, string> = Object.fromEntries(
        Object.entries(apiImports).map(([specifier, target]) => [specifier, new URL(target, apiConfigurationUrl).href])
    );
    nativeReceiptImports['@shared-web/'] = new URL(browserTarget, rootConfigurationUrl).href;
    const temporaryDirectory = await Deno.makeTempDir({ prefix: 'native-receipt-import-map-' });
    const importMapPath = join(temporaryDirectory, 'import-map.json');
    let child: Deno.ChildProcess | undefined;
    let primaryFailure: Error | undefined;
    const cleanupFailures: Error[] = [];

    try {
        await Deno.writeTextFile(importMapPath, JSON.stringify({ imports: nativeReceiptImports }));
        child = new Deno.Command(Deno.execPath(), {
            args: [
                'test',
                '--config',
                fileURLToPath(apiConfigurationUrl),
                '--import-map',
                importMapPath,
                '--lock',
                fileURLToPath(new URL('../../deno.lock', import.meta.url)),
                '--frozen',
                '--allow-env',
                '--allow-read',
                '--allow-write',
                '--allow-net=127.0.0.1',
                '--no-prompt',
                fileURLToPath(
                    new URL(
                        '../../../../packages/tests/shared-server/rallar-system/websocket/native-receiver-receipts-child.ts',
                        import.meta.url
                    )
                )
            ],
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            signal: AbortSignal.timeout(180_000),
            stdout: 'inherit',
            stderr: 'piped'
        }).spawn();
        const output = await child.output();
        Deno.stderr.writeSync(output.stderr);
        assert.equal(output.success, true, new TextDecoder().decode(output.stderr));
    }
    catch (error) {
        primaryFailure = toNativeReceiptFailure(error);
    }
    finally {
        try {
            await child?.status;
        }
        catch (error) {
            cleanupFailures.push(new Error('Native receipt child completion failed', { cause: toNativeReceiptFailure(error) }));
        }
        try {
            await Deno.remove(temporaryDirectory, { recursive: true });
        }
        catch (error) {
            cleanupFailures.push(
                new Error('Native receipt temporary import-map removal failed', { cause: toNativeReceiptFailure(error) })
            );
        }
    }
    if (primaryFailure) {
        try {
            if (cleanupFailures.length > 0) {
                console.error('Native receipt secondary cleanup failures', new AggregateError(cleanupFailures));
            }
        }
        catch (error) {
            cleanupFailures.push(
                new Error('Native receipt secondary cleanup reporting failed', { cause: toNativeReceiptFailure(error) })
            );
        }
        throw primaryFailure;
    }
    if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, 'Native receipt cleanup failed');
    }
});

async function readNativeReceiptDenoImports(configurationUrl: URL): Promise<Readonly<Record<string, string>>> {
    const configuration: unknown = JSON.parse(await Deno.readTextFile(configurationUrl));
    assert.ok(
        typeof configuration === 'object' && configuration !== null && !Array.isArray(configuration) &&
            'imports' in configuration,
        `${configurationUrl.href} must contain an imports object`
    );
    const imports = configuration.imports;
    assert.ok(typeof imports === 'object' && imports !== null && !Array.isArray(imports));
    for (const [specifier, target] of Object.entries(imports)) {
        assert.equal(typeof target, 'string', `${configurationUrl.href}: ${specifier} must have a string target`);
    }
    return imports as Readonly<Record<string, string>>;
}

function toNativeReceiptFailure(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
