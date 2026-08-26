import {
    ADMIN_SUPPORT_EXPLAIN_ENDPOINTS,
    ADMIN_SUPPORT_FACT_CERTAINTIES,
    ADMIN_SUPPORT_SUGGESTED_ACTION_SEVERITIES,
    type AdminSupportExplainQueueItemRequest,
    type AdminSupportNarrativeResponse
} from '@shared/api/admin-support/admin-support-types.ts';
import { describe, expect, it } from 'vitest';

describe('admin support public API contracts', () => {
    it('exports stable endpoint and narrative discriminator constants', () => {
        expect(ADMIN_SUPPORT_EXPLAIN_ENDPOINTS).toEqual([
            '/api/admin/support/explain/client',
            '/api/admin/support/explain/group',
            '/api/admin/support/explain/request',
            '/api/admin/support/explain/crdt-document',
            '/api/admin/support/explain/queue-item'
        ]);
        expect(ADMIN_SUPPORT_FACT_CERTAINTIES).toEqual([
            'exact',
            'inferred',
            'unavailable'
        ]);
        expect(ADMIN_SUPPORT_SUGGESTED_ACTION_SEVERITIES).toEqual([
            'info',
            'warning',
            'urgent'
        ]);
    });

    it('keeps queue explanation requests and narrative responses typed for REST clients', () => {
        const request: AdminSupportExplainQueueItemRequest = {
            queueKey: {
                topicId: 'group-state.event',
                resourceId: 'request-1',
                contextId: 'room-1'
            },
            includeExpired: true
        };
        const response: AdminSupportNarrativeResponse = {
            generatedAtEpochMs: 1_700_000_000_000,
            serverId: 'api-v1-test',
            target: {
                kind: 'queue-item',
                queueKey: request.queueKey
            },
            facts: [{
                label: 'inbox.status',
                source: 'resource_inbox',
                value: 'RETRY',
                certainty: 'exact'
            }],
            timeline: [],
            warnings: [],
            likelyCauses: [],
            suggestedActions: [{
                code: 'inspect-result-row',
                label: 'Inspect the durable result row',
                severity: 'info'
            }],
            rawRefs: ['queue:group-state.event/request-1/room-1']
        };

        expect(response.target.kind).toBe('queue-item');
        expect(response.facts[0]?.certainty).toBe('exact');
        expect(response.suggestedActions[0]?.severity).toBe('info');
    });
});
