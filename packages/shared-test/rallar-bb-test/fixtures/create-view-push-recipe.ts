import { AL_TRACE_ID_HTTP_HEADER } from '@shared/al-contracts/trace/al-trace-id.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

/** Fresh HTTP/WS-only agents own their raw socket; no SDK connection competes for this auth session. */
export function createViewPushRecipe(scope: StateScope): RallarBlackBoxTestRecipe {
    return {
        schemaVersion: 1,
        recipeId: 'private-view-push-and-recovery',
        name: 'Private view push and reconnect recovery',
        continueOnFailure: false,
        metadata: { profile: 'view-push', scope, freshAgentRequired: true },
        commands: [
            visibilityCommand('baseline', false),
            openViewSocket('initial', scope),
            visibilityCommand('visible', true),
            ...observeCommittedViewPush(),
            ...readCanonicalVisibility('live', scope, true),
            {
                kind: 'ws.close',
                commandId: 'view-push-disconnect',
                connection: 'view-push',
                code: 1000,
                reason: 'offline mutation proof'
            },
            {
                kind: 'wait',
                commandId: 'view-push-await-disconnect',
                timeoutMs: 10_000,
                match: { topic: 'rallar.bb.ws.closed', connection: 'view-push' }
            },
            visibilityCommand('offline', false),
            openViewSocket('reconnect', scope),
            ...readCanonicalVisibility('recovered', scope, false),
            {
                kind: 'ws.close',
                commandId: 'view-push-close',
                connection: 'view-push',
                code: 1000,
                reason: 'proof complete'
            }
        ]
    };
}

function visibilityCommand(phase: string, shareOnline: boolean): RallarBlackBoxTestCommand {
    const requestId = `view-push-{runtimeIdentity}-${phase}`;
    return {
        kind: 'http.request',
        commandId: `view-push-${phase}`,
        timeoutMs: 15_000,
        request: {
            method: 'POST',
            path: `/api/friends/requests/${requestId}`,
            headers: { [AL_TRACE_ID_HTTP_HEADER]: requestId },
            body: { action: 'visibility', shareOnline }
        },
        response: { body: 'json', acceptedStatusCodes: [200] }
    };
}

function openViewSocket(phase: string, scope: StateScope): RallarBlackBoxTestCommand {
    return {
        kind: 'ws.open',
        commandId: `view-push-open-${phase}`,
        connection: 'view-push',
        timeoutMs: 15_000,
        url: '{config.wsBaseUrl}/api/ws/{auth.sessionId}?ticket={auth.wsTicket}' +
            `&applicationId=${encodeURIComponent(scope.applicationId)}&workspaceId=${
                encodeURIComponent(scope.workspaceId)
            }`
    };
}

function observeCommittedViewPush(): readonly RallarBlackBoxTestCommand[] {
    const observed = 'resultCache.view-push-notice.value.event.payload.data';
    return [
        {
            kind: 'wait',
            commandId: 'view-push-notice',
            timeoutMs: 15_000,
            match: {
                topic: 'rallar.bb.ws.message',
                connection: 'view-push',
                payloadPath: 'data',
                contains: '"traceId":"{resultCache.view-push-visible.value.body.requestId}"'
            }
        },
        {
            kind: 'assert',
            commandId: 'view-push-topic',
            source: observed,
            operator: 'contains',
            expected: '"topicId":"view.invalidated"'
        },
        {
            kind: 'assert',
            commandId: 'view-push-type',
            source: observed,
            operator: 'contains',
            expected: '"typeId":"view.invalidated"'
        },
        {
            kind: 'assert',
            commandId: 'view-push-private-target',
            source: observed,
            operator: 'contains',
            expected: '"mode":"unicast"'
        }
    ];
}

function readCanonicalVisibility(
    phase: string,
    scope: StateScope,
    shareOnline: boolean
): readonly RallarBlackBoxTestCommand[] {
    const commandId = `view-push-read-${phase}`;
    return [
        {
            kind: 'http.request',
            commandId,
            timeoutMs: 15_000,
            request: {
                method: 'GET',
                path: `/api/friends/apps/${encodeURIComponent(scope.applicationId)}/workspaces/${
                    encodeURIComponent(scope.workspaceId)
                }`
            },
            response: { body: 'json', acceptedStatusCodes: [200] }
        },
        {
            kind: 'assert',
            commandId: `view-push-assert-${phase}`,
            source: `resultCache.${commandId}.value.body.shareOnline`,
            operator: 'equals',
            expected: shareOnline
        }
    ];
}
