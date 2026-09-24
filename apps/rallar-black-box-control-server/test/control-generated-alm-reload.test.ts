import { assert, assertEquals } from '@std/assert';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestFaultInjectCommand,
    RallarBlackBoxTestMessagesReplayCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createAlmConformance2AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { createRallarBlackBoxControlService, type RallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertRight,
    toControlServiceInput,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

interface PortMessage {
    readonly command: RallarBlackBoxTestMessagesSendCommand;
    readonly msgId: string;
    state: string;
    submitted: boolean;
}

/** Controlled external facts prove recipe/control composition, never native storage or transport behavior. */
class GeneratedAlmPorts {
    now = 1_000;
    senderDocument = 100;
    writes = 1;
    readonly messages: PortMessage[] = [];
    readonly handles = new Map<string, PortMessage>();
    readonly holds = new Map<string, string>();
    readonly receiver: RallarBlackBoxTestRuntime;
    sender: RallarBlackBoxTestRuntime;
    private absence: { duration: number; release: () => void; } | undefined;
    private entered = Promise.withResolvers<void>();
    private holdNextSleep = false;
    /** A send one past the receiver's snapshot, admitted once the sender advances the group version. */
    private awaitingAdvance: PortMessage | undefined;
    private readonly replacesDocument: boolean;

    constructor(replacesDocument: boolean) {
        this.replacesDocument = replacesDocument;
        this.receiver = this.createRuntime('receiver');
        this.sender = this.createRuntime('sender');
    }

    beginAbsence(): Promise<void> {
        this.entered = Promise.withResolvers<void>();
        this.holdNextSleep = true;
        return this.entered.promise;
    }

    finishAbsence(): void {
        assert(this.absence);
        assertEquals(this.absence.duration, 17_000, 'the authored absence window is unchanged');
        this.now += this.absence.duration;
        this.absence.release();
        this.absence = undefined;
    }

    replaceSenderDocument(): void {
        if (this.replacesDocument) {
            this.senderDocument += 100;
        }
        this.handles.clear();
        this.holds.clear();
        this.writes = 1;
        this.sender = this.createRuntime('sender');
    }

    private createRuntime(role: 'sender' | 'receiver'): RallarBlackBoxTestRuntime {
        return createRallarBlackBoxTestRuntime({
            now: () => this.now,
            sleep: async (duration) => {
                if (!this.holdNextSleep) {
                    this.now += duration;
                    return;
                }
                this.holdNextSleep = false;
                const pending = Promise.withResolvers<void>();
                this.absence = { duration, release: pending.resolve };
                this.entered.resolve();
                await pending.promise;
            },
            commandExecutor: (command) => this.executePort(role, command)
        });
    }

    private executePort(role: 'sender' | 'receiver', command: RallarBlackBoxTestCommand): RallarBlackBoxTestCommandOutcome | undefined {
        const document = { origin: 'https://fixture.test', timeOrigin: role === 'sender' ? this.senderDocument : 50 };
        const session = { clientId: role, sessionId: `${role}-stored-session` };
        switch (command.kind) {
            case 'http.request':
                if (this.awaitingAdvance && command.commandId?.endsWith('-advance-group')) {
                    this.deliver(this.awaitingAdvance);
                    this.awaitingAdvance = undefined;
                }
                return { status: 'ok', value: { status: 200 } };
            case 'rtc.connect':
                this.deliverRecoveredOriginals(role);
                return { status: 'ok', value: { document, ...session } };
            case 'health':
                return { status: 'ok', value: { rallar: { document, session } } };
            case 'storage.counters':
                return {
                    status: 'ok',
                    value: {
                        total: this.writes * 2,
                        byOwner: { 'al-admission': this.writes, 'al-work': this.writes },
                        byKind: { write: this.writes, 'work-read': 1 }
                    }
                };
            case 'fault.inject':
                return this.injectFault(command);
            case 'messages.send':
                return 'replayOnCarrier' in command ? this.replay(command) : this.send(command);
            case 'messages.observe': {
                const message = this.handles.get(command.handleId);
                if (message && command.state.length === 1 && command.state[0] === 'expired') {
                    message.state = 'expired';
                }
                return {
                    status: 'ok',
                    value: { handleId: command.handleId, state: message?.state ?? 'unobservable', enqueued: true, submitted: message?.submitted ?? false }
                };
            }
            case 'messages.cancel': {
                const message = this.handles.get(command.handleId);
                assert(message);
                if (!message.submitted && message.state !== 'rejected') {
                    message.state = 'cancelled';
                }
                return { status: 'ok', value: { handleId: command.handleId, state: message.state, submitted: message.submitted } };
            }
            case 'messages.receipts': {
                const message = this.handles.get(command.handleId);
                assert(message);
                return { status: 'ok', value: { confirmedHopPeerIds: message.command.carrier === 'ws' ? [] : ['receiver'], unconfirmedHopPeerIds: [] } };
            }
            case 'messages.received': {
                const count = this.messages.filter((message) => message.command.typeId === command.typeId && message.submitted).length;
                const passed = command.absent ? count < command.count : count >= command.count;
                return { status: passed ? 'ok' : 'failed', value: { count } };
            }
            case 'assert':
            case 'wait':
                return undefined; // These acceptance commands execute in the real runtime.
            default:
                throw new Error(`Unexpected external fixture port: ${command.kind}`);
        }
    }

    private deliverRecoveredOriginals(role: 'sender' | 'receiver'): void {
        if (role !== 'sender') {
            return;
        }
        for (const message of this.messages) {
            if (isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'delivery-reload' && !message.submitted) {
                this.deliver(message);
            }
        }
    }

    private injectFault(command: RallarBlackBoxTestFaultInjectCommand): RallarBlackBoxTestCommandOutcome {
        if (command.remaining === 0) {
            this.holds.delete(command.faultId);
        }
        else {
            this.holds.set(command.faultId, String(command.match?.typeId));
        }
        for (const message of this.messages) {
            if (message.state === 'accepted' && !this.isHeld(message.command.typeId)) {
                this.deliver(message);
            }
        }
        return { status: 'ok', value: { faultId: command.faultId } };
    }

    private send(command: RallarBlackBoxTestMessagesSendCommand): RallarBlackBoxTestCommandOutcome {
        assert(isJsonRecordValue(command.payload));
        const rejected = command.payload.marker === 'bounded-rejection';
        const message: PortMessage = {
            command,
            msgId: `port-message-${this.messages.length + 1}`,
            state: rejected ? 'rejected' : command.payload.seq === 300 ? 'queued' : 'accepted',
            submitted: false
        };
        this.messages.push(message);
        assert(command.handleId);
        this.handles.set(command.handleId, message);
        this.writes += 1;
        if (command.payload.revision === 'replacement') {
            for (const prior of this.messages) {
                if (prior.command.typeId === command.typeId && isJsonRecordValue(prior.command.payload) && prior.command.payload.revision === 'old') {
                    prior.state = 'superseded';
                }
            }
        }
        const floor = command.minSnapshotVersion;
        if (floor !== undefined) {
            this.refuseNotYetInSync(message);
            this.awaitingAdvance = 'aboveCurrentBy' in floor ? message : undefined;
        }
        else if (!rejected && !this.isHeld(command.typeId) && command.payload.seq !== 300) {
            this.deliver(message);
        }
        return {
            status: 'ok',
            value: {
                msgId: message.msgId,
                handleId: command.handleId,
                carrier: command.carrier,
                status: rejected ? 'rejected' : 'accepted',
                reason: rejected ? 'Payload exceeds fixture carrier limit' : undefined
            }
        };
    }

    /** The receiver's snapshot is below the send's floor: it refuses the copy over RTC and writes nothing. */
    private refuseNotYetInSync(message: PortMessage): void {
        this.receiver.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: {
                    kind: 'admission-outcome',
                    workerId: 'receiver-inbound',
                    msgId: message.msgId,
                    typeId: message.command.typeId,
                    carrier: 'rtc',
                    outcome: 'rejected',
                    reason: 'not-yet-in-sync: Awaiting the required room snapshot version'
                }
            }
        });
    }

    /** The receiver's one inbound identity refuses the replayed copy as a duplicate, so nothing more is delivered. */
    private replay({ replayOnCarrier: replay }: RallarBlackBoxTestMessagesReplayCommand): RallarBlackBoxTestCommandOutcome {
        const original = this.handles.get(replay.handleId);
        assert(original);
        this.receiver.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.alm.inbound_diagnostics',
            payload: {
                data: {
                    kind: 'admission-outcome',
                    workerId: 'receiver-inbound',
                    msgId: original.msgId,
                    typeId: original.command.typeId,
                    carrier: replay.carrier,
                    outcome: 'not-handled',
                    reason: 'duplicate'
                }
            }
        });
        return {
            status: 'ok',
            value: { handleId: replay.handleId, msgId: original.msgId, carrier: replay.carrier, verdict: 'admitted' }
        };
    }

    private isHeld(typeId: string): boolean {
        return [...this.holds.values()].includes(typeId);
    }

    private deliver(message: PortMessage): void {
        message.submitted = true;
        message.state = message.command.carrier === 'ws' ? 'transport-accepted' : 'acknowledged';
        this.receiver.recordEvent({
            kind: 'message',
            connection: 'almConformanceReceiver',
            topic: 'typed',
            payload: {
                data: {
                    msgId: message.msgId,
                    typeId: message.command.typeId,
                    transport: message.command.carrier === 'ws' ? 'ws' : 'rtc',
                    payload: message.command.payload
                }
            }
        });
    }
}

for (const replacesDocument of [true, false]) {
    Deno.test(`unmodified combined ALM runs every checkpoint and trailing scenario through restored runtime evidence (fresh document=${replacesDocument})`, async () => {
        const manifest = createAlmConformance2AgentEntry().manifest;
        const ports = new GeneratedAlmPorts(replacesDocument);
        const input = toControlServiceInput({ now: () => ports.now, runtimeRetentionBounds: { commands: 1, results: 1 } });
        let service = createRallarBlackBoxControlService(input);
        const runId = manifest.controlRunId;
        const agents = ['controller-01', 'controller-02'];
        const register = (): void => {
            for (const agentId of agents) {
                service.receiveClientEnvelope(toRegisterEnvelope({ runId, agentId, identity: toFleetIdentity(agentId, manifest.group) }));
            }
        };
        register();
        assertRight(service.createDistributedRun(manifest));
        assertRight(service.stageDistributedRun(manifest.distributedRunId));
        for (const _phase of ['stage', 'barrier']) {
            for (const [index, agentId] of agents.entries()) {
                for (const command of service.takeDispatchableCommands(runId, agentId)) {
                    await executeSegment(service, index === 0 ? ports.sender : ports.receiver, command);
                }
            }
        }
        const started = assertRight(service.startDistributedRun(manifest.distributedRunId));
        const senderRoot = started.commandLinks.find((link) => link.phase === 'start' && link.role === 'sender')!.commandId;
        const root = service.snapshotRun(runId)!.commands.find((command) => command.envelope.commandId === senderRoot)!.envelope;
        const pair = toAlmReloadPair(root.command)!;
        assertEquals(pair.checkpoints.length, 3);
        for (const checkpoint of pair.checkpoints) {
            const [prefix] = service.takeDispatchableCommands(runId, agents[0]);
            const [ready] = service.takeDispatchableCommands(runId, agents[1]);
            await executeSegment(service, ports.receiver, ready);
            await executeSegment(service, ports.sender, prefix);
            const entered = ports.beginAbsence();
            const [absence] = service.takeDispatchableCommands(runId, agents[1]);
            const pending = executeSegment(service, ports.receiver, absence);
            await entered;
            try {
                assertEquals(service.takeDispatchableCommands(runId, agents[0]), [], 'an unfinished real absence wait cannot authorize page replacement');
            }
            finally {
                ports.finishAbsence();
                await pending;
            }
            const snapshot = service.snapshotForPersistence({ commands: 1, results: 1 });
            assert(snapshot.runs[0].results.some((result) => result.commandId === prefix.commandId), 'pending actual prefix evidence survives low bounds');
            const [reload] = service.takeDispatchableCommands(runId, agents[0]);
            assertEquals(reload.command.kind, 'agent.reload');
            assert(reload.command.kind === 'agent.reload');
            const result = toAgentReloadResult({
                commandId: reload.commandId,
                readyTimeoutMs: reload.command.readyTimeoutMs!,
                written: 'written',
                atEpochMs: ports.now
            });
            recordResult(service, reload, result);
            service.markAgentDisconnected(runId, agents[0]);
            ports.replaceSenderDocument();
            service.receiveClientEnvelope(
                toRegisterEnvelope({ runId, agentId: agents[0], completedCommandIds: [reload.commandId], identity: toFleetIdentity(agents[0], manifest.group) })
            );
            const [suffix] = service.takeDispatchableCommands(runId, agents[0]);
            assert(suffix.command.kind === 'recipe.run');
            assertEquals(suffix.command.recipe?.commands.at(-1)?.commandId, checkpoint.senderSuffixEnd);
            await executeSegment(service, ports.sender, suffix);
            const [recovery] = service.takeDispatchableCommands(runId, agents[1]);
            await executeSegment(service, ports.receiver, recovery);
        }
        // The receiver's original generation is fenced until all recovery checkpoints have completed.
        const pending = service.snapshotForPersistence({ commands: 1, results: 1 });
        service = createRallarBlackBoxControlService(input);
        service.restoreSnapshot(pending);
        register();
        const [senderTrailing] = service.takeDispatchableCommands(runId, agents[0]);
        await executeSegment(service, ports.sender, senderTrailing);
        const senderCompleted = service.snapshotForPersistence({ commands: 1, results: 1 });
        assert(senderCompleted.runs[0].results.some((result) => result.commandId === senderRoot), 'real sender root survives until receiver assessment');
        const senderValue = senderCompleted.runs[0].results.find((entry) => entry.commandId === senderRoot)?.result?.value;
        assert(isJsonRecordValue(senderValue) && Array.isArray(senderValue.results));
        assertEquals(
            senderValue.results.map((entry) => isJsonRecordValue(entry) ? entry.commandId : undefined),
            manifest.recipes.find((entry) => entry.role === 'sender')!.recipe!.commands.map((command) => command.commandId),
            'logical aggregation preserves every actual authored child identity'
        );
        service = createRallarBlackBoxControlService(input);
        service.restoreSnapshot(senderCompleted);
        register();
        const [receiverTrailing] = service.takeDispatchableCommands(runId, agents[1]);
        await executeSegment(service, ports.receiver, receiverTrailing);
        const completed = service.snapshotDistributedRun(manifest.distributedRunId);
        assertEquals(completed?.state, replacesDocument ? 'passed' : 'failed', JSON.stringify(completed?.rollup));
        if (!replacesDocument) {
            assert(
                completed?.rollup.failures.some((failure) => failure.error?.code === 'RALLAR_BB_ALM_IDENTITY_FAILED'),
                'the actual hosted rollup must reject unchanged document facts despite successful command results'
            );
        }
        assertEquals(
            ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'delivery-reload').length,
            3,
            'restored suffixes and roots never resend an original'
        );
        assertEquals(
            service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.length,
            1,
            'terminal evidence returns to the configured finite bounds'
        );
    });
}

async function executeSegment(service: RallarBlackBoxControlService, runtime: RallarBlackBoxTestRuntime, envelope: ControlCommandEnvelope): Promise<void> {
    assert(envelope, 'expected an actual control dispatch');
    const result = await runtime.execute({ ...envelope.command, deadlineEpochMs: envelope.deadlineEpochMs });
    assertEquals(result.ok, true, JSON.stringify(result));
    recordResult(service, envelope, result);
}

function recordResult(service: RallarBlackBoxControlService, envelope: ControlCommandEnvelope, result: RallarBlackBoxTestResult): void {
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: envelope.runId,
            agentId: envelope.agentId!,
            commandId: envelope.commandId,
            ok: result.ok,
            result
        }).accepted,
        true
    );
}
