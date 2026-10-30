import { load as loadYaml } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { GROUP_POLICY_REASON_CODES } from '@shared/api/group-policy-types.ts';

const repoRoot = process.cwd();

const apiReference = readRepoFile('docs/rallar-api-reference.md');
const quickstart = readRepoFile('docs/rallar-quickstart-and-recipes.md');
const environmentVariables = readRepoFile('docs/environment-variables.md');
const openApi = readRepoFile('apps/api-v1/resources/api-v1-openapi.yaml');
const openApiDocument = decodeOpenApiDocument(loadYaml(openApi));

describe('Rallar group public contracts', () => {
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
            '`rooms.setMemberRole({ room, principalId, role, options? })`',
            '`rooms.transferOwnership(room, principalId, options?)`',
            '`joinMode`',
            '`inviteToken`',
            '`joinCode`',
            '`RallarRoomSwitchPartialFailureError`'
        ]);

        expectAll(quickstart, [
            'Invite-Only Room',
            'Code-Protected Room',
            'Room Switch Recovery',
            'RallarRoomSwitchPartialFailureError'
        ]);
    });

    /**
     * Nothing coupled these two before, and the absence cost something real:
     * an edge adding `formation-attempts-exhausted` to the enum was reverted
     * twice by a blanket checkout after a formatting run, and both times the
     * loss was silent -- no gate, no test, no type error, and once it shipped
     * as a false claim in a delivery record.
     */
    it('publishes exactly the policy reason codes the const declares', () => {
        const published = schema('GroupPolicyReasonCode').enum ?? [];

        expect([...published].sort()).toEqual([...GROUP_POLICY_REASON_CODES].sort());
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
            '`RALLAR_STATE_STRICT_READ_AUTH`'
        ]);

        expect(environmentVariables).toContain('`RALLAR_STATE_STRICT_READ_AUTH`');
    });

    it('keeps the OpenAPI spec in step with server-side group workflows', () => {
        expectAll(openApi, [
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join/' +
            'requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/' +
            'accept/requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/join-code/' +
            'rotate/requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/' +
            '{principalId}/requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/invites/' +
            '{principalId}/revoke/requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/' +
            '{principalId}/remove/requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/' +
            '{principalId}/ban/requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/' +
            '{principalId}/unban/requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/members/' +
            '{principalId}/role/requests/{requestId}:',
            '/api/state/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/owner/' +
            'transfer/requests/{requestId}:',
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
            'causalRevision'
        ]);
    });

    it('requires the hardened authoritative event, snapshot, and topology fields', () => {
        expectSchemaRequired('AuditStamp', [
            'atEpochMs',
            'actor',
            'reason',
            'traceId',
            'requestId'
        ]);
        expectSchemaRequired('ClientEvent', [
            'applicationId',
            'workspaceId',
            'principalId',
            'eventId',
            'eventType',
            'snapshotVersion',
            'clientInstanceId',
            'sessionId',
            'occurredAtEpochMs',
            'actor',
            'reason',
            'traceId',
            'requestId',
            'payload'
        ]);
        expectSchemaRequired('GroupEvent', [
            'applicationId',
            'workspaceId',
            'groupId',
            'eventId',
            'eventType',
            'snapshotVersion',
            'causalRevision',
            'occurredAtEpochMs',
            'actor',
            'reason',
            'traceId',
            'requestId',
            'payload'
        ]);
        expectSchemaRequired('ClientSnapshot', [
            'stateRevision',
            'principal',
            'instances',
            'activeSessions',
            'isOnline',
            'activeSessionCount',
            'lastSeenAtEpochMs'
        ]);
        expectSchemaRequired('GroupSnapshot', [
            'causalRevision',
            'group',
            'members',
            'activeSessions',
            'memberCount',
            'onlineMemberCount',
            'publicationGrants'
        ]);
        expectSchemaRequired('GroupPublicationGrant', [
            'applicationId',
            'workspaceId',
            'groupId',
            'principalId',
            'topics',
            'updated'
        ]);
        expectSchemaRequired('GroupPublicationTopicPermissions', ['publish', 'subscribe']);
        expect(schema('CreateGroupRequest').required).not.toContain('publicationGrants');
        expect(schema('CreateGroupRequest').properties?.publicationGrants?.$ref).toBe(
            '#/components/schemas/GroupPublicationTopicGrants'
        );
        expectSchemaRequired('GroupMember', [
            'applicationId',
            'workspaceId',
            'groupId',
            'principalId',
            'role',
            'status',
            'joined',
            'updated',
            'left',
            'removed',
            'banned',
            'invitedByPrincipalId',
            'invitationExpiresAtEpochMs'
        ]);
        expectSchemaRequired('RallarOverlayTopologySnapshot', [
            'sourceGroupStateCausalRevision',
            'state',
            'overlayId',
            'groupRef',
            'name',
            'topology',
            'activeSessionIds',
            'nextHopsBySessionId',
            'degreeLimit',
            'version',
            'createdByClientId',
            'createdAtEpochMs',
            'updatedAtEpochMs'
        ]);
        expectSchemaRequired('GroupTopologyConfigView', [
            'serverDefaults',
            'durable',
            'temporary',
            'requestOptions',
            'effective'
        ]);
        expectSchemaRequired('GroupTopologyConfigAcceptedCausalRevision', [
            'snapshotVersion',
            'metadataVersion',
            'rosterVersion',
            'presenceVersion',
            'causalRevision'
        ]);
        expectSchemaRequired('GroupTopologyConfigMutationReceipt', [
            'commandId',
            'requestId',
            'commandHash',
            'operation',
            'outcome',
            'attemptCount',
            'groupRef',
            'target',
            'acceptedVersion',
            'acceptedStorageRevision',
            'acceptedCreatedAtEpochMs',
            'acceptedUpdatedAtEpochMs',
            'acceptedExpiresAtEpochMs',
            'acceptedConfig',
            'acceptedCausalRevision',
            'eventId',
            'outboxIds'
        ]);
        expectSchemaRequired('QueuedGroupTopologyReconfigureResponse', [
            'status',
            'groupRef',
            'requestId',
            'outboxId'
        ]);
        // Each lifecycle state is publicly reachable through the mounted
        // lifecycle commands, so the OpenAPI contract publishes the complete
        // seven-stage enum rather than a dark superset.
        for (const schemaName of ['Group', 'GroupFormationView']) {
            expect(
                schema(schemaName).properties?.lifecycleState?.enum,
                schemaName
            ).toEqual([
                'dormant',
                'forming',
                'planned',
                'connecting',
                'active',
                'reconfiguring',
                'reconnecting'
            ]);
        }
        expect(
            schema('GroupTopologyConfigAcceptedCausalRevision')
                .properties?.causalRevision?.$ref
        ).toBe('#/components/schemas/GroupStateCausalRevision');
        expect(
            schema('QueuedGroupTopologyReconfigureResponse').properties?.status
                ?.enum
        ).toEqual(['queued']);
        expect(
            schema('GroupTopologyConfigMutationReceipt').properties?.eventId
                ?.type
        ).toBe('null');

        for (
            const [schemaName, propertyNames] of Object.entries({
                AuditStamp: ['reason', 'traceId', 'requestId'],
                ClientEvent: [
                    'clientInstanceId',
                    'sessionId',
                    'reason',
                    'traceId',
                    'requestId'
                ],
                GroupEvent: ['reason', 'traceId', 'requestId'],
                ClientSnapshot: ['lastSeenAtEpochMs'],
                GroupTopologyConfigView: ['durable', 'temporary', 'requestOptions']
            })
        ) {
            for (const propertyName of propertyNames) {
                expect(
                    schema(schemaName).properties?.[propertyName]?.nullable,
                    `${schemaName}.${propertyName} must be required nullable`
                ).toBe(true);
            }
        }

        expect(schema('MutationActor').discriminator?.propertyName).toBe('kind');
        expect(schema('MutationActor').oneOf).toHaveLength(3);
        expect(schema('GroupMember').properties?.joined?.nullable).toBe(true);
        const memberVariants = schema('GroupMember').oneOf ?? [];
        const invited = memberVariants.find((variant) => variant.properties?.status?.enum?.includes('invited'));
        const active = memberVariants.find((variant) => variant.properties?.status?.enum?.includes('active'));
        expect(invited?.properties?.joined?.enum).toEqual([null]);
        expect(invited?.properties?.joined?.nullable).toBe(true);
        expect(active?.properties?.joined?.$ref)
            .toBe('#/components/schemas/AuditStamp');
        for (const status of ['left', 'removed', 'banned']) {
            const terminal = memberVariants.find((variant) => variant.properties?.status?.enum?.includes(status));
            expect(terminal?.properties?.joined?.nullable).toBe(true);
        }
        for (
            const schemaName of [
                'ClientPrincipal',
                'ClientInstance',
                'ClientSession',
                'Group',
                'GroupMember',
                'GroupPresenceSession'
            ]
        ) {
            expect(schema(schemaName).discriminator?.propertyName).toBe('status');
            expect(schema(schemaName).oneOf?.length).toBeGreaterThan(1);
        }
    });

    it('uses exact topology config schema references for sparse inputs and effective output', () => {
        expect(schema('PutGroupTopologyConfigRequest').properties?.config?.$ref)
            .toBe('#/components/schemas/GroupTopologyConfigPatch');
        expect(schema('StoredGroupTopologyConfig').properties?.config?.$ref)
            .toBe('#/components/schemas/EffectiveGroupTopologyConfig');
        expect(schema('GroupTopologyConfigView').properties?.temporary?.$ref)
            .toBe('#/components/schemas/StoredGroupTopologyOverride');
        expect(schema('GroupTopologyConfigMutationReceipt').properties?.acceptedConfig?.$ref)
            .toBe('#/components/schemas/EffectiveGroupTopologyConfig');
    });

    it('enforces authoritative lifecycle correlations in every status branch', () => {
        expectNullProperties('ClientPrincipal', 'active', ['disabled', 'deleted']);
        expectAuditProperties('ClientPrincipal', 'disabled', ['disabled']);
        expectNullProperties('ClientPrincipal', 'disabled', ['deleted']);
        expectAuditProperties('ClientPrincipal', 'deleted', ['deleted']);
        expectNullableAuditProperties('ClientPrincipal', 'deleted', ['disabled']);

        expectNullProperties('ClientInstance', 'active', ['revoked']);
        expectAuditProperties('ClientInstance', 'revoked', ['revoked']);
        expectAuditProperties('ClientInstance', 'retired', ['revoked']);

        expectNullProperties('ClientSession', 'active', [
            'disconnectedAtEpochMs',
            'disconnectReason'
        ]);
        expectTypedProperties('ClientSession', 'disconnected', {
            disconnectedAtEpochMs: 'integer',
            disconnectReason: 'string'
        });
        expectTypedProperties('ClientSession', 'expired', {
            disconnectedAtEpochMs: 'integer',
            disconnectReason: 'string'
        });

        expectNullProperties('Group', 'active', ['archived', 'deleted']);
        expectAuditProperties('Group', 'archived', ['archived']);
        expectNullProperties('Group', 'archived', ['deleted']);
        expectAuditProperties('Group', 'deleted', ['deleted']);
        expectNullableAuditProperties('Group', 'deleted', ['archived']);

        expectNullProperties('GroupMember', 'invited', [
            'joined',
            'left',
            'removed',
            'banned'
        ]);
        expectAuditProperties('GroupMember', 'active', ['joined']);
        expectNullProperties('GroupMember', 'active', ['left', 'removed', 'banned']);
        for (
            const [status, auditProperty] of [
                ['left', 'left'],
                ['removed', 'removed'],
                ['banned', 'banned']
            ] as const
        ) {
            expectAuditProperties('GroupMember', status, [auditProperty]);
            expectNullableAuditProperties('GroupMember', status, ['joined']);
            expectNullProperties(
                'GroupMember',
                status,
                ['left', 'removed', 'banned'].filter((key) => key !== auditProperty)
            );
        }

        expectNullProperties('GroupPresenceSession', 'active', [
            'disconnectedAtEpochMs',
            'disconnectReason'
        ]);
        expectTypedProperties('GroupPresenceSession', 'disconnected', {
            disconnectedAtEpochMs: 'integer',
            disconnectReason: 'string'
        });
    });
});

interface OpenApiSchema {
    readonly $ref?: string;
    readonly type?: string;
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, OpenApiSchema>>;
    readonly nullable?: boolean;
    readonly enum?: readonly ApiJsonValue[];
    readonly allOf?: readonly OpenApiSchema[];
    readonly oneOf?: readonly OpenApiSchema[];
    readonly discriminator?: OpenApiDiscriminator;
}

interface OpenApiDiscriminator {
    readonly propertyName?: string;
}

interface OpenApiDocument {
    readonly components: OpenApiComponents;
}

interface OpenApiComponents {
    readonly schemas: Readonly<Record<string, OpenApiSchema>>;
}

function schema(name: string): OpenApiSchema {
    const value = openApiDocument.components.schemas[name];
    if (!value) {
        throw new Error(`Missing OpenAPI schema ${name}`);
    }
    return value;
}

function decodeOpenApiDocument(value: unknown): OpenApiDocument {
    const document = decodeOpenApiRecord(value, 'OpenAPI document');
    const components = decodeOpenApiRecord(
        document.components,
        'OpenAPI components'
    );
    const schemaValues = decodeOpenApiRecord(
        components.schemas,
        'OpenAPI component schemas'
    );
    const schemas: Record<string, OpenApiSchema> = {};
    for (const [name, schemaValue] of Object.entries(schemaValues)) {
        schemas[name] = decodeOpenApiSchema(schemaValue, name);
    }
    return { components: { schemas } };
}

function decodeOpenApiSchema(value: unknown, label: string): OpenApiSchema {
    const source = decodeOpenApiRecord(value, `OpenAPI schema ${label}`);
    const properties: Record<string, OpenApiSchema> = {};
    if (source.properties !== undefined) {
        const propertyValues = decodeOpenApiRecord(
            source.properties,
            `OpenAPI schema ${label} properties`
        );
        for (const [name, propertyValue] of Object.entries(propertyValues)) {
            properties[name] = decodeOpenApiSchema(propertyValue, `${label}.${name}`);
        }
    }
    const discriminator = source.discriminator === undefined
        ? undefined
        : decodeOpenApiRecord(
            source.discriminator,
            `OpenAPI schema ${label} discriminator`
        );
    const propertyName = discriminator?.propertyName;
    if (propertyName !== undefined && typeof propertyName !== 'string') {
        throw new TypeError(`OpenAPI schema ${label} discriminator is invalid`);
    }
    return {
        ...(typeof source.type === 'string' ? { type: source.type } : {}),
        ...(typeof source.$ref === 'string' ? { $ref: source.$ref } : {}),
        ...(source.required === undefined
            ? {}
            : { required: decodeOpenApiStringArray(source.required, `${label}.required`) }),
        ...(source.properties === undefined ? {} : { properties }),
        ...(typeof source.nullable === 'boolean'
            ? { nullable: source.nullable }
            : {}),
        ...(Array.isArray(source.enum) ? { enum: [...source.enum] } : {}),
        ...(source.allOf === undefined
            ? {}
            : {
                allOf: decodeOpenApiArray(source.allOf, `${label}.allOf`)
                    .map((item, index) => decodeOpenApiSchema(item, `${label}.allOf[${index}]`))
            }),
        ...(source.oneOf === undefined
            ? {}
            : {
                oneOf: decodeOpenApiArray(source.oneOf, `${label}.oneOf`)
                    .map((item, index) => decodeOpenApiSchema(item, `${label}.oneOf[${index}]`))
            }),
        ...(propertyName === undefined
            ? {}
            : { discriminator: { propertyName } })
    };
}

function decodeOpenApiRecord(value: unknown, label: string): ApiJsonObject {
    if (!isOpenApiRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

// js-yaml loads the document as plain JSON-compatible values.
function isOpenApiRecord(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeOpenApiArray(value: unknown, label: string): readonly ApiJsonValue[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    return value;
}

function decodeOpenApiStringArray(value: unknown, label: string): readonly string[] {
    const items = decodeOpenApiArray(value, label);
    if (!items.every((item) => typeof item === 'string')) {
        throw new TypeError(`${label} must contain only strings`);
    }
    return items;
}

function expectSchemaRequired(name: string, expected: readonly string[]): void {
    expect([...(schema(name).required ?? [])].sort()).toEqual([...expected].sort());
}

function statusVariant(schemaName: string, status: string): OpenApiSchema {
    const variant = schema(schemaName).oneOf?.find((candidate) => candidate.properties?.status?.enum?.includes(status));
    if (!variant) {
        throw new Error(`Missing ${schemaName} ${status} lifecycle variant`);
    }
    return variant;
}

function expectNullProperties(
    schemaName: string,
    status: string,
    propertyNames: readonly string[]
): void {
    const variant = statusVariant(schemaName, status);
    for (const propertyName of propertyNames) {
        expect(variant.properties?.[propertyName]?.enum).toEqual([null]);
        expect(variant.properties?.[propertyName]?.nullable).toBe(true);
    }
}

function expectAuditProperties(
    schemaName: string,
    status: string,
    propertyNames: readonly string[]
): void {
    const variant = statusVariant(schemaName, status);
    for (const propertyName of propertyNames) {
        expect(variant.properties?.[propertyName]?.$ref)
            .toBe('#/components/schemas/AuditStamp');
        expect(variant.properties?.[propertyName]?.nullable).not.toBe(true);
    }
}

function expectNullableAuditProperties(
    schemaName: string,
    status: string,
    propertyNames: readonly string[]
): void {
    const variant = statusVariant(schemaName, status);
    for (const propertyName of propertyNames) {
        expect(variant.properties?.[propertyName]?.allOf?.[0]?.$ref)
            .toBe('#/components/schemas/AuditStamp');
        expect(variant.properties?.[propertyName]?.nullable).toBe(true);
    }
}

function expectTypedProperties(
    schemaName: string,
    status: string,
    properties: Readonly<Record<string, string>>
): void {
    const variant = statusVariant(schemaName, status);
    for (const [propertyName, type] of Object.entries(properties)) {
        expect(variant.properties?.[propertyName]?.type).toBe(type);
        expect(variant.properties?.[propertyName]?.nullable).not.toBe(true);
    }
}

function readRepoFile(filePath: string): string {
    return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}
