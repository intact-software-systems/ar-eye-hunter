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

Deno.test('manifest request decoding rejects an unversioned inline recipe at the schema', () => {
    const manifest = distributedManifest();
    const unversioned = {
        ...manifest,
        recipes: [{
            recipeId: 'api-health',
            recipe: { recipeId: 'api-health', commands: [] },
            variables: {},
            required: true
        }]
    };

    const decoded = decodeDistributedRunManifestRequest({ manifest: unversioned });

    assertEquals(decoded.right, undefined);
    assertEquals(decoded.left, '$.recipes[0].recipe: Missing required property schemaVersion.');
});

Deno.test('manifest request decoding reports contract issues after the schema passes', () => {
    const decoded = decodeDistributedRunManifestRequest({
        manifest: { ...distributedManifest(), distributedRunId: ' ' }
    });

    assertEquals(decoded.right, undefined);
    assertEquals(decoded.left, '$.distributedRunId: A non-empty string is required.');
});
