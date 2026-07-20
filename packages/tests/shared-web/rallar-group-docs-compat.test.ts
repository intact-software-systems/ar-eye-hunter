import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';

const repoRoot = process.cwd();

const apiReference = readRepoFile('docs/rallar-api-reference.md');
const quickstart = readRepoFile('docs/rallar-quickstart-and-recipes.md');
const environmentVariables = readRepoFile('docs/environment-variables.md');
const openApi = readRepoFile('apps/api-v1/resources/api-v1-openapi.yaml');
const openApiDocument = parseOpenApiDocument(loadYaml(openApi));

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

    it('requires the hardened authoritative event, snapshot, and topology fields', () => {
        expectSchemaRequired('AuditStamp', [
            'atEpochMs', 'actor', 'reason', 'traceId', 'requestId',
        ]);
        expectSchemaRequired('ClientEvent', [
            'applicationId', 'workspaceId', 'principalId', 'eventId',
            'eventType', 'snapshotVersion', 'clientInstanceId', 'sessionId',
            'occurredAtEpochMs', 'actor', 'reason', 'traceId', 'requestId',
            'payload',
        ]);
        expectSchemaRequired('GroupEvent', [
            'applicationId', 'workspaceId', 'groupId', 'eventId', 'eventType',
            'snapshotVersion', 'causalRevision', 'occurredAtEpochMs', 'actor',
            'reason', 'traceId', 'requestId', 'payload',
        ]);
        expectSchemaRequired('ClientSnapshot', [
            'stateRevision', 'principal', 'instances', 'activeSessions',
            'isOnline', 'activeSessionCount', 'lastSeenAtEpochMs',
        ]);
        expectSchemaRequired('GroupSnapshot', [
            'stateRevision', 'causalRevision', 'group', 'members',
            'activeSessions', 'memberCount', 'onlineMemberCount',
        ]);
        expectSchemaRequired('GroupMember', [
            'applicationId', 'workspaceId', 'groupId', 'principalId', 'role',
            'status', 'joined', 'updated', 'left', 'removed', 'banned',
            'invitedByPrincipalId', 'invitationExpiresAtEpochMs',
        ]);
        expectSchemaRequired('RallarOverlayTopologySnapshot', [
            'sourceGroupStateCausalRevision', 'state', 'overlayId', 'groupRef',
            'name', 'topology', 'activeSessionIds', 'nextHopsBySessionId',
            'degreeLimit', 'version', 'createdByClientId', 'createdAtEpochMs',
            'updatedAtEpochMs',
        ]);
        expectSchemaRequired('GroupTopologyConfigView', [
            'serverDefaults', 'durable', 'temporary', 'requestOptions',
            'effective',
        ]);
        expectSchemaRequired('GroupTopologyConfigAcceptedCausalRevision', [
            'stateRevision', 'snapshotVersion', 'metadataVersion',
            'rosterVersion', 'presenceVersion', 'causalRevision',
        ]);
        expect(
            schema('GroupTopologyConfigAcceptedCausalRevision')
                .properties?.causalRevision?.$ref,
        ).toBe('#/components/schemas/GroupStateCausalRevision');

        for (const [schemaName, propertyNames] of Object.entries({
            AuditStamp: ['reason', 'traceId', 'requestId'],
            ClientEvent: [
                'clientInstanceId', 'sessionId', 'reason', 'traceId',
                'requestId',
            ],
            GroupEvent: ['reason', 'traceId', 'requestId'],
            ClientSnapshot: ['lastSeenAtEpochMs'],
            GroupTopologyConfigView: ['durable', 'temporary', 'requestOptions'],
        })) {
            for (const propertyName of propertyNames) {
                expect(
                    schema(schemaName).properties?.[propertyName]?.nullable,
                    `${schemaName}.${propertyName} must be required nullable`,
                ).toBe(true);
            }
        }

        expect(schema('MutationActor').discriminator?.propertyName).toBe('kind');
        expect(schema('MutationActor').oneOf).toHaveLength(3);
        expect(schema('GroupMember').properties?.joined?.nullable).toBe(true);
        const memberVariants = schema('GroupMember').oneOf ?? [];
        const invited = memberVariants.find((variant) =>
            variant.properties?.status?.enum?.includes('invited')
        );
        const active = memberVariants.find((variant) =>
            variant.properties?.status?.enum?.includes('active')
        );
        expect(invited?.properties?.joined?.enum).toEqual([null]);
        expect(invited?.properties?.joined?.nullable).toBe(true);
        expect(active?.properties?.joined?.$ref)
            .toBe('#/components/schemas/AuditStamp');
        for (const status of ['left', 'removed', 'banned']) {
            const terminal = memberVariants.find((variant) =>
                variant.properties?.status?.enum?.includes(status)
            );
            expect(terminal?.properties?.joined?.nullable).toBe(true);
        }
        for (const schemaName of [
            'ClientPrincipal',
            'ClientInstance',
            'ClientSession',
            'Group',
            'GroupMember',
            'GroupPresenceSession',
        ]) {
            expect(schema(schemaName).discriminator?.propertyName).toBe('status');
            expect(schema(schemaName).oneOf?.length).toBeGreaterThan(1);
        }
    });
});

type OpenApiSchema = Readonly<{
    $ref?: string;
    required?: readonly string[];
    properties?: Readonly<Record<string, OpenApiSchema>>;
    nullable?: boolean;
    enum?: readonly unknown[];
    allOf?: readonly OpenApiSchema[];
    oneOf?: readonly OpenApiSchema[];
    discriminator?: Readonly<{ propertyName?: string }>;
}>;

type OpenApiDocument = Readonly<{
    components: Readonly<{
        schemas: Readonly<Record<string, OpenApiSchema>>;
    }>;
}>;

function schema(name: string): OpenApiSchema {
    const value = openApiDocument.components.schemas[name];
    if (!value) throw new Error(`Missing OpenAPI schema ${name}`);
    return value;
}

function parseOpenApiDocument(value: unknown): OpenApiDocument {
    const document = requireRecord(value, 'OpenAPI document');
    const components = requireRecord(
        document.components,
        'OpenAPI components',
    );
    const schemaValues = requireRecord(
        components.schemas,
        'OpenAPI component schemas',
    );
    const schemas: Record<string, OpenApiSchema> = {};
    for (const [name, schemaValue] of Object.entries(schemaValues)) {
        schemas[name] = parseOpenApiSchema(schemaValue, name);
    }
    return { components: { schemas } };
}

function parseOpenApiSchema(value: unknown, label: string): OpenApiSchema {
    const source = requireRecord(value, `OpenAPI schema ${label}`);
    const properties: Record<string, OpenApiSchema> = {};
    if (source.properties !== undefined) {
        const propertyValues = requireRecord(
            source.properties,
            `OpenAPI schema ${label} properties`,
        );
        for (const [name, propertyValue] of Object.entries(propertyValues)) {
            properties[name] = parseOpenApiSchema(propertyValue, `${label}.${name}`);
        }
    }
    const discriminator = source.discriminator === undefined
        ? undefined
        : requireRecord(
            source.discriminator,
            `OpenAPI schema ${label} discriminator`,
        );
    const propertyName = discriminator?.propertyName;
    if (propertyName !== undefined && typeof propertyName !== 'string') {
        throw new TypeError(`OpenAPI schema ${label} discriminator is invalid`);
    }
    return {
        ...(typeof source.$ref === 'string' ? { $ref: source.$ref } : {}),
        ...(source.required === undefined
            ? {}
            : { required: requireStringArray(source.required, `${label}.required`) }),
        ...(source.properties === undefined ? {} : { properties }),
        ...(typeof source.nullable === 'boolean'
            ? { nullable: source.nullable }
            : {}),
        ...(Array.isArray(source.enum) ? { enum: [...source.enum] } : {}),
        ...(source.allOf === undefined
            ? {}
            : {
                allOf: requireArray(source.allOf, `${label}.allOf`)
                    .map((item, index) =>
                        parseOpenApiSchema(item, `${label}.allOf[${index}]`)
                    ),
            }),
        ...(source.oneOf === undefined
            ? {}
            : {
                oneOf: requireArray(source.oneOf, `${label}.oneOf`)
                    .map((item, index) =>
                        parseOpenApiSchema(item, `${label}.oneOf[${index}]`)
                    ),
            }),
        ...(propertyName === undefined
            ? {}
            : { discriminator: { propertyName } }),
    };
}

function requireRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (!isUnknownRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireArray(value: unknown, label: string): readonly unknown[] {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
    return value;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
    const items = requireArray(value, label);
    if (!items.every((item) => typeof item === 'string')) {
        throw new TypeError(`${label} must contain only strings`);
    }
    return items;
}

function expectSchemaRequired(name: string, expected: readonly string[]): void {
    expect([...(schema(name).required ?? [])].sort()).toEqual([...expected].sort());
}

function readRepoFile(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}
