import { isDeepStrictEqual } from 'node:util';
import {
    describe,
    expect,
    it
} from 'vitest';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import { readAlmReceiptRolesEntries } from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
import type {
    RallarBlackBoxTestRtcConnectCommand,
    RallarBlackBoxTestWaitCommand,
    RallarBlackBoxTestWaitMatch
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    createHetznerDistributedManifestCatalog,
    HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER
} from '../../../apps/rallar-black-box/src/create-hetzner-distributed-manifest-catalog.ts';
import { toHetznerManifestCommands } from './hetzner-manifest-test-commands.ts';

/**
 * `match` is shadowed when an event that satisfies `other` always satisfies it too: every other criterion is the same,
 * its `contains` is a substring of the other's, and its `equals` is the other's.
 */
function isWaitMatchShadowedBy(match: RallarBlackBoxTestWaitMatch, other: RallarBlackBoxTestWaitMatch): boolean {
    const otherFields = new Map(Object.entries(other));
    return Object.entries(match).every(([field, value]) => {
        const otherValue = otherFields.get(field);
        return field === 'contains'
            ? typeof otherValue === 'string' && otherValue.includes(String(value))
            : otherValue !== undefined && isDeepStrictEqual(value, otherValue);
    });
}

describe('Hetzner ALM conformance catalog', () => {
    it('adds the ALM conformance 3-agent manifest with one sender and two recipients, pinning each receipt', () => {
        const entry = createHetznerDistributedManifestCatalog()
            .find((candidate) => candidate.filePath.endsWith('/22-alm-conformance-3-agent.json'));

        expect(entry?.agentCount).toBe(3);
        expect(entry?.mainline).toBe(false);
        expect(HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER).toContain(entry?.filePath);
        expect(entry?.manifest.metadata).toMatchObject({ family: 'alm-conformance', scenarios: ['receipted-audience'] });
        const sender = entry?.manifest.recipes.find((selection) => selection.role === 'sender')?.recipe;
        // An empty checkpoint list would read as a paired reload run of two roots, which the control server refuses.
        expect(sender?.metadata).not.toHaveProperty('almReloadCheckpoints');
        const pinnedHandles = sender && readAlmReceiptRolesEntries(sender).map((pin) => pin.handleId);
        expect(pinnedHandles).toEqual([
            'alm-ws-aggregated-receipt-send-1',
            'alm-ws-missing-recipient-retry-send-1',
            'alm-ws-frozen-audience-membership-send-1',
            ...['rtc', 'rtc-with-ws-fallback'].flatMap((carrier) =>
                ['aggregated-receipt', 'missing-recipient-retry', 'unknown-ack-version', 'frozen-audience-membership']
                    .map((key) => `alm-${carrier}-${key}-send-1`)
            )
        ]);
    });

    it('leaves no positive wait of the 3-agent ALM recipes matchable by an event another wait awaits, since a wait also matches past events', () => {
        const manifest = createHetznerDistributedManifestCatalog()
            .find((candidate) => candidate.filePath.endsWith('/22-alm-conformance-3-agent.json'))!.manifest;
        for (const selection of manifest.recipes) {
            const matches = (selection.recipe?.commands ?? [])
                .filter((command): command is RallarBlackBoxTestWaitCommand => command.kind === 'wait' && command.absent !== true)
                .map((command) => command.match ?? {});
            const shadowed = matches.filter((match, index) => matches.some((other, otherIndex) => otherIndex !== index && isWaitMatchShadowedBy(match, other)));

            expect(shadowed, selection.role).toEqual([]);
        }
    });

    it('reads a wait as shadowed when every event another wait awaits also satisfies it', () => {
        const topic = 'rallar.browser.alm.inbound_diagnostics';
        const refusal: RallarBlackBoxTestWaitMatch = { kind: 'diagnostic', topic, contains: '"carrier":"rtc","outcome":"rejected","reason":"unsupported"' };

        expect(isWaitMatchShadowedBy({ ...refusal, contains: '"carrier":"rtc","outcome":"rejected"' }, refusal)).toBe(true);
        expect(isWaitMatchShadowedBy({ kind: 'diagnostic', topic }, refusal)).toBe(true);
        expect(isWaitMatchShadowedBy({ kind: 'event', equals: { n: [1] } }, { kind: 'event', equals: { n: [1] } })).toBe(true);
        expect(isWaitMatchShadowedBy(refusal, { ...refusal, contains: '"carrier":"rtc","outcome":"rejected"' })).toBe(false);
        expect(isWaitMatchShadowedBy({ ...refusal, topic: 'other' }, refusal)).toBe(false);
        expect(isWaitMatchShadowedBy({ kind: 'event', equals: { n: [1] } }, { kind: 'event', equals: { n: [2] } })).toBe(false);
        expect(isWaitMatchShadowedBy({ kind: 'event', equals: { n: [1] } }, { kind: 'event' })).toBe(false);
    });

    it('keeps every identity of the 3-agent ALM manifest apart from the 2-agent one, so both can run in one profile', () => {
        const catalog = createHetznerDistributedManifestCatalog();
        const identitiesOf = (fileName: string) => {
            const manifest = catalog.find((candidate) => candidate.filePath.endsWith(fileName))!.manifest;
            return new Set([
                ...manifest.recipes.map((selection) => selection.recipe?.recipeId ?? ''),
                ...toHetznerManifestCommands(manifest).flatMap((command) => [
                    command.commandId ?? '',
                    ...(command.kind === 'http.request' ? [JSON.stringify(command.request)] : []),
                    ...('handleId' in command && command.handleId !== undefined ? [command.handleId] : [])
                ])
            ]);
        };
        const threeAgent = identitiesOf('/22-alm-conformance-3-agent.json');
        const shared = [...identitiesOf('/18-alm-conformance-2-agent.json')].filter((identity) => threeAgent.has(identity));

        expect(shared).toEqual([]);
    });

    it('adds the ALM conformance 2-agent manifest with sender/receiver roles across all three carriers', () => {
        const entry = createHetznerDistributedManifestCatalog()
            .find((candidate) => candidate.filePath.endsWith('/18-alm-conformance-2-agent.json'));

        expect(entry).toBeDefined();
        // Conformance entries remain extended regardless of the scale workload changes.
        expect(entry?.mainline).toBe(false);
        expect(entry?.diagnostic).toBe(false);
        expect(entry?.agentCount).toBe(2);
        expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER).not.toContain(entry?.filePath);
        expect(HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER).toContain(entry?.filePath);
        expect(entry?.manifest.targetPolicy).toMatchObject({
            mode: 'role-map',
            expectedParticipantCount: 2,
            roles: { sender: ['controller-01'], receiver: ['controller-02'] }
        });
        expect(entry?.manifest.roleAssignments).toEqual([
            { role: 'sender', agentId: 'controller-01', recipeIds: [], variables: {} },
            { role: 'receiver', agentId: 'controller-02', recipeIds: [], variables: {} }
        ]);
        expect(entry?.manifest.recipes.map((selection) => selection.role)).toEqual(['sender', 'receiver']);
        expect(entry?.manifest.metadata).toMatchObject({
            family: 'alm-conformance',
            carriers: ['ws', 'rtc', 'rtc-with-ws-fallback'],
            scenarios: [
                'delivery-reload',
                'volatile-default',
                'bounded-rejection',
                'deadline-expiry',
                'delivery-baseline',
                'delivery-lifecycle',
                'durable-opt-in',
                'storage-unavailable',
                'ordering-resync',
                'ws-unicast-receipt',
                'server-command',
                'not-yet-in-sync',
                'cross-carrier-duplicate',
                'fallback-within-deadline',
                'receipt-exhausted-fallback',
                'no-fallback-after-deadline',
                'unicast-fallback',
                'capacity'
            ]
        });

        const commandIds = toHetznerManifestCommands(entry!.manifest)
            .map((command) => command.commandId ?? '');
        // API-v1 routes a WS-carried multicast room envelope, so both cross-carrier orders are covered.
        expect(commandIds.some((commandId) => commandId.includes('cross-carrier-duplicate-ws-then-rtc'))).toBe(true);
        expect(commandIds).toContain('alm-rtc-with-ws-fallback-cross-carrier-duplicate-rtc-then-ws-receiver-duplicate-outcome-ws');
        for (const carrier of ['rtc', 'rtc-with-ws-fallback']) {
            expect(commandIds).toContain(`alm-${carrier}-not-yet-in-sync-expires-receiver-not-yet-in-sync-outcome`);
        }
        // The server is no RTC peer, so only the ws block addresses it.
        expect(commandIds).toContain('alm-ws-server-command-sender-send-1');
        expect(
            commandIds.some((commandId) => /^alm-rtc(-with-ws-fallback)?-server-command-/.test(commandId))
        ).toBe(false);
        expect(entry?.manifest.metadata?.recommendedTerminalTimeoutSeconds).toBe(1_800);
        // A capacity block closes and reconnects its sender, so only the other carriers' capacity blocks follow it.
        for (const selection of entry?.manifest.recipes ?? []) {
            const roleCommandIds = (selection.recipe?.commands ?? [])
                .map((command) => command.commandId ?? '');
            const firstCapacity = roleCommandIds.findIndex((commandId) => /^alm-[a-z-]+-capacity-/.test(commandId));
            expect(firstCapacity, selection.role).toBeGreaterThan(0);
            expect(roleCommandIds.slice(firstCapacity).filter((commandId) => !commandId.includes('-capacity-')), selection.role)
                .toEqual([]);
        }

        const rtcConnects = toHetznerManifestCommands(entry!.manifest)
            .filter((command): command is RallarBlackBoxTestRtcConnectCommand => command.kind === 'rtc.connect' && command.transport === 'messages.rtc');
        // Two prologues, three reload reconnects, and the capacity sender's lowered and restored connect per carrier.
        expect(rtcConnects).toHaveLength(11);
        expect(rtcConnects.every((command) => command.rallar?.messageSelector !== undefined)).toBe(true);
        expect(rtcConnects.every((command) => command.rallar?.topicId === 'room.alm-conformance')).toBe(true);

        // The RTC overlay tracks logical receipts, so every carrier's receiver send asks for receiver by its own name.
        const receiverSends = toHetznerManifestCommands(entry!.manifest)
            .filter(isRallarBlackBoxTestMessagesSendCommand).filter((command) => command.ack === 'receiver');
        const algoByCarrier = (carrier: string) => [
            ...new Set(
                receiverSends
                    .filter((command) =>
                        ['rtc-with-ws-fallback', 'rtc', 'ws'].find((candidate) => command.commandId?.startsWith(`alm-${candidate}-`)) === carrier
                    )
                    .map((command) => command.qos?.ack?.algo)
            )
        ];
        for (const carrier of ['ws', 'rtc', 'rtc-with-ws-fallback']) {
            expect(algoByCarrier(carrier), carrier).toEqual([undefined]);
        }
    });
});
