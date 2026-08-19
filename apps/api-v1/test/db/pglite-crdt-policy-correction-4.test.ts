import assert from 'node:assert/strict';

import {
  evaluateRallarCrdtFeaturePolicy,
  type RallarCrdtDocumentRef,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
// deno-fmt-ignore
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/\
psql-crdt-log-repository.ts';

import {
  readConfiguredCrdtPolicies,
} from '../../src/services/create-api-mutation-inbox-factories.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';

const ENVIRONMENT_KEY = 'RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON';
const DOCUMENT: RallarCrdtDocumentRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  scope: 'app',
  documentType: 'checklist',
  documentId: 'document-1',
};

Deno.test(
  'configured CRDT policy decoder rejects unknown and malformed nested fields',
  async () => {
    await withPolicyEnvironment(() => {
      const invalid = [
        { documentType: 'checklist', rollout: 'production', unknown: true },
        { documentType: 'checklist', rollout: 'production', applicationId: '' },
        { documentType: 'checklist', rollout: 'production', workspaceId: 7 },
        { documentType: 'checklist', rollout: 'production', scope: 'workspace' },
        { documentType: 'checklist', rollout: 'production', flags: { ws: 'yes' } },
        { documentType: 'checklist', rollout: 'production', flags: { extra: true } },
        { documentType: 'checklist', rollout: 'production', quota: { maxUpdateBytes: 0 } },
        { documentType: 'checklist', rollout: 'production', quota: { extra: 1 } },
        { documentType: 'checklist', rollout: 'production', retention: { mode: 'later' } },
        {
          documentType: 'checklist',
          rollout: 'production',
          retention: { mode: 'delete-after' },
        },
        {
          documentType: 'checklist',
          rollout: 'production',
          retention: { mode: 'retain', extra: true },
        },
        { documentType: 'checklist', rollout: 'production', sensitiveFields: [''] },
        {
          documentType: 'checklist',
          rollout: 'production',
          sensitiveFields: ['secret', 'secret'],
        },
      ];
      for (const policy of invalid) {
        Deno.env.set(ENVIRONMENT_KEY, JSON.stringify([policy]));
        assert.throws(() => readConfiguredCrdtPolicies(), /policy|field|invalid/i);
      }
    });
  },
);

Deno.test('configured CRDT policy decoder preserves the exact valid rollout contract', async () => {
  await withPolicyEnvironment(() => {
    const policy = {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      scope: 'app',
      documentType: 'checklist',
      rollout: 'durable-beta',
      flags: {
        networkSend: true,
        ws: true,
        rtc: false,
        durableAppend: true,
        peerCatchUp: false,
        readOnly: false,
        appScope: true,
        customScope: false,
        graphDocuments: false,
        sequenceTextDocuments: true,
        killSwitchReason: 'operator controlled',
      },
      quota: {
        maxUpdateBytes: 1024,
        maxDocumentBytes: 4096,
        maxUpdateCount: 10,
        maxPendingUpdatesPerReplica: 3,
        maxUpdatesPerMinutePerActor: 4,
      },
      retention: {
        mode: 'delete-after',
        ttlMs: 60_000,
        sensitivePayloads: true,
        reason: 'privacy',
      },
      sensitiveFields: ['token', 'secret'],
    } as const;
    Deno.env.set(ENVIRONMENT_KEY, JSON.stringify([policy]));

    assert.deepEqual(readConfiguredCrdtPolicies(), [policy]);
  });
});

Deno.test(
  'operator CRDT status defaults disabled and matches configured mutation policy',
  async () => {
    await withPolicyEnvironment(async () => {
      await withPGliteSql(async (sql) => {
        await insertDocument(sql);
        Deno.env.delete(ENVIRONMENT_KEY);
        assert.deepEqual(readConfiguredCrdtPolicies(), [{
          documentType: '*',
          rollout: 'disabled',
        }]);
        const defaultStatus = await new PSqlCrdtLogRepository(sql).listDocuments();
        assert.equal(defaultStatus.documents[0]?.rollout, 'disabled');

        Deno.env.set(
          ENVIRONMENT_KEY,
          JSON.stringify([{
            documentType: 'checklist',
            rollout: 'durable-beta',
            scope: 'app',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            flags: { appScope: true },
          }]),
        );
        const policies = readConfiguredCrdtPolicies();
        const mutation = evaluateRallarCrdtFeaturePolicy({
          document: DOCUMENT,
          operation: 'durable-append',
          policies,
        });
        const admin = await new PSqlCrdtLogRepository(sql, { policies }).listDocuments();

        assert.equal(admin.documents[0]?.rollout, mutation.rollout);
        const productionSource = await Deno.readTextFile(
          new URL(
            '../../src/composition/create-default-rallar-server.ts',
            import.meta.url,
          ),
        );
        assert.match(productionSource, /readConfiguredCrdtPolicies/);
        assert.match(productionSource, /PSqlCrdtLogRepository[\s\S]*policies/);
      });
    });
  },
);

async function insertDocument(
  sql: Parameters<Parameters<typeof withPGliteSql>[0]>[0],
): Promise<void> {
  const documentKey = toRallarCrdtDocumentKey(DOCUMENT);
  await sql`
        insert into crdt_documents (
            document_key, application_id, workspace_id, document_scope,
            document_type, document_id, document_ref, document_revision,
            lifecycle, created_at_ts, updated_at_ts, last_append_sequence,
            update_count, snapshot_count, stored_update_bytes, projection_ids
        ) values (
            ${documentKey}, ${DOCUMENT.applicationId}, ${DOCUMENT.workspaceId},
            ${DOCUMENT.scope}, ${DOCUMENT.documentType}, ${DOCUMENT.documentId},
            ${JSON.stringify(DOCUMENT)}, 1, 'active', ${new Date(1_000)},
            ${new Date(1_000)}, 0, 0, 0, 0, '[]'
        )
    `;
}

async function withPolicyEnvironment<T>(run: () => T | Promise<T>): Promise<T> {
  const previous = Deno.env.get(ENVIRONMENT_KEY);
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      Deno.env.delete(ENVIRONMENT_KEY);
    } else {
      Deno.env.set(ENVIRONMENT_KEY, previous);
    }
  }
}
