import { validatePersistedAppInboxCommandIdentity } from '@shared-server/rallar-system/app-inbox/app-inbox-command-identity.ts';
import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';

const ROUTE = { topicId: 'app-inbox.group-state', resourceId: 'request-1', contextId: 'route-context' };

describe('persisted AppInbox command decoding', () => {
    it('uses JSON-wire data as the sole persisted enqueue shape', () => {
        expectTypeOf<AppInboxEnqueueInput['data']>().toEqualTypeOf<JsonWireValue>();
    });

    it('accepts the exact current JSON-wire command', () => {
        expect(validate(AppInboxType.GROUP_CREATE, {
            type: AppInboxType.GROUP_CREATE,
            contextId: 'group-context',
            data: { requestId: 'request-1' }
        })).toMatchObject({
            valid: true,
            identity: {
                operation: AppInboxType.GROUP_CREATE,
                operationSource: 'command'
            },
            command: { contextId: 'group-context' }
        });
    });

    it('rejects a persisted command without its context as corruption', () => {
        expect(validate(AppInboxType.GROUP_CREATE, { type: AppInboxType.GROUP_CREATE, data: null }))
            .toMatchObject({ valid: false, identity: { operationSource: 'corrupt' } });
    });

    it('rejects extra persisted command fields as corruption', () => {
        expect(validate(AppInboxType.GROUP_CREATE, {
            type: AppInboxType.GROUP_CREATE,
            contextId: 'group-context',
            data: null,
            unexpectedField: true
        })).toEqual({
            valid: false,
            identity: {
                operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
                operationSource: 'corrupt'
            }
        });
    });

    it('rejects a trace inside the persisted command as corruption, since the trace rides on the envelope', () => {
        expect(validate(AppInboxType.GROUP_CREATE, {
            type: AppInboxType.GROUP_CREATE,
            contextId: 'group-context',
            traceId: 'trace-in-command',
            data: null
        })).toMatchObject({ valid: false, identity: { operationSource: 'corrupt' } });
    });

    it('classifies an unknown operation as unavailable', () => {
        expect(validate('GROUP_UNKNOWN', {
            type: 'GROUP_UNKNOWN',
            contextId: 'group-context',
            data: null
        })).toEqual({
            valid: false,
            identity: {
                operation: 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE',
                operationSource: 'unavailable'
            }
        });
    });
});

function validate(typeId: string, command: object) {
    return validatePersistedAppInboxCommandIdentity({
        topicId: 'app-inbox.group-state',
        resource: JSON.stringify({
            route: ROUTE,
            payload: {
                typeId,
                resource: JSON.stringify(command)
            }
        })
    });
}
