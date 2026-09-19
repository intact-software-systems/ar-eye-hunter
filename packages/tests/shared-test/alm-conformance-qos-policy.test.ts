import { describe, expect, it } from 'vitest';

import { computeAlmConformanceQosDefaults } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/compute-alm-conformance-qos-defaults.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy, resolveALQosNormalizationInput } from '@shared/al-contracts/al-policy.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const specimen = newALMulticastMessage('sender', { topicId: 'room.lifecycle', contextId: 'room', resourceId: 'old' }, room, 'alm.lifecycle', {
    marker: 'delivery-lifecycle',
    specimen: 'supersedence'
});
const provider = { defaultsForMessage: computeAlmConformanceQosDefaults };

describe('black-box conformance QoS policy', () => {
    it('uses one collision-safe slot per sender, application, workspace, room and message type', () => {
        const selected = normalizeALQosPolicy(specimen, resolveALQosNormalizationInput(specimen, { direction: 'outbound' }, provider));
        expect(selected.effective.supersedence).toEqual({
            algo: 'latest-wins',
            opts: { supersedenceKey: '["sender","app","workspace","room","alm.lifecycle"]' }
        });
        const variants: ALMessage[] = [
            { ...specimen, id: { ...specimen.id, senderId: 'other' } },
            { ...specimen, payload: { ...specimen.payload, typeId: 'other' } },
            ...[
                { ...room, applicationId: 'other' },
                { ...room, workspaceId: 'other' },
                { ...room, groupId: 'other' },
                { ...room, applicationId: 'app/workspace', workspaceId: 'room', groupId: '' }
            ].map((groupRef): ALMessage => ({ ...specimen, targets: { mode: 'multicast', groupRef } }))
        ];
        const keys = [specimen, ...variants].map((message) =>
            computeAlmConformanceQosDefaults(message, { direction: 'outbound' })?.supersedence?.opts.supersedenceKey
        );
        expect(keys.every((key) => key !== undefined)).toBe(true);
        expect(new Set(keys).size).toBe(keys.length);
    });
    it('keeps ordinary facade, ordinary messages, inbound and unscoped traffic on the default policy', () => {
        expect(normalizeALQosPolicy(specimen).effective.supersedence.algo).toBe('none');
        expect(computeAlmConformanceQosDefaults(specimen, { direction: 'inbound' })).toBeUndefined();
        expect(computeAlmConformanceQosDefaults({ ...specimen, targets: undefined }, { direction: 'outbound' })).toBeUndefined();
        for (const resource of ['null', '[]', '{}', 'not-json', '{"marker":"delivery-lifecycle"}', '{"marker":"ordinary","specimen":"supersedence"}']) {
            const message = { ...specimen, payload: { ...specimen.payload, resource } };
            const selected = normalizeALQosPolicy(message, resolveALQosNormalizationInput(message, { direction: 'outbound' }, provider));
            expect(selected.effective.supersedence.algo).toBe('none');
        }
    });
});
