import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const apiReference = readRepoFile('docs/rallar-api-reference.md');
const quickstart = readRepoFile('docs/rallar-quickstart-and-recipes.md');
const environmentVariables = readRepoFile('docs/environment-variables.md');
const openApi = readRepoFile('apps/api-v1/resources/api-v1-openapi.yaml');

describe('Rallar group documentation compatibility', () => {
    it('documents browser-safe room workflows and switch recovery', () => {
        expectAll(apiReference, [
            '`rooms.update(input)`',
            '`rooms.archive(room, options?)`',
            '`rooms.delete(room, options?)`',
            '`rooms.invite(room, principalId, options?)`',
            '`rooms.acceptInvite(room, options?)`',
            '`rooms.removeMember(room, principalId, options?)`',
            '`rooms.banMember(room, principalId, options?)`',
            '`rooms.unbanMember(room, principalId, options?)`',
            '`rooms.setMemberRole(room, principalId, role, options?)`',
            '`rooms.transferOwnership(room, principalId, options?)`',
            '`joinMode`',
            '`inviteToken`',
            '`joinCode`',
            '`RallarRoomSwitchPartialFailureError`',
        ]);

        expectAll(quickstart, [
            'Invite-Only Room',
            'Code-Protected Room',
            'Room Switch Recovery',
            'RallarRoomSwitchPartialFailureError',
        ]);
    });

    it('documents stable policy reasons and the strict read rollout switch', () => {
        expectAll(apiReference, [
            '`GROUP_POLICY_REASON_CODES`',
            '`group-invite-required`',
            '`group-code-required`',
            '`group-code-invalid`',
            '`group-invite-expired`',
            '`group-archived`',
            '`group-deleted`',
            '`group-not-active`',
            '`group-full`',
            '`member-session-limit-reached`',
            '`member-not-active`',
            '`member-removed`',
            '`member-banned`',
            '`forbidden-role`',
            '`last-owner`',
            '`RALLAR_STATE_STRICT_READ_AUTH`',
        ]);

        expect(environmentVariables).toContain('`RALLAR_STATE_STRICT_READ_AUTH`');
    });

    it('keeps the OpenAPI spec in step with server-side group workflows', () => {
        expectAll(openApi, [
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/accept:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join-code/rotate:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/{principalId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/{principalId}/revoke:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/remove:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/ban:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/unban:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/{principalId}/role:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/owner/transfer:',
            'JoinGroupRequest',
            'AcceptGroupInviteRequest',
            'RotateGroupJoinCodeRequest',
            'GroupJoinCodeResponse',
            'CreateGroupInviteRequest',
            'RevokeGroupInviteRequest',
            'RemoveGroupMemberRequest',
            'BanGroupMemberRequest',
            'UnbanGroupMemberRequest',
            'SetGroupMemberRoleRequest',
            'TransferGroupOwnershipRequest',
            'GroupPolicyReasonCode',
            'code:',
            'GroupStateCausalRevision:',
            'activeMemberCount',
            'ownerPrincipalId',
            'generationId',
            'generationVersion',
            'causalRevision',
            'stateRevision',
        ]);
    });
});

function readRepoFile(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}
