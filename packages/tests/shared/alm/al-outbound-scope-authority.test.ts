import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALOutboundScopeAuthority } from '@shared/alm/outbound/admission/al-outbound-scope-authority.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room' };
const ROUTE = { topicId: 'room.chat', resourceId: 'resource', contextId: 'room' };
const INVALIDATION = {
    kind: 'auth-session-invalidation' as const,
    sessionId: 'peer',
    requestId: 'request',
    invalidatedAtMs: 2,
    issuedAtMs: 1,
    expiresAtMs: 3
};

describe('outbound scope authority', () => {
    it.each([
        [
            'room unicast',
            newALUnicastMessage('server', ROUTE, 'peer', 'chat.v1', {}, { groupRef: ROOM })
        ],
        [
            'room broadcast',
            newALBroadcastMessage('server', ROUTE, 'room', 'chat.v1', {}, { groupRef: ROOM })
        ]
    ])('takes a %s scope from its wire groupRef', (_, message) => {
        expect(resolveALOutboundScopeAuthority(message, {}).right).toEqual({
            kind: 'group-ref',
            groupRef: ROOM
        });
    });

    it.each([{ recipientScope: SCOPE }, { principalTargetId: 'peer' }, {
        sessionInvalidation: INVALIDATION
    }])(
        'refuses a group-addressed row that also stores %j',
        (fields) => {
            const message = newALUnicastMessage('server', ROUTE, 'peer', 'chat.v1', {}, {
                groupRef: ROOM
            });
            expect(resolveALOutboundScopeAuthority(message, fields).left)
                .toEqual(['A row whose targets name a group stores no second recipient authority']);
        }
    );

    it('keeps the stored scope and principal of a row that names no group', () => {
        const message = newALUnicastMessage(
            'server',
            { ...ROUTE, contextId: 'peer' },
            'peer',
            'chat.v1',
            {}
        );
        expect(
            resolveALOutboundScopeAuthority(message, {
                recipientScope: SCOPE,
                principalTargetId: 'peer'
            }).right
        )
            .toEqual({ kind: 'recipient-scope', recipientScope: SCOPE, principalTargetId: 'peer' });
        expect(resolveALOutboundScopeAuthority(message, {}).right).toEqual({ kind: 'none' });
    });

    it('keeps session invalidation exclusive', () => {
        const message = newALUnicastMessage('server', ROUTE, 'peer', 'auth.session.logout.v1', {});
        expect(
            resolveALOutboundScopeAuthority(message, { sessionInvalidation: INVALIDATION }).right
        )
            .toEqual({ kind: 'session-invalidation', sessionInvalidation: INVALIDATION });
        expect(
            resolveALOutboundScopeAuthority(message, {
                sessionInvalidation: INVALIDATION,
                recipientScope: SCOPE
            }).left
        )
            .toEqual(['Session-global authority cannot carry a scoped authority']);
    });

    it.each([
        [{ principalTargetId: 'peer' }, 'A principal target requires its recipient scope'],
        [
            { recipientScope: { applicationId: 'app', workspaceId: '' } },
            'Public WS unicast requires explicit application and workspace scope'
        ]
    ])('refuses %j', (fields, issue) => {
        const message = newALUnicastMessage('server', ROUTE, 'peer', 'chat.v1', {});
        expect(resolveALOutboundScopeAuthority(message, fields).left).toEqual([issue]);
    });
});
