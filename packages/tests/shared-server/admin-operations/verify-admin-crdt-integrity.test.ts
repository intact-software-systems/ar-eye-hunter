import { describe, expect, it } from 'vitest';

import { VerifyAdminCrdtIntegrity } from '@shared-server/rallar-system/admin-operations/verify-admin-crdt-integrity.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'map',
    documentId: 'doc-1'
};

describe('VerifyAdminCrdtIntegrity', () => {
    it('verifies one decoded document and records its target', async () => {
        const documents: RallarCrdtDocumentRef[] = [];
        const timingEvents: RallarTimingEvent[] = [];
        const verifyIntegrity = new VerifyAdminCrdtIntegrity({
            serviceId: 'test-server',
            timing: (event) => timingEvents.push(event),
            repository: {
                verifyIntegrity: (document) => {
                    documents.push(document);
                    return Promise.resolve({
                        document,
                        documentKey: 'app-1/workspace-1/room/map/doc-1',
                        checkedUpdateCount: 0,
                        valid: true,
                        issues: [],
                        sequenceGaps: [],
                        duplicateUpdateIds: [],
                        snapshotCoverage: {
                            latestSnapshotId: null,
                            latestSnapshotSequence: 0,
                            appendSequence: 0,
                            missingUpdateIds: [],
                            unexpectedUpdateIds: []
                        }
                    });
                }
            }
        });

        const result = await verifyIntegrity.execute({
            adminSession: createAdminSession(),
            request: { document: DOCUMENT }
        });

        expect(documents).toEqual([DOCUMENT]);
        expect(result.valid).toBe(true);
        expect(timingEvents[0]).toMatchObject({
            operation: 'crdt.integrity',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            details: {
                documentScope: 'room',
                documentType: 'map',
                documentId: 'doc-1'
            }
        });
    });
});

function createAdminSession() {
    return {
        clientId: 'platform-admin',
        username: 'admin',
        accessToken: 'access-token',
        sessionId: 'admin-session',
        expiresAtEpochMs: NOW_EPOCH_MS + 60_000
    };
}
