import { describe, expect, it } from 'vitest';

import {
    validateAuthoritativeGroupEvent,
    validateAuthoritativeGroupEventIssues,
    validateAuthoritativeGroupSnapshot,
    validateAuthoritativeGroupSnapshotIssues
} from '@shared/api/authoritative-state-validation.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const scope = { applicationId: 'collector-app', workspaceId: 'collector-workspace' };
const ref = { ...scope, groupId: 'collector-group' };

describe('canonical authoritative group validation issues', () => {
    it('collects independent event, scope, causal and actor issues in decoder order', () => {
        const event = {
            ...createEvent(),
            applicationId: 'wrong-app',
            eventId: '',
            causalRevision: { groupRevision: -1, presenceRevision: -1 },
            occurredAtEpochMs: -1,
            actor: { kind: 'session', sessionId: '', principalId: '' },
            payload: null
        };

        const issues = validateAuthoritativeGroupEventIssues(event, ref);

        expect(issues[0]).toEqual({ path: 'GroupEvent', message: 'GroupEvent is outside the requested scope' });
        expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
            'GroupEvent.eventId is invalid',
            'GroupEvent.causalRevision.groupRevision is invalid',
            'GroupEvent.causalRevision.presenceRevision is invalid',
            'GroupEvent.occurredAtEpochMs is invalid',
            'GroupEvent.actor.sessionId is invalid',
            'GroupEvent.actor.principalId is invalid',
            'GroupEvent.payload must be an object'
        ]));
        expect(() => validateAuthoritativeGroupEvent(event, ref))
            .toThrow(new TypeError('GroupEvent is outside the requested scope'));
    });

    it('collects independent snapshot group, audit, roster and presence failures', () => {
        const original = createGroupSnapshotFixture({ ...ref, sessionIds: ['owner'] });
        const snapshot = {
            ...original,
            group: { ...original.group, displayName: '', maxMembers: 0 },
            members: original.members.map((member) => ({
                ...member,
                role: 'invalid-role',
                updated: { ...member.updated, atEpochMs: -1, actor: { kind: 'service', serviceId: '' } }
            })),
            activeSessions: original.activeSessions.map((session) => ({ ...session, generationVersion: 0 })),
            memberCount: -1
        };

        const issues = validateAuthoritativeGroupSnapshotIssues(snapshot, scope);

        expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
            'GroupSnapshot.group.displayName is invalid',
            'GroupSnapshot.group.maxMembers is invalid',
            'GroupSnapshot.member.role is invalid',
            'GroupSnapshot.member.updated.atEpochMs is invalid',
            'GroupSnapshot.member.updated.actor.serviceId is invalid',
            'GroupSnapshot.session.generationVersion is invalid',
            'GroupSnapshot.memberCount is invalid',
            'GroupSnapshot aggregate counts are inconsistent'
        ]));
        expect(() => validateAuthoritativeGroupSnapshot(snapshot, scope))
            .toThrow(new TypeError('GroupSnapshot.group.displayName is invalid'));
    });

    it('reports missing fields before invalid contents without traversing malformed branches', () => {
        const event = { actor: null, causalRevision: [], payload: null };
        const issues = validateAuthoritativeGroupEventIssues(event, ref);

        expect(issues[0]).toEqual({ path: 'GroupEvent.applicationId', message: 'GroupEvent is missing applicationId' });
        expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
            'GroupEvent.actor must be an object',
            'GroupEvent.causalRevision must be an object',
            'GroupEvent.payload must be an object'
        ]));
        expect(() => validateAuthoritativeGroupEvent(event, ref))
            .toThrow(new TypeError('GroupEvent is missing applicationId'));
        expect(validateAuthoritativeGroupSnapshotIssues(null, scope))
            .toEqual([{ path: 'GroupSnapshot', message: 'GroupSnapshot must be an object' }]);
    });

    it('stops the assertion boundary at the first issue', () => {
        const event = { actor: null, causalRevision: [], payload: null };
        Object.defineProperty(event, 'eventId', {
            enumerable: true,
            get(): never {
                throw new Error('later event fields must not be inspected');
            }
        });

        expect(() => validateAuthoritativeGroupEvent(event, ref))
            .toThrow(new TypeError('GroupEvent is missing applicationId'));
    });

    it.each([
        { name: 'one sparse hole', electorate: new Array<string>(1) },
        { name: 'a hole before a principal', electorate: [, 'owner'] },
        { name: 'explicit undefined', electorate: [undefined] }
    ])('rejects $name in the formation electorate without changing the input', ({ electorate }) => {
        const original = createGroupSnapshotFixture({ ...ref, sessionIds: ['owner'] });
        const snapshot = { ...original, group: { ...original.group, formationElectorate: electorate } };
        const descriptors = Object.getOwnPropertyDescriptors(electorate);

        expect(validateAuthoritativeGroupSnapshotIssues(snapshot, scope)).toEqual([{
            path: 'GroupSnapshot.group.formationElectorate[0]',
            message: 'GroupSnapshot.group.formationElectorate entries must be non-empty strings'
        }]);
        expect(() => validateAuthoritativeGroupSnapshot(snapshot, scope))
            .toThrow(new TypeError('GroupSnapshot.group.formationElectorate entries must be non-empty strings'));
        expect(Object.getOwnPropertyDescriptors(electorate)).toEqual(descriptors);
    });

    it.each([
        { name: 'two sparse holes', electorate: new Array<string>(2), invalidIndices: [0, 1] },
        { name: 'a hole and repeated principals', electorate: [, 'owner', 'owner'], invalidIndices: [0] }
    ])('preserves duplicate-error priority while collecting every hole in $name', ({ electorate, invalidIndices }) => {
        const original = createGroupSnapshotFixture({ ...ref, sessionIds: ['owner'] });
        const snapshot = { ...original, group: { ...original.group, formationElectorate: electorate } };

        expect(validateAuthoritativeGroupSnapshotIssues(snapshot, scope)).toEqual([
            {
                path: 'GroupSnapshot.group.formationElectorate',
                message: 'GroupSnapshot.group.formationElectorate must not repeat principal ids'
            },
            ...invalidIndices.map((index) => ({
                path: `GroupSnapshot.group.formationElectorate[${index}]`,
                message: 'GroupSnapshot.group.formationElectorate entries must be non-empty strings'
            }))
        ]);
        expect(() => validateAuthoritativeGroupSnapshot(snapshot, scope))
            .toThrow(new TypeError('GroupSnapshot.group.formationElectorate must not repeat principal ids'));
    });

    it('accepts canonical values unchanged through both collection and assertion boundaries', () => {
        const event = Object.freeze(createEvent());
        const snapshot = Object.freeze(createGroupSnapshotFixture({ ...ref, sessionIds: ['owner'] }));
        const eventBefore = JSON.stringify(event);
        const snapshotBefore = JSON.stringify(snapshot);

        expect(validateAuthoritativeGroupEventIssues(event, ref)).toEqual([]);
        expect(validateAuthoritativeGroupSnapshotIssues(snapshot, scope)).toEqual([]);
        expect(validateAuthoritativeGroupEvent(event, ref)).toBeUndefined();
        expect(validateAuthoritativeGroupSnapshot(snapshot, scope)).toBeUndefined();
        expect(JSON.stringify(event)).toBe(eventBefore);
        expect(JSON.stringify(snapshot)).toBe(snapshotBefore);
    });
});

function createEvent(): GroupEvent {
    return {
        ...ref,
        eventId: 'collector-event',
        eventType: 'group-updated',
        snapshotVersion: 2,
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        occurredAtEpochMs: 10,
        actor: { kind: 'session', sessionId: 'owner-session', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: 'collector-request',
        payload: {}
    };
}
