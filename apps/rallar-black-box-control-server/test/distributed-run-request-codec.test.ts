import { assertEquals } from '@std/assert';

import { decodeDistributedRunManifestRequest } from '../src/routes/distributed-run-request-codec.ts';
import { distributedManifest } from './support/control-api-test-fixtures.ts';

Deno.test('manifest request decoding accepts a wrapped or bare strict v1 manifest', () => {
    const wrapped = decodeDistributedRunManifestRequest({ manifest: distributedManifest() });
    const bare = decodeDistributedRunManifestRequest(distributedManifest());

    assertEquals(wrapped.left, undefined);
    assertEquals(wrapped.right?.distributedRunId, 'api-dist-1');
    assertEquals(bare.right, wrapped.right);
});

Deno.test('manifest request decoding accepts explicit run Off after a JSON round trip', () => {
    const manifest = {
        schemaVersion: 1 as const,
        distributedRunId: 'capture-admission',
        controlRunId: 'capture-control',
        rtcCaptureMode: 'off' as const,
        group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'capture-group' },
        recipes: [{
            recipeId: 'capture-recipe',
            recipe: { schemaVersion: 1 as const, recipeId: 'capture-recipe', commands: [{ kind: 'health' as const }] },
            variables: {}
        }],
        targetPolicy: { mode: 'selected-agents' as const, agentIds: ['capture-agent'] },
        startMode: 'manual' as const,
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 1_000,
        barrier: { enabled: false as const },
        groupAssertions: [],
        metadata: {}
    };

    const decoded = decodeDistributedRunManifestRequest(JSON.parse(JSON.stringify({ manifest })));

    assertEquals(decoded.left, undefined);
    assertEquals(decoded.right, manifest);
});

for (const mode of ['off', 'signaling', 'native'] as const) {
    Deno.test(`manifest request decoding preserves serialized run ${mode}`, () => {
        const manifest = { ...distributedManifest(), rtcCaptureMode: mode };
        const decoded = decodeDistributedRunManifestRequest(JSON.parse(JSON.stringify(manifest)));

        assertEquals(decoded.left, undefined);
        const serialized: unknown = JSON.parse(JSON.stringify(decoded.right));
        assertEquals(serialized, manifest);
    });
}

Deno.test('manifest request decoding leaves omitted run capture absent', () => {
    const decoded = decodeDistributedRunManifestRequest(JSON.parse(JSON.stringify(distributedManifest())));

    assertEquals(decoded.left, undefined);
    assertEquals(Object.hasOwn(decoded.right ?? {}, 'rtcCaptureMode'), false);
});

for (const invalid of ['', 'inherit', 'full-native', 'OFF', null, true, 1, {}, []]) {
    Deno.test(`manifest request decoding rejects invalid run capture ${JSON.stringify(invalid)}`, () => {
        const decoded = decodeDistributedRunManifestRequest(JSON.parse(JSON.stringify({
            ...distributedManifest(),
            rtcCaptureMode: invalid
        })));

        assertEquals(decoded.right, undefined);
        assertEquals(decoded.left?.startsWith('$.rtcCaptureMode:'), true);
    });
}

Deno.test('manifest request decoding rejects an unversioned inline recipe at the schema', () => {
    const manifest = distributedManifest();
    const unversioned = {
        ...manifest,
        recipes: [{
            recipeId: 'api-health',
            recipe: { recipeId: 'api-health', commands: [] },
            variables: {}
        }]
    };

    const decoded = decodeDistributedRunManifestRequest({ manifest: unversioned });

    assertEquals(decoded.right, undefined);
    assertEquals(decoded.left, '$.recipes[0].recipe: Missing required property schemaVersion.');
});

Deno.test('manifest request decoding rejects the removed recipe selection required flag', () => {
    const manifest = distributedManifest();
    const flagged = {
        ...manifest,
        recipes: manifest.recipes.map((selection) => ({ ...selection, required: true }))
    };

    const decoded = decodeDistributedRunManifestRequest({ manifest: flagged });

    assertEquals(decoded.right, undefined);
    assertEquals(decoded.left, '$.recipes[0].required: Unexpected property.');
});

Deno.test('manifest request decoding reports contract issues after the schema passes', () => {
    const decoded = decodeDistributedRunManifestRequest({
        manifest: { ...distributedManifest(), distributedRunId: ' ' }
    });

    assertEquals(decoded.right, undefined);
    assertEquals(decoded.left, '$.distributedRunId: A non-empty string is required.');
});
