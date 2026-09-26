import { assert, assertEquals } from '@std/assert';

import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createAlmConformance3AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertRight,
    toControlServiceInput,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

interface ReceiptPin {
    readonly handleId: string;
    readonly confirmed: readonly string[];
    readonly unconfirmed: readonly string[];
}

Deno.test('the generated 3-agent ALM manifest passes when every receipt names the sessions of its pinned roles', () => {
    assertEquals(toThreeAgentOutcome(false), { state: 'passed', ok: true, reason: undefined });
});

Deno.test('the generated 3-agent ALM manifest fails when a receipt confirms the wrong recipient (D45)', () => {
    const outcome = toThreeAgentOutcome(true);
    assertEquals({ state: outcome.state, ok: outcome.ok }, { state: 'failed', ok: false });
    assert(
        outcome.reason?.includes('alm-ws-missing-recipient-retry-send-1: the confirmed recipients do not name the sessions of receiver.'),
        outcome.reason
    );
});

/** Stages, releases and starts the unmodified 3-agent manifest, then answers each role root with receipt evidence. */
function toThreeAgentOutcome(swapRecipients: boolean) {
    const manifest = createAlmConformance3AgentEntry().manifest;
    const runId = manifest.controlRunId;
    const agents = ['controller-01', 'controller-02', 'controller-03'];
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    agents.forEach((agentId) => service.receiveClientEnvelope(toRegisterEnvelope({ runId, agentId, identity: toFleetIdentity(agentId, manifest.group) })));
    assertRight(service.createDistributedRun(manifest));
    assertRight(service.stageDistributedRun(manifest.distributedRunId));
    const acknowledgeDispatched = () =>
        agents.flatMap((agentId) => service.takeDispatchableCommands(runId, agentId))
            .forEach((command) => service.receiveClientEnvelope(toResultEnvelope(command)));
    acknowledgeDispatched();
    acknowledgeDispatched();
    assertRight(service.startDistributedRun(manifest.distributedRunId));
    const sender = manifest.recipes.find((selection) => selection.role === 'sender')!.recipe!;
    const pins = toReceiptPins(sender);
    agents.forEach((agentId) => {
        const [root] = service.takeDispatchableCommands(runId, agentId);
        assert(root?.command.kind === 'recipe.run' && root.command.recipe, `${agentId} must start its role recipe`);
        service.receiveClientEnvelope(toResultEnvelope(root, { recipe: root.command.recipe, pins, swapRecipients }));
    });
    const completed = service.snapshotDistributedRun(manifest.distributedRunId);
    const identityFailure = completed?.rollup.failures.find((failure) => failure.error?.code === 'RALLAR_BB_ALM_IDENTITY_FAILED');
    return { state: completed?.state, ok: completed?.rollup.ok, reason: identityFailure?.error?.message };
}

function toReceiptPins(sender: RallarBlackBoxTestRecipe): readonly ReceiptPin[] {
    const pins = sender.metadata?.almReceiptRoles;
    assert(Array.isArray(pins) && pins.length > 0, 'the combined sender must pin its receipts');
    return pins.filter(isJsonRecordValue).map((pin) => ({
        handleId: String(pin.handleId),
        confirmed: pin.confirmed as readonly string[],
        unconfirmed: pin.unconfirmed as readonly string[]
    }));
}

interface RecipeEvidence {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly pins: readonly ReceiptPin[];
    readonly swapRecipients: boolean;
}

function toResultEnvelope(envelope: ControlCommandEnvelope, evidence?: RecipeEvidence): ControlResultEnvelope {
    const result: RallarBlackBoxTestResult = {
        ...toOkResult(envelope.commandId, envelope.command.kind),
        value: evidence
            ? {
                recipeId: evidence.recipe.recipeId,
                results: evidence.recipe.commands.map((command) => ({
                    ...toOkResult(command.commandId!, command.kind),
                    value: toCommandEvidence(command, evidence)
                }))
            }
            : {}
    };
    return { kind: 'result', protocolVersion: 1, runId: envelope.runId, agentId: envelope.agentId!, commandId: envelope.commandId, ok: true, result };
}

/** Each role connects as `<role>-session`; a receipts read names the sessions of the roles its pin lists. */
function toCommandEvidence(command: RallarBlackBoxTestCommand, evidence: RecipeEvidence): unknown {
    if (command.kind === 'rtc.connect') {
        return { sessionId: `${evidence.recipe.metadata?.role}-session` };
    }
    const pin = command.kind === 'messages.receipts' ? evidence.pins.find((candidate) => candidate.handleId === command.handleId) : undefined;
    if (pin === undefined) {
        return {};
    }
    const confirmed = evidence.swapRecipients ? pin.unconfirmed : pin.confirmed;
    const unconfirmed = evidence.swapRecipients ? pin.confirmed : pin.unconfirmed;
    const sessions = (roles: readonly string[]) => roles.map((role) => `${role}-session`);
    return {
        expectedRecipientPeerIds: sessions([...pin.confirmed, ...pin.unconfirmed]),
        confirmedRecipientPeerIds: sessions(confirmed),
        unconfirmedRecipientPeerIds: sessions(unconfirmed)
    };
}

function toOkResult(commandId: string, kind: RallarBlackBoxTestCommand['kind']): RallarBlackBoxTestResult {
    return { commandId, kind, status: 'ok', ok: true, startedAtEpochMs: 1, endedAtEpochMs: 2, durationMs: 1 };
}
