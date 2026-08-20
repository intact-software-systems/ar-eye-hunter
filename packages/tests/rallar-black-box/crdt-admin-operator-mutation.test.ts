import { describe, expect, it } from 'vitest';

import {
  isCrdtAdminOperatorMutationAction,
  toCrdtAdminOperatorMutationRequest,
} from '../../../apps/rallar-black-box/src/legacy/diagnostics/crdt/crdt-admin-operator-mutation.ts';

describe('CRDT admin operator mutations', () => {
  it.each([
    ['compact', '/compact', 'black-box-crdt-health-compaction'],
    ['rebuild', '/rebuild-projection', undefined],
    ['archive', '/lifecycle', undefined],
    ['quarantine', '/lifecycle', undefined],
    ['destroy', '/erase', 'black-box-crdt-health-destroy'],
  ] as const)('uses a strict path-only request ID for %s', (action, suffix, reason) => {
    const request = toCrdtAdminOperatorMutationRequest({
      action,
      changedAtEpochMs: 1_234,
      document: {
        applicationId: 'app',
        workspaceId: 'workspace',
        scope: 'app',
        documentType: 'test',
        documentId: 'secret-document',
      },
      requestId: `opaque-${action}-request-id`,
    });

    expect(request.path).toBe(
      `/api/crdt/admin/documents${suffix}/requests/opaque-${action}-request-id`,
    );
    expect(request.body).not.toHaveProperty('requestId');
    if (reason !== undefined) {
      expect(request.body).toHaveProperty('reason', reason);
    }
  });

  it('classifies only AppInbox-backed document actions as mutations', () => {
    expect(
      ['archive', 'compact', 'destroy', 'quarantine', 'rebuild'].every(
        isCrdtAdminOperatorMutationAction,
      ),
    ).toBe(true);
    expect(
      ['integrity', 'debug-export', 'backup-export'].some(isCrdtAdminOperatorMutationAction),
    ).toBe(false);
  });
});
