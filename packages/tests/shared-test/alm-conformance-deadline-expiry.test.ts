import {
    describe,
    expect,
    it
} from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type CreateAlmConformanceRecipesInput
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';

const MINIMUM_DEADLINE_MS = 14_500;
const MINIMUM_POST_EXPIRY_OBSERVATION_MS = 2_500;

function conformanceInput(
    carrier: CreateAlmConformanceRecipesInput['carrier'],
    deadlineMs = MINIMUM_DEADLINE_MS
): CreateAlmConformanceRecipesInput {
    return {
        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
        carrier,
        typeId: 'alm.conformance',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs
    };
}

describe('ALM conformance deadline expiry', () => {
    it('rejects a deadline that cannot contain the worst-case fault and expiry windows', () => {
        expect(() => createAlmConformanceRecipes(conformanceInput('rtc', MINIMUM_DEADLINE_MS - 1)))
            .toThrow(new RangeError(
                `createAlmConformanceRecipes requires deadlineMs of at least ${MINIMUM_DEADLINE_MS}.`
            ));
        expect(() => createAlmConformanceRecipes(conformanceInput('rtc'))).not.toThrow();
    });

    it('keeps admission live while fitting expiry inside every receiver window', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(conformanceInput(carrier));
            const deadline = scenarios
                .find((scenario) => scenario.scenarioId === 'deadline-expiry');
            const senderCommands = deadline?.sender.commands ?? [];
            const send = senderCommands.find((command) => command.kind === 'messages.send');
            const faultBudgetMs = senderCommands.reduce(
                (total, command) => command.kind === 'fault.inject'
                    ? total + (command.timeoutMs ?? 0)
                    : total,
                0
            );
            const received = deadline?.receiver.commands.find(
                (command) => command.kind === 'messages.received'
            );

            expect(send).toMatchObject({ timeoutMs: 5_000, ttlMs: 5_000 });
            expect(received?.windowMs).toBeGreaterThanOrEqual(
                faultBudgetMs + 5_000 + MINIMUM_POST_EXPIRY_OBSERVATION_MS
            );
        }
    });

    it('expands only the non-expiring send budget', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(conformanceInput(carrier, 15_000));
            const baselineCommands = scenarios
                .find((scenario) => scenario.scenarioId === 'delivery-baseline')
                ?.sender.commands ?? [];
            const baselineReceived = scenarios
                .find((scenario) => scenario.scenarioId === 'delivery-baseline')
                ?.receiver.commands.find((command) => command.kind === 'messages.received');
            const rejectionCommands = scenarios
                .find((scenario) => scenario.scenarioId === 'bounded-rejection')
                ?.sender.commands ?? [];

            expect(baselineCommands.find((command) => command.kind === 'messages.send'))
                .toMatchObject({ timeoutMs: 10_000 });
            expect(baselineCommands.find((command) => command.kind === 'messages.receipts'))
                .toMatchObject({ timeoutMs: 5_000 });
            expect(baselineReceived).toMatchObject({ windowMs: 24_000, timeoutMs: 25_000 });
            expect(rejectionCommands.find((command) => command.kind === 'messages.cancel'))
                .toMatchObject({ timeoutMs: 5_000 });
        }
    });
});
