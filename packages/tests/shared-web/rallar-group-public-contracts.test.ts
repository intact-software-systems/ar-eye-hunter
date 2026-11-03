import Ajv from 'ajv';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import {
    describe,
    expect,
    it
} from 'vitest';

import { requireRecord } from '@shared/api/exact-object-decoding.ts';

import {
    createActiveClientInstanceFixture,
    createActiveClientSessionFixture,
    createAuditStampFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture
} from './authoritative-group-fixtures.ts';
import { createFormationView } from './rooms/formation/room-formation-test-fixtures.ts';

const document = requireRecord(load(readFileSync('apps/api-v1/resources/api-v1-openapi.yaml', 'utf8')), 'OpenAPI');
const components = requireRecord(document.components, 'components');
const validator = new Ajv({ allErrors: true, unknownFormats: ['int64'] });
const groupRef = { applicationId: 'app', workspaceId: 'default', groupId: 'room' };
const clientRef = { applicationId: 'app', workspaceId: 'default', principalId: 'alice' };
const audit = createAuditStampFixture(1000, 'alice');
const groupSnapshot = createGroupSnapshotFixture({ ...groupRef, sessionIds: ['alice'] });
const clientSnapshot = createClientSnapshotFixture(clientRef);
const effectiveConfig = { topologyKind: 'auto', degreeLimit: 4, treeMinSize: 2, meshMinSize: 6, meshParamK: 2 };
const storedConfig = {
    groupRef,
    config: effectiveConfig,
    version: 1,
    createdAtEpochMs: 1000,
    updatedAtEpochMs: 2000,
    updatedByPrincipalId: 'alice',
    requestId: null
};
const acceptedCausalRevision = {
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 1 }
};

describe('Rallar group public contracts', () => {
    it('accepts explicit nullable audit and event fields but rejects missing or mistyped fields', () => {
        const clientEvent = {
            ...clientRef,
            eventId: 'client-event',
            eventType: 'principal-created',
            snapshotVersion: 1,
            clientInstanceId: null,
            sessionId: null,
            occurredAtEpochMs: 1000,
            actor: audit.actor,
            reason: null,
            traceId: null,
            requestId: null,
            payload: {}
        };
        const groupEvent = {
            ...groupRef,
            eventId: 'group-event',
            eventType: 'group-created',
            snapshotVersion: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            occurredAtEpochMs: 1000,
            actor: audit.actor,
            reason: null,
            traceId: null,
            requestId: null,
            payload: {}
        };
        for (const [schemaName, value] of [['AuditStamp', audit], ['ClientEvent', clientEvent], ['GroupEvent', groupEvent]] as const) {
            expectComplete(schemaName, value);
            const validate = createSchemaValidator(schemaName);
            for (const field of ['reason', 'traceId', 'requestId']) {
                expect(validate({ ...value, [field]: 'correlation' })).toBe(true);
                expect(validate({ ...value, [field]: 42 })).toBe(false);
            }
        }
        const validateClient = createSchemaValidator('ClientEvent');
        for (const field of ['clientInstanceId', 'sessionId']) {
            expect(validateClient({ ...clientEvent, [field]: 'client-session' })).toBe(true);
            expect(validateClient({ ...clientEvent, [field]: 42 })).toBe(false);
        }
    });

    it.each([
        { kind: 'principal', principalId: 'alice' },
        { kind: 'session', sessionId: 'session', principalId: 'alice' },
        { kind: 'service', serviceId: 'api' }
    ])('requires the identity for a $kind mutation actor', (actor) => {
        expectComplete('MutationActor', actor);
        const validate = createSchemaValidator('MutationActor');
        expect(validate({ ...actor, kind: 'unknown' })).toBe(false);
        expect(validate(null)).toBe(false);
    });

    it('requires complete snapshots and permits an explicit unknown last-seen time', () => {
        expectComplete('GroupSnapshot', groupSnapshot);
        expectComplete('ClientSnapshot', { ...clientSnapshot, lastSeenAtEpochMs: null });
        const validate = createSchemaValidator('ClientSnapshot');
        expect(validate(clientSnapshot)).toBe(true);
        expect(validate({ ...clientSnapshot, lastSeenAtEpochMs: 'yesterday' })).toBe(false);
    });

    it.each(
        [
            ['ClientPrincipal', clientSnapshot.principal, 'disabled'],
            ['Group', groupSnapshot.group, 'archived']
        ] as const
    )('correlates %s status with its lifecycle audit stamps', (schemaName, active, inactiveStatus) => {
        expectComplete(schemaName, active);
        const validate = createSchemaValidator(schemaName);
        expect(validate({ ...active, [inactiveStatus]: audit })).toBe(false);
        expect(validate({ ...active, deleted: audit })).toBe(false);
        expect(validate({ ...active, status: inactiveStatus })).toBe(false);
        const inactive = { ...active, status: inactiveStatus, [inactiveStatus]: audit };
        expect(validate(inactive), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...inactive, deleted: audit })).toBe(false);
        expect(validate({ ...inactive, [inactiveStatus]: {} })).toBe(false);
        expect(validate({ ...inactive, status: 'deleted' })).toBe(false);
        for (const previous of [null, audit]) {
            const deleted = { ...active, status: 'deleted', [inactiveStatus]: previous, deleted: audit };
            expect(validate(deleted), JSON.stringify(validate.errors)).toBe(true);
            expect(validate({ ...deleted, deleted: {} })).toBe(false);
            expect(validate({ ...deleted, [inactiveStatus]: {} })).toBe(false);
        }
        expect(validate({ ...active, status: 'unknown' })).toBe(false);
    });

    it('requires a revocation stamp for revoked and retired client instances', () => {
        const active = createActiveClientInstanceFixture({ ...clientRef, clientInstanceId: 'browser' });
        expectComplete('ClientInstance', active);
        const validate = createSchemaValidator('ClientInstance');
        expect(validate({ ...active, revoked: audit })).toBe(false);
        for (const status of ['revoked', 'retired']) {
            expect(validate({ ...active, status, revoked: audit })).toBe(true);
            expect(validate({ ...active, status })).toBe(false);
            expect(validate({ ...active, status, revoked: {} })).toBe(false);
        }
    });

    it.each(
        [
            ['ClientSession', createActiveClientSessionFixture({ ...clientRef, clientInstanceId: 'browser', sessionId: 'session' }), [
                'disconnected',
                'expired'
            ]],
            ['GroupPresenceSession', groupSnapshot.activeSessions[0], ['disconnected']]
        ] as const
    )('requires complete disconnect details for terminated %s records', (schemaName, active, statuses) => {
        expectComplete(schemaName, active);
        const validate = createSchemaValidator(schemaName);
        expect(validate({ ...active, disconnectedAtEpochMs: 2000 })).toBe(false);
        expect(validate({ ...active, disconnectReason: 'closed' })).toBe(false);
        for (const status of statuses) {
            const disconnected = { ...active, status, disconnectedAtEpochMs: 2000, disconnectReason: 'closed' };
            expect(validate(disconnected), JSON.stringify(validate.errors)).toBe(true);
            for (const field of ['disconnectedAtEpochMs', 'disconnectReason']) {
                expect(validate({ ...disconnected, [field]: null })).toBe(false);
                expect(validate({ ...disconnected, [field]: {} })).toBe(false);
            }
        }
    });

    it('correlates invitations, active membership and terminal membership with their audit stamps', () => {
        const active = groupSnapshot.members[0];
        expectComplete('GroupMember', active);
        const validate = createSchemaValidator('GroupMember');
        const invited = { ...active, status: 'invited', joined: null };
        expect(validate(invited), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...invited, joined: audit })).toBe(false);
        expect(validate({ ...active, joined: {} })).toBe(false);
        for (const field of ['left', 'removed', 'banned']) {
            expect(validate({ ...invited, [field]: audit })).toBe(false);
            expect(validate({ ...active, [field]: audit })).toBe(false);
        }
        for (const status of ['left', 'removed', 'banned']) {
            for (const joined of [null, audit]) {
                const terminal = { ...active, status, joined, [status]: audit };
                expect(validate(terminal), JSON.stringify(validate.errors)).toBe(true);
                expect(validate({ ...terminal, [status]: null })).toBe(false);
                expect(validate({ ...terminal, [status]: {} })).toBe(false);
                expect(validate({ ...terminal, joined: {} })).toBe(false);
                for (const other of ['left', 'removed', 'banned'].filter((field) => field !== status)) {
                    expect(validate({ ...terminal, [other]: audit })).toBe(false);
                }
            }
        }
    });

    it.each(['dormant', 'forming', 'planned', 'connecting', 'active', 'reconfiguring', 'reconnecting'])(
        'accepts the %s formation phase in group and formation responses',
        (lifecycleState) => {
            for (const [schemaName, value] of [['Group', groupSnapshot.group], ['GroupFormationView', createFormationView(groupRef)]] as const) {
                const validate = createSchemaValidator(schemaName);
                expect(validate({ ...value, lifecycleState }), JSON.stringify(validate.errors)).toBe(true);
                expect(validate({ ...value, lifecycleState: 'unknown' })).toBe(false);
            }
        }
    );

    it('allows sparse topology requests while requiring complete effective and stored output', () => {
        const validateRequest = createSchemaValidator('PutGroupTopologyConfigRequest');
        expect(validateRequest({ config: {} })).toBe(true);
        expect(validateRequest({ config: { degreeLimit: null } })).toBe(true);
        expect(validateRequest({ config: { degreeLimit: 4 } })).toBe(true);
        expect(validateRequest({})).toBe(false);
        expect(validateRequest({ config: { degreeLimit: 0 } })).toBe(false);
        expectComplete('EffectiveGroupTopologyConfig', effectiveConfig);
        expectComplete('StoredGroupTopologyConfig', storedConfig);
        const validateStored = createSchemaValidator('StoredGroupTopologyConfig');
        for (const field of Object.keys(effectiveConfig)) {
            const incomplete = Object.fromEntries(Object.entries(effectiveConfig).filter(([key]) => key !== field));
            expect(validateStored({ ...storedConfig, config: incomplete })).toBe(false);
            expect(validateStored({ ...storedConfig, config: { ...effectiveConfig, [field]: null } })).toBe(false);
        }
    });

    it('accepts absent topology layers as explicit null and validates populated overrides', () => {
        const view = { serverDefaults: effectiveConfig, durable: null, temporary: null, requestOptions: null, effective: effectiveConfig };
        expectComplete('GroupTopologyConfigView', view);
        const validate = createSchemaValidator('GroupTopologyConfigView');
        const override = { ...storedConfig, expiresAtEpochMs: 3000 };
        expect(validate({ ...view, durable: storedConfig, temporary: override, requestOptions: { degreeLimit: 3 } })).toBe(true);
        expect(validate({ ...view, temporary: storedConfig })).toBe(false);
        expect(validate({ ...view, temporary: { ...override, expiresAtEpochMs: null } })).toBe(false);
        expect(validate({ ...view, temporary: { ...override, config: {} } })).toBe(false);
        for (const field of ['durable', 'temporary', 'requestOptions']) {
            expect(validate({ ...view, [field]: 'invalid' })).toBe(false);
        }
    });

    it('requires complete topology receipts and rejects event ids or partial accepted configuration', () => {
        const receipt = {
            commandId: 'command',
            requestId: null,
            commandHash: `sha256:${'0'.repeat(64)}`,
            operation: 'putConfig',
            outcome: 'applied',
            attemptCount: 1,
            groupRef,
            target: 'config',
            acceptedVersion: 1,
            acceptedStorageRevision: null,
            acceptedCreatedAtEpochMs: null,
            acceptedUpdatedAtEpochMs: null,
            acceptedExpiresAtEpochMs: null,
            acceptedConfig: null,
            acceptedCausalRevision: null,
            eventId: null,
            outboxIds: []
        };
        expectComplete('GroupTopologyConfigMutationReceipt', receipt);
        expectComplete('GroupTopologyConfigAcceptedCausalRevision', acceptedCausalRevision);
        const validate = createSchemaValidator('GroupTopologyConfigMutationReceipt');
        expect(validate({ ...receipt, acceptedConfig: effectiveConfig, acceptedCausalRevision })).toBe(true);
        expect(validate({ ...receipt, eventId: 'event' })).toBe(false);
        expect(validate({ ...receipt, acceptedConfig: {} })).toBe(false);
        expect(validate({ ...receipt, acceptedCausalRevision: {} })).toBe(false);
        expect(validate({ ...receipt, acceptedCausalRevision: { ...acceptedCausalRevision, causalRevision: {} } })).toBe(false);
        const queued = { status: 'queued', groupRef, requestId: 'request', outboxId: 'outbox' };
        expectComplete('QueuedGroupTopologyReconfigureResponse', queued);
        expect(createSchemaValidator('QueuedGroupTopologyReconfigureResponse')({ ...queued, status: 'applied' })).toBe(false);
    });

    it('requires the complete scoped overlay and its causal revision', () => {
        const overlay = {
            sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
            state: 'active',
            overlayId: 'overlay',
            groupRef,
            name: 'room',
            topology: 'tree',
            activeSessionIds: ['session'],
            nextHopsBySessionId: { session: [] },
            degreeLimit: 4,
            version: 1,
            createdByClientId: 'server',
            createdAtEpochMs: 1000,
            updatedAtEpochMs: 1000
        };
        expectComplete('RallarOverlayTopologySnapshot', overlay);
        const validate = createSchemaValidator('RallarOverlayTopologySnapshot');
        expect(validate({ ...overlay, sourceGroupStateCausalRevision: { groupRevision: 1 } })).toBe(false);
        expect(validate({ ...overlay, nextHopsBySessionId: { session: [42] } })).toBe(false);
    });

    it.each(['group-invite-required', 'group-full', 'formation-attempts-exhausted'])(
        'publishes the actionable %s policy reason',
        (reason) => {
            const validate = createSchemaValidator('GroupPolicyReasonCode');
            expect(validate(reason)).toBe(true);
            expect(validate('unknown-policy-reason')).toBe(false);
        }
    );

    it.each(
        [
            ['app.scores', true],
            ['room.feed', true],
            ['room.a:b_c-d.e', true],
            ['room.', true],
            ['rallar.state', false],
            ['group-state.event', false],
            ['feed', false],
            ['room.a b', false],
            [' room.feed', false],
            ['room.\u00fc', false],
            [`room.${'a'.repeat(123)}`, true],
            [`room.${'a'.repeat(124)}`, false]
        ] as const
    )('applies the public topic rule to %s grants and requests', (topicId, accepted) => {
        expect(createSchemaValidator('GroupPublicationTopicGrants')({ [topicId]: { publish: true, subscribe: false } })).toBe(accepted);
        for (const schemaName of ['GrantGroupPublicationRequest', 'RevokeGroupPublicationRequest']) {
            expect(createSchemaValidator(schemaName)({ topicId, publish: true, subscribe: false })).toBe(accepted);
        }
        for (const schemaName of ['SubscribeGroupTopicRequest', 'UnsubscribeGroupTopicRequest']) {
            expect(createSchemaValidator(schemaName)({ topicId, connectionGenerationId: 'generation' })).toBe(accepted);
        }
    });

    it('bounds topic grants and requires explicit permissions in publication mutations', () => {
        const topics = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`room.topic-${index}`, { publish: true, subscribe: false }]));
        const validate = createSchemaValidator('GroupPublicationTopicGrants');
        expect(validate(topics)).toBe(true);
        expect(validate({ ...topics, 'room.overflow': { publish: true, subscribe: false } })).toBe(false);
        expectComplete('GroupPublicationTopicPermissions', { publish: true, subscribe: false });
        expect(validate({ 'room.feed': { publish: 'yes', subscribe: false } })).toBe(false);
        expectComplete('GroupPublicationGrant', { ...groupRef, principalId: 'alice', topics, updated: audit });
        for (const schemaName of ['GrantGroupPublicationRequest', 'RevokeGroupPublicationRequest']) {
            expectComplete(schemaName, { topicId: 'room.feed', publish: true, subscribe: false });
        }
        const create = createSchemaValidator('CreateGroupRequest');
        const request = { groupId: 'room', displayName: 'Room', kind: 'room' };
        expect(create(request)).toBe(true);
        expect(create({ ...request, publicationGrants: topics })).toBe(true);
        expect(create({ ...request, publicationGrants: { 'rallar.state': { publish: true, subscribe: false } } })).toBe(false);
    });

    it('requires session and connection generation identity on topic subscriptions', () => {
        const subscription = {
            sessionId: 'bob-session',
            principalId: 'bob',
            topicId: 'room.feed',
            connectionGenerationId: 'bob-generation',
            leaseExpiresAtEpochMs: 120_000,
            admittedAtGroupRevision: 3
        };
        expectComplete('GroupTopicSubscription', subscription);
        const validate = createSchemaValidator('GroupTopicSubscription');
        expect(validate({ ...subscription, connectionGenerationId: '' })).toBe(false);
        expect(validate({ ...subscription, topicId: 'rallar.state' })).toBe(false);
        expect(validate({ ...subscription, leaseExpiresAtEpochMs: 0 })).toBe(false);
        expect(validate({ ...subscription, admittedAtGroupRevision: 0 })).toBe(false);
        expectComplete('GroupTopicSubscriptionList', { subscriptions: [subscription] });
        expect(createSchemaValidator('GroupTopicSubscriptionList')({ subscriptions: [{}] })).toBe(false);
        for (const schemaName of ['SubscribeGroupTopicRequest', 'UnsubscribeGroupTopicRequest']) {
            expectComplete(schemaName, { topicId: 'room.feed', connectionGenerationId: 'generation' });
        }
        const validateResult = createSchemaValidator('GroupTopicSubscriptionResult');
        for (const outcome of ['subscribed', 'renewed', 'unsubscribed', 'not-subscribed']) {
            expect(validateResult({ outcome })).toBe(true);
        }
        expect(validateResult({})).toBe(false);
        expect(validateResult({ outcome: 'unknown' })).toBe(false);
    });
});

function createSchemaValidator(schemaName: string): Ajv.ValidateFunction {
    return validator.compile({ $ref: `#/components/schemas/${schemaName}`, components });
}

function expectComplete(schemaName: string, value: object): void {
    const validate = createSchemaValidator(schemaName);
    expect(validate(value), `${schemaName}: ${JSON.stringify(validate.errors)}`).toBe(true);
    for (const field of Object.keys(value)) {
        const incomplete = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
        expect(validate(incomplete), `${schemaName}.${field} must not be omitted`).toBe(false);
    }
}
