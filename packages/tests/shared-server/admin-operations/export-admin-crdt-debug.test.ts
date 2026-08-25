import { describe, expect, it } from 'vitest';

import { ExportAdminCrdtDebug } from '@shared-server/rallar-system/admin-operations/export-admin-crdt-debug.ts';
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

describe('ExportAdminCrdtDebug', () => {
    it('exports a redacted bundle and records the decoded document target', async () => {
        const repositoryCalls: object[] = [];
        const timingEvents: RallarTimingEvent[] = [];
        const exportDebug = new ExportAdminCrdtDebug({
            serviceId: 'test-server',
            timing: (event) => timingEvents.push(event),
            repository: {
                exportDebugBundle: (document, options) => {
                    repositoryCalls.push({ document, options });
                    return Promise.resolve({
                        format: 'rallar.crdt.debug-bundle.v1',
                        exportedAtEpochMs: NOW_EPOCH_MS,
                        reason: options?.reason ?? 'missing',
                        document,
                        documentKey: 'app-1/workspace-1/room/map/doc-1',
                        records: [],
                        redaction: options?.redaction ?? { payloadsRedacted: false },
                        integrity: {
                            bundleHash: `sha256:${'a'.repeat(64)}`,
                            documentRefHash: `sha256:${'b'.repeat(64)}`,
                            updateHashes: {},
                            updateCount: 0,
                            sequenceGaps: []
                        }
                    });
                }
            }
        });

        const result = await exportDebug.execute({
            adminSession: createAdminSession(),
            request: { document: DOCUMENT }
        });

        expect(repositoryCalls).toEqual([{
            document: DOCUMENT,
            options: {
                reason: 'api-v1-admin-operations-debug-export',
                redaction: {
                    payloadsRedacted: true,
                    reason: 'api-v1-admin-operations-redaction'
                }
            }
        }]);
        expect(result.redaction).toEqual({
            payloadsRedacted: true,
            reason: 'api-v1-admin-operations-redaction'
        });
        expect(timingEvents[0]).toMatchObject({
            operation: 'crdt.debug-export',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'platform-admin',
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
