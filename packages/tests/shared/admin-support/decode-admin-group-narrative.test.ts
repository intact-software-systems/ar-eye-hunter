import { expect, it } from 'vitest';

import { decodeAdminGroupNarrative } from '@shared/api/admin-support/decode-admin-group-narrative.ts';

const roomRef = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'room-1' };
const response = {
    target: { kind: 'group', groupRef: roomRef },
    generatedAtEpochMs: 1_000,
    facts: [{ label: 'group.status', source: 'group-state', value: 'active', certainty: 'exact' }],
    timeline: [{ atEpochMs: 900, source: 'group-state-events', eventType: 'group-created', summary: 'Created.' }],
    warnings: [{ code: 'unconfirmed', message: 'Connectivity is unknown.' }],
    likelyCauses: [],
    suggestedActions: [{ code: 'refresh', label: 'Refresh', severity: 'info' }],
    rawRefs: []
};

it('accepts the requested room explanation including unavailable facts and optional evidence fields', () => {
    expect(decodeAdminGroupNarrative(response, roomRef)).toEqual(response);
    const unavailableFacts = {
        ...response,
        serverId: 'server-a',
        facts: [{
            label: 'participation',
            source: 'app',
            value: { nested: [null, 4, true] },
            certainty: 'unavailable',
            redacted: true
        }]
    };
    expect(decodeAdminGroupNarrative(unavailableFacts, roomRef)).toEqual(unavailableFacts);
});

it('rejects mismatched scope, room or target and refuses partial identities', () => {
    for (
        const groupRef of [
            { ...roomRef, applicationId: 'foreign' },
            { ...roomRef, workspaceId: 'foreign' },
            { ...roomRef, groupId: 'other' },
            { applicationId: roomRef.applicationId, groupId: roomRef.groupId }
        ]
    ) {
        expect(() => decodeAdminGroupNarrative({ ...response, target: { kind: 'group', groupRef } }, roomRef)).toThrow();
    }
    expect(() => decodeAdminGroupNarrative({ ...response, target: { kind: 'client', scope: roomRef } }, roomRef)).toThrow();
});

it('rejects malformed evidence, unsupported certainty and missing outcome sections', () => {
    for (
        const patch of [
            { facts: [{ ...response.facts[0], certainty: 'probably' }] },
            { facts: [{ ...response.facts[0], value: Number.NaN }] },
            { facts: [{ ...response.facts[0], redacted: 'yes' }] },
            { facts: [response.facts[0], response.facts[0]] },
            { warnings: [{ message: 'No code' }] },
            { timeline: [{ ...response.timeline[0], atEpochMs: -1 }] },
            { suggestedActions: [{ ...response.suggestedActions[0], severity: 'automatic' }] },
            { likelyCauses: null },
            { generatedAtEpochMs: -1 },
            { extra: 'undocumented' }
        ]
    ) {
        expect(() => decodeAdminGroupNarrative({ ...response, ...patch }, roomRef)).toThrow();
    }
});
