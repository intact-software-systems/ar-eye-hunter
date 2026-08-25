import { describe, expect, it } from 'vitest';

import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { RtcTopologyOutboxWriter } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-writer.ts';
import { GroupTopologyReconfigureMutation } from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-mutation.ts';

import {
    createTopologyTestAuthorityGuard,
    createTopologyTestGroupRef,
    createTopologyTestGroupSnapshot
} from '../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('GroupTopologyReconfigureMutation', () => {
    it('computes the deterministic explicit outbox intent from the captured command', () => {
        const mutation = createMutation();
        const command = createCommand();
        const read = createRead();

        const computed = mutation.compute(command, read);

        expect(computed).toMatchObject({
            commandId: 'reconfigure-request',
            resourceId: 'reconfigure-request:rtc-topology-recompute:explicit',
            aggregateRef: createTopologyTestGroupRef(),
            acceptedCausalRevision: { groupRevision: 1, presenceRevision: 0 },
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            createdAtEpochMs: 1_000,
            senderId: 'owner',
            requestOptions: {
                topologyKind: { action: 'preserve' },
                degreeLimit: { action: 'set', value: 7 },
                treeMinSize: { action: 'preserve' },
                meshMinSize: { action: 'preserve' },
                meshParamK: { action: 'preserve' }
            },
            publish: true
        });
        expect(() => mutation.validate(command, read, computed)).not.toThrow();
    });

    it('rejects a non-admin actor who cannot update the current group', () => {
        const mutation = createMutation();
        const command = { ...createCommand(), actorPrincipalId: 'intruder' };
        const read = createRead();

        expect(() => mutation.validate(command, read, mutation.compute(command, read))).toThrow(
            'Forbidden: An active group member is required for this operation.'
        );
    });

    it('uses the mutation authority dependency as the sole administrator decision', () => {
        const read = createRead();
        const command = { ...createCommand(), actorPrincipalId: 'intruder' };
        const allowedMutation = createMutation(() => true);
        const deniedMutation = createMutation(() => false);
        const callerDeniedCommand = { ...command, isPlatformAdmin: false };
        const callerAllowedCommand = { ...command, isPlatformAdmin: true };

        expect(() =>
            allowedMutation.validate(
                callerDeniedCommand,
                read,
                allowedMutation.compute(callerDeniedCommand, read)
            )
        ).not.toThrow();
        expect(() =>
            deniedMutation.validate(
                callerAllowedCommand,
                read,
                deniedMutation.compute(callerAllowedCommand, read)
            )
        ).toThrow('Forbidden: An active group member is required for this operation.');
    });

    it('rejects altered computation before the transaction boundary', () => {
        const mutation = createMutation();
        const command = createCommand();
        const read = createRead();
        const computed = { ...mutation.compute(command, read), publish: false };

        expect(() => mutation.validate(command, read, computed)).toThrow(
            'Topology reconfigure computation is invalid'
        );
    });
});

function createMutation(
    isPlatformAdmin: (principalId: string) => boolean = () => false
): GroupTopologyReconfigureMutation {
    return new GroupTopologyReconfigureMutation({
        groupStateRepository: {} as never,
        readPlanningAuthority: async () => createRead().authority,
        isPlatformAdmin,
        outboxWriter: new RtcTopologyOutboxWriter({ recordWrite: () => undefined })
    });
}

function createCommand() {
    return {
        groupRef: createTopologyTestGroupRef(),
        commandId: 'reconfigure-request',
        actorPrincipalId: 'owner',
        capturedAtEpochMs: 1_000,
        requestOptions: { degreeLimit: 7 },
        publish: true
    } as const;
}

function createRead() {
    return {
        authority: {
            group: createTopologyTestGroupSnapshot(),
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttMeasurements: [],
            nowEpochMs: 1_000
        },
        authorityGuard: createTopologyTestAuthorityGuard()
    };
}
