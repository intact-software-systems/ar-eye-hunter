import { validatePersistedAppInboxCommandIdentity } from '@shared-server/rallar-system/app-inbox/app-inbox-command-identity.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { describe, expect, it } from 'vitest';

describe('persisted AppInbox command decoding', () => {
    it('accepts the exact current JSON-wire command', () => {
        expect(validate(AppInboxType.GROUP_CREATE, {
            type: AppInboxType.GROUP_CREATE,
            data: { requestId: 'request-1' }
        })).toMatchObject({
            valid: true,
            identity: {
                operation: AppInboxType.GROUP_CREATE,
                operationSource: 'command'
            }
        });
    });

    it('rejects extra persisted command fields as corruption', () => {
        expect(validate(AppInboxType.GROUP_CREATE, {
            type: AppInboxType.GROUP_CREATE,
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

    it('classifies an unknown operation as unavailable', () => {
        expect(validate('GROUP_UNKNOWN', {
            type: 'GROUP_UNKNOWN',
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
            payload: {
                typeId,
                resource: JSON.stringify(command)
            }
        })
    });
}
