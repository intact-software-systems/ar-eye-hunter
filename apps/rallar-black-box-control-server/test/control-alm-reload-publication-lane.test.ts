import { assert, assertEquals } from '@std/assert';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { AlmReloadPorts, type AlmReloadParticipant, type PortMessage } from './support/alm-reload-ports.ts';

type PublicationStagingEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, Readonly<{ kind: 'publication-staging'; }>>;
type PublicationOpportunityEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, Readonly<{ kind: 'publication-opportunity'; }>>;

const PARTICIPANTS: readonly AlmReloadParticipant[] = [
    { role: 'sender', sessionId: 'sender-stored-session', principalId: 'sender-principal' },
    { role: 'receiver', sessionId: 'receiver-stored-session', principalId: 'receiver-principal' }
];

/** The paced cells' cadence: the lead's opportunity runs at once, every later one a cadence after the last. */
const CADENCE_MS = 2_000;

for (const carrier of ALM_CONFORMANCE_CARRIERS) {
    Deno.test(`the ${carrier} paced-latest cell admits its lead at once and the newest value at the lane's next opportunity`, async () => {
        const { ports, sent } = await runPacedCell(carrier, 'paced-latest');

        assertEquals(sent.map((message) => message.state), [
            'transport-accepted',
            'superseded',
            'superseded',
            'superseded',
            'superseded',
            'transport-accepted'
        ]);
        const opportunities = readOpportunities(ports);
        assertEquals(opportunities.map(({ selected }) => selected), [1, 1]);
        assertEquals(opportunities[0].atMs, readStagingEvents(ports, sent[0])[0]?.atMs, 'the idle lane admits the lead when it stages');
        assertEquals(opportunities[1].atMs - opportunities[0].atMs, CADENCE_MS, 'the second value waits one cadence');
    });

    Deno.test(`the ${carrier} paced-newest-n cell supersedes the oldest of three staged values and drains two per opportunity`, async () => {
        const { ports, sent } = await runPacedCell(carrier, 'paced-newest-n');

        assertEquals(sent.map((message) => message.state), [
            'transport-accepted',
            'superseded',
            'transport-accepted',
            'transport-accepted',
            'transport-accepted'
        ]);
        assert(sent[1].reason?.includes('displaced it before its opportunity'), sent[1].reason);
        assertEquals(sent[1].attemptCarriers, []);
        assertEquals(readOpportunities(ports).map(({ selected, deferred }) => [selected, deferred]), [[1, 0], [2, 1], [1, 0]]);
        assertEquals(readStagingOutcomes(ports, sent[1]), ['staged', 'superseded']);
    });

    Deno.test(`the ${carrier} paced-expiry cell expires its short-lived value while staged, before any attempt`, async () => {
        const { ports, sent } = await runPacedCell(carrier, 'paced-expiry');

        assertEquals(sent.map((message) => [message.state, message.failure, message.submitted]), [
            ['transport-accepted', undefined, true],
            ['expired', { kind: 'expired' }, false]
        ]);
        // The observer read the deadline; the stage settles the value at the lane's next opportunity, a cadence on.
        assertEquals(readStagingOutcomes(ports, sent[1]), ['staged']);
        const idled = await ports.sender.execute(toIdleCommand(CADENCE_MS));
        assertEquals(idled.ok, true, JSON.stringify(idled));
        assertEquals(readStagingOutcomes(ports, sent[1]), ['staged', 'expired']);
        assertEquals(readOpportunities(ports).map(({ selected, expired }) => [selected, expired]), [[1, 0], [0, 1]]);
    });

    Deno.test(`the ${carrier} paced-capacity cell refuses the value past its lowered staged-values bound`, async () => {
        const { ports, sent } = await runPacedCell(carrier, 'paced-capacity');

        assertEquals(sent.map((message) => message.state), [
            'transport-accepted',
            'transport-accepted',
            'transport-accepted',
            'rejected'
        ]);
        assertEquals(sent[3].failure, { kind: 'refused', reason: 'capacity', limit: 'staged-values' });
        assertEquals(sent[3].attemptCarriers, []);
        assertEquals(
            readStagingEvents(ports, sent[3]).map(({ outcome, limit }) => [outcome, limit]),
            [['refused', 'staged-values']]
        );
    });

    Deno.test(`the ${carrier} paced-cancel cell cancels a staged value, which its opportunity never carries`, async () => {
        const { ports, sent } = await runPacedCell(carrier, 'paced-cancel');

        assertEquals(sent.map((message) => [message.state, message.submitted]), [
            ['transport-accepted', true],
            ['cancelled', false],
            ['transport-accepted', true]
        ]);
        assertEquals(readStagingOutcomes(ports, sent[1]), ['staged', 'cancelled']);
        assertEquals(readOpportunities(ports).map(({ selected }) => selected), [1, 1]);
    });
}

/** The ways the sender page's connect ends, each of which stops its stage. */
const DISPOSALS: readonly (readonly [name: string, dispose: (ports: AlmReloadPorts) => Promise<void>])[] = [
    ['a new connect', async (ports) => assertOk(await ports.sender.execute(findPacedCapacityConnect()))],
    ['a close', async (ports) => assertOk(await ports.sender.execute({ kind: 'close', commandId: 'disposal-close' }))],
    ['a document replacement', (ports) => Promise.resolve(ports.replaceSenderDocument())]
];

for (const [name, dispose] of DISPOSALS) {
    Deno.test(`${name} settles the value its stage still holds skipped as disposed, with no staging event and no carrier`, async () => {
        const ports = new AlmReloadPorts(true, PARTICIPANTS);
        assertOk(await ports.sender.execute(toLiveSend(0)));
        assertOk(await ports.sender.execute(toLiveSend(1)));
        const [lead, held] = ports.messages;
        assertEquals([lead.state, held.state], ['transport-accepted', 'staged']);
        const heldOutcomes = readStagingOutcomes(ports, held);

        await dispose(ports);
        assertOk(await ports.sender.execute(toIdleCommand(CADENCE_MS)));

        assertEquals([held.state, held.failure, held.submitted], ['failed', { kind: 'skipped', reason: 'disposed' }, false]);
        assertEquals(heldOutcomes, ['staged']);
        assertEquals(readStagingOutcomes(ports, held), name === 'a document replacement' ? [] : ['staged']);
    });
}

Deno.test('a live send from a sender that left the group is refused by the trusted server instead of staged', async () => {
    const ports = new AlmReloadPorts(true, PARTICIPANTS);
    ports.group.left.add('sender');

    assertOk(await ports.sender.execute(toLiveSend(0)));

    const [fenced] = ports.messages;
    assertEquals([fenced.state, fenced.submitted, fenced.relayRejection], ['rejected', false, { relay: 'trusted-server', reason: 'membership-fenced' }]);
    assertEquals(readStagingOutcomes(ports, fenced), []);
});

/** A ws live send on one stream, one value retained, whose lane opens one opportunity per cadence. */
function toLiveSend(seq: number): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.send',
        commandId: `disposal-send-${seq}`,
        handleId: `disposal-send-${seq}`,
        carrier: 'ws',
        typeId: 'fixture.paced-disposal',
        topicId: 'room.fixture',
        payload: { specimen: 'disposal', seq },
        resourceId: 'fixture-disposal',
        purpose: 'live',
        publication: { cadenceMs: CADENCE_MS, retainNewest: 1, drain: { messages: 8, bytes: 64 * 1024 } }
    };
}

function findPacedCapacityConnect(): RallarBlackBoxTestCommand {
    const scenario = createAlmConformanceRecipes(toCatalogInput('ws')).find((candidate) => candidate.scenarioId === 'paced-capacity');
    const connect = scenario?.sender.commands.find((command) => command.kind === 'rtc.connect');
    assert(connect);
    return connect;
}

function assertOk(result: RallarBlackBoxTestResult): void {
    assertEquals(result.ok, true, JSON.stringify(result));
}

function toCatalogInput(carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number]): CreateAlmConformanceRecipesInput {
    return {
        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
        carrier,
        typeId: 'alm.conformance',
        senderConnection: 'almConformanceSender',
        receiverConnection: 'almConformanceReceiver',
        deadlineMs: 18_000,
        laneFamilies: ['two-agent'],
        principalIdsByRole: {}
    };
}

/** Runs the cell's sender recipe to its end, then its receiver's, as the reload test orders a trailing segment. */
async function runPacedCell(
    carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number],
    scenarioId: string
): Promise<{ ports: AlmReloadPorts; sent: readonly PortMessage[]; }> {
    const scenario = createAlmConformanceRecipes(toCatalogInput(carrier)).find((candidate) => candidate.scenarioId === scenarioId);
    assert(scenario, `${scenarioId} over ${carrier}`);
    const ports = new AlmReloadPorts(true, PARTICIPANTS);

    const sender = await ports.sender.execute(toRecipeRun(scenario.sender));
    const receiver = await ports.receiver.execute(toRecipeRun(scenario.receiver));

    assertEquals(sender.ok, true, JSON.stringify(sender));
    assertEquals(receiver.ok, true, JSON.stringify(receiver));
    const sent = ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.specimen === 'paced');
    return { ports, sent: [...sent].sort((left, right) => readSeq(left) - readSeq(right)) };
}

function readSeq(message: PortMessage): number {
    assert(isJsonRecordValue(message.command.payload));
    return Number(message.command.payload.seq);
}

function readOutboundDiagnostics(ports: AlmReloadPorts): readonly ALOutboundRuntimeDiagnosticsEvent[] {
    return ports.sender.state().events.flatMap((event) => {
        if (event.topic !== 'rallar.browser.alm.outbound_diagnostics' || !isJsonRecordValue(event.payload)) {
            return [];
        }
        return [event.payload.data as ALOutboundRuntimeDiagnosticsEvent];
    });
}

function readOpportunities(ports: AlmReloadPorts): readonly PublicationOpportunityEvent[] {
    return readOutboundDiagnostics(ports).filter((event): event is PublicationOpportunityEvent => event.kind === 'publication-opportunity');
}

function readStagingEvents(ports: AlmReloadPorts, message: PortMessage): readonly PublicationStagingEvent[] {
    return readOutboundDiagnostics(ports).filter((event): event is PublicationStagingEvent =>
        event.kind === 'publication-staging' && event.msgId === message.msgId
    );
}

function readStagingOutcomes(ports: AlmReloadPorts, message: PortMessage): readonly string[] {
    return readStagingEvents(ports, message).map(({ outcome }) => outcome);
}

/** The page idles for `durationMs` on the fixture's clock, which runs every lane opportunity due on the way. */
function toIdleCommand(durationMs: number): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: 'publication-lane-idle',
        match: { kind: 'diagnostic', topic: 'publication-lane.idle' },
        absent: true,
        timeoutMs: durationMs
    };
}

function toRecipeRun(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestCommand {
    return { kind: 'recipe.run', commandId: `${recipe.recipeId}-run`, recipe };
}
