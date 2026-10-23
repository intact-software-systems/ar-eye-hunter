import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { QuickJoinGroupRequest, QuickJoinGroupResult } from '@shared/api/mutation/group-quick-join.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import {
    requireExactKeys,
    requireExactOptionalKeys,
    requireRecord,
    requireString
} from '../../protocol/exact-object-decoding.ts';
import { decodeGroupDirectoryQuery } from '../directory/decode-group-directory-query.ts';
import { decodeGroupMutationAuthorityProof } from '../inbox/decode-group-state-inbox-authority.ts';
import type { GroupMutationIngressFacts } from '../mutation/group-mutation-contracts.ts';
import { assertGroupMutationIngressFacts } from '../mutation/state-validation/assert-group-mutation-facts.ts';
import type { GroupQuickJoinCommand, GroupQuickJoinIngress } from './group-quick-join-contracts.ts';

export function decodeQuickJoinGroupRequest(value: unknown): QuickJoinGroupRequest {
    const request = requireRecord(value, 'Quick Join request');
    requireExactOptionalKeys({
        value: request,
        required: ['requestId'],
        optional: ['kind', 'q', 'includeEmpty'],
        label: 'Quick Join request'
    });
    requireString(request.requestId, 'Quick Join requestId');
    const query = new URLSearchParams();
    for (const field of ['kind', 'q'] as const) {
        if (request[field] !== undefined) {
            if (typeof request[field] !== 'string') {
                throw new TypeError(`Quick Join ${field} must be a string`);
            }
            query.set(field, request[field]);
        }
    }
    if (request.includeEmpty !== undefined && typeof request.includeEmpty !== 'boolean') {
        throw new TypeError('Quick Join includeEmpty must be boolean');
    }
    query.set('includeEmpty', String(request.includeEmpty ?? false));
    const decoded = decodeGroupDirectoryQuery(query).fold(
        (issues) => {
            throw new TypeError(issues.join('; '));
        },
        (selection) => selection
    );
    return {
        requestId: request.requestId,
        ...(decoded.kind === null ? {} : { kind: decoded.kind }),
        ...(decoded.q === null ? {} : { q: decoded.q }),
        includeEmpty: decoded.includeEmpty
    };
}

export function decodeGroupQuickJoinCommand(value: unknown): GroupQuickJoinCommand {
    const command = requireRecord(value, 'Quick Join command');
    requireExactKeys(
        command,
        ['scope', 'requestId', 'actorPrincipalId', 'actorSessionId', 'kind', 'q', 'includeEmpty'],
        'Quick Join command'
    );
    const scope = requireRecord(command.scope, 'Quick Join scope');
    requireExactKeys(scope, ['applicationId', 'workspaceId'], 'Quick Join scope');
    requireString(scope.applicationId, 'Quick Join applicationId');
    requireString(scope.workspaceId, 'Quick Join workspaceId');
    requireString(command.actorPrincipalId, 'Quick Join actor principal');
    requireString(command.actorSessionId, 'Quick Join actor session');
    const request = decodeQuickJoinGroupRequest({
        requestId: command.requestId,
        ...(command.kind === null ? {} : { kind: command.kind }),
        ...(command.q === null ? {} : { q: command.q }),
        includeEmpty: command.includeEmpty
    });
    const decoded: GroupQuickJoinCommand = {
        scope: { applicationId: scope.applicationId, workspaceId: scope.workspaceId },
        requestId: request.requestId,
        actorPrincipalId: command.actorPrincipalId,
        actorSessionId: command.actorSessionId,
        kind: request.kind ?? null,
        q: request.q ?? null,
        includeEmpty: request.includeEmpty ?? false
    };
    if (!jsonEquals(value, decoded)) {
        throw new TypeError('Quick Join command must be normalized');
    }
    return decoded;
}

export function decodeGroupQuickJoinIngress(value: unknown): GroupQuickJoinIngress {
    const ingress = requireRecord(value, 'Quick Join ingress');
    requireExactKeys(ingress, ['command', 'authorityProof', 'facts'], 'Quick Join ingress');
    const command = decodeGroupQuickJoinCommand(ingress.command);
    const authorityProof = decodeGroupMutationAuthorityProof(ingress.authorityProof);
    const facts = ingress.facts as GroupMutationIngressFacts;
    assertGroupMutationIngressFacts(facts);
    if (
        facts.internalAuthority !== 'none' || facts.authenticatedAuthority?.principalId !== command.actorPrincipalId ||
        facts.authenticatedAuthority.sessionId !== command.actorSessionId ||
        authorityProof.principalId !== command.actorPrincipalId || authorityProof.sessionId !== command.actorSessionId
    ) {
        throw new TypeError('Quick Join authority differs from its command');
    }
    return { command, authorityProof, facts };
}

export function decodeQuickJoinGroupResult(value: unknown, command: GroupQuickJoinCommand): QuickJoinGroupResult {
    const result = requireRecord(value, 'Quick Join result');
    if (result.status === 'unavailable') {
        requireExactKeys(result, ['status'], 'Unavailable Quick Join result');
        return { status: 'unavailable' };
    }
    requireExactKeys(result, ['status', 'snapshot'], 'Joined Quick Join result');
    if (result.status !== 'joined') {
        throw new TypeError('Quick Join result status is invalid');
    }
    validateAuthoritativeGroupSnapshot(result.snapshot);
    if (
        result.snapshot.group.applicationId !== command.scope.applicationId ||
        result.snapshot.group.workspaceId !== command.scope.workspaceId ||
        !result.snapshot.members.some((member) =>
            member.principalId === command.actorPrincipalId && member.status === 'active'
        )
    ) {
        throw new TypeError('Quick Join result does not belong to its command');
    }
    return { status: 'joined', snapshot: result.snapshot };
}
