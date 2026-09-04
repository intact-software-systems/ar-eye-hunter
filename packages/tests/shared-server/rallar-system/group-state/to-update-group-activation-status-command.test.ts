import { describe, expect, it } from 'vitest';

import {
    toUpdateGroupActivationStatusCommand,
    type ToUpdateGroupActivationStatusCommandInput
} from '@shared-server/rallar-system/group-state/to-update-group-activation-status-command.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';

const GROUP_REF = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'room-1' };
const BASIS: GroupLayoutIdentity = {
    groupRevision: 7,
    presenceRevision: 3,
    version: 2,
    state: 'active'
};

describe('the activation status command id', () => {
    // The idempotency row keys on the command id and never expires, so an id
    // that repeats within one basis makes a changed status a 409 and an
    // unchanged one a replay of the first receipt.
    it('distinguishes two readings of one basis by their evidence', () => {
        const first = commandFor({ evidenceWatermark: { version: 4, createdAtEpochMs: 1_000 } });
        const second = commandFor({ evidenceWatermark: { version: 9, createdAtEpochMs: 2_000 } });

        expect(first.commandId).not.toBe(second.commandId);
    });

    it('replays a genuinely repeated reading', () => {
        const watermark = { version: 4, createdAtEpochMs: 1_000 };

        expect(commandFor({ evidenceWatermark: watermark }).commandId)
            .toBe(commandFor({ evidenceWatermark: watermark }).commandId);
    });

    // A clock write observes an absence of evidence, so it has no watermark to
    // key on and takes its due instant instead.
    it('separates a dwell write from an evidence write on one fence', () => {
        const evidence = commandFor({ evidenceWatermark: null });
        const dwell = commandFor({
            evidenceWatermark: null,
            dwell: { satisfied: true, dueAtEpochMs: 5_000 }
        });

        expect(evidence.commandId).not.toBe(dwell.commandId);
    });

    it('separates two dwell writes by their due instant', () => {
        const first = commandFor({ dwell: { satisfied: true, dueAtEpochMs: 5_000 } });
        const second = commandFor({ dwell: { satisfied: true, dueAtEpochMs: 8_000 } });

        expect(first.commandId).not.toBe(second.commandId);
    });

    it('starts a distinct series for a new epoch or a new basis', () => {
        const base = commandFor({});

        expect(commandFor({ formationEpoch: 3 }).commandId).not.toBe(base.commandId);
        expect(commandFor({ coverageBasisLayoutIdentity: { ...BASIS, version: 3 } }).commandId)
            .not.toBe(base.commandId);
    });

    it('carries its fences and claims no semantic actor', () => {
        const command = commandFor({});

        expect(command.operation).toBe('updateGroupActivationStatus');
        expect(command.requestId).toBe(command.commandId);
        expect(command.input).toMatchObject({
            actorPrincipalId: null,
            actorSessionId: null,
            expectedFormationEpoch: 2,
            expectedLayout: BASIS,
            dwellSatisfied: false
        });
    });
});

function commandFor(overrides: Partial<ToUpdateGroupActivationStatusCommandInput>) {
    return toUpdateGroupActivationStatusCommand({
        groupRef: GROUP_REF,
        formationEpoch: 2,
        coverageBasisLayoutIdentity: BASIS,
        coverageRate: 0.8,
        evidenceWatermark: { version: 4, createdAtEpochMs: 1_000 },
        replanQueued: false,
        layoutStale: false,
        dwell: null,
        ...overrides
    });
}
