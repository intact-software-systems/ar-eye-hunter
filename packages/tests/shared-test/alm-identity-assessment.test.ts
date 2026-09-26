import {
    describe,
    expect,
    it
} from 'vitest';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    assessAlmConformanceIdentity,
    type AlmConformanceIdentityInput,
    type AlmConformanceIdentityParticipant
} from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-conformance-identity.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { isSameJsonValue } from '@shared-test/rallar-bb-test/wait/wait-event-match.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import { createAlmConformance2AgentEntry } from '../../../apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';

// These are external evidence transcripts for the pure assessor, not native delivery or persistence proof.
describe('ALM recipe identity assessment', () => {
    it('joins lifecycle sender IDs and exact receiver envelopes', () => {
        expect(assessAlmConformanceIdentity(new IdentityTranscript('lifecycle').input())).toEqual([]);
    });

    it('accepts generated rtc lifecycle evidence with a filled submission receipts result', () => {
        expect(assessAlmConformanceIdentity(new IdentityTranscript('lifecycle', 'rtc').input())).toEqual([]);
    });

    it('rejects the same rtc evidence when the submission receipts confirm no hop', () => {
        const transcript = new IdentityTranscript('lifecycle', 'rtc');
        const sender = transcript.sender;
        const send = sender.command('messages.send');
        const receipts = sender.command('messages.receipts');
        sender.replaceResult({
            ...sender.result(receipts),
            value: { handleId: receipts.handleId, confirmedHopPeerIds: [], unconfirmedHopPeerIds: [] }
        });
        const issues = assessAlmConformanceIdentity(transcript.input());
        expect(issues).not.toEqual([]);
        expect(issues.some((issue) => issue.startsWith(`${send.commandId}:`))).toBe(true);
    });

    it.each(
        [
            ['nobody', []],
            ['another peer', ['sender-session']],
            ['another peer beside the receiver', ['receiver-session', 'sender-session']]
        ] as const
    )('rejects ws submission receipts that confirm %s instead of the receiver', (_label, confirmed) => {
        const transcript = new IdentityTranscript('lifecycle', 'ws');
        const sender = transcript.sender;
        const send = sender.command('messages.send');
        const receipts = sender.command('messages.receipts');
        sender.replaceResult({
            ...sender.result(receipts),
            value: { handleId: receipts.handleId, confirmedRecipientPeerIds: [...confirmed], unconfirmedRecipientPeerIds: [] }
        });
        const issues = assessAlmConformanceIdentity(transcript.input());
        expect(issues.some((issue) => issue.startsWith(`${send.commandId}:`))).toBe(true);
    });

    it('rejects ws submission receipts that still wait for a peer', () => {
        const transcript = new IdentityTranscript('lifecycle', 'ws');
        const sender = transcript.sender;
        const receipts = sender.command('messages.receipts');
        sender.replaceResult({
            ...sender.result(receipts),
            value: {
                handleId: receipts.handleId,
                confirmedRecipientPeerIds: ['receiver-session'],
                unconfirmedRecipientPeerIds: ['late']
            }
        });
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it.each(['wrong-id', 'wrong-transport', 'failed-child', 'missing-child', 'duplicate-child', 'compacted', 'wrong-agent', 'wrong-run'] as const)(
        'rejects lifecycle %s behind a successful outer envelope',
        (defect) => {
            const transcript = new IdentityTranscript('lifecycle');
            const receiver = transcript.receiver;
            const result = receiver.results.find((entry) => entry.kind === 'wait')!;
            if (defect === 'wrong-id') {
                recordAt(result.value, 'event', 'payload', 'data').msgId = 'unrelated';
            }
            if (defect === 'wrong-transport') {
                recordAt(result.value, 'event', 'payload', 'data').transport = 'rtc';
            }
            if (defect === 'failed-child') {
                receiver.replaceResult({ ...result, ok: false, status: 'failed' });
            }
            if (defect === 'missing-child') {
                receiver.results.splice(receiver.results.indexOf(result), 1);
            }
            if (defect === 'duplicate-child') {
                receiver.results.push(result);
            }
            const input = transcript.input();
            const participant = input.participants[1];
            const envelope = participant.result!;
            const modified = {
                ...participant,
                result: {
                    ...envelope,
                    ...(defect === 'wrong-agent' ? { agentId: 'other' } : {}),
                    ...(defect === 'wrong-run' ? { runId: 'other' } : {}),
                    result: defect === 'compacted'
                        ? { ...envelope.result!, value: { recipeId: receiver.recipe.recipeId, resultsOmitted: true } }
                        : envelope.result
                }
            };
            expect(assessAlmConformanceIdentity({ ...input, participants: [input.participants[0], modified] })).not.toEqual([]);
        }
    );

    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)('accepts complete generated %s reload evidence', (carrier) => {
        expect(assessAlmConformanceIdentity(new IdentityTranscript('reload', carrier).input())).toEqual([]);
    });

    it('rejects unchanged sender document in the actual combined recipe even when lifecycle joins pass', () => {
        const transcript = new IdentityTranscript('combined');
        const reconnect = transcript.sender.commands.find((command) => command.kind === 'rtc.connect' && command.rallar?.restoreSession === true)!;
        recordAt(transcript.sender.result(reconnect).value, 'document').timeOrigin = 100;
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it('accepts all three reload checkpoints and existing lifecycle evidence in the actual combined recipe', () => {
        expect(assessAlmConformanceIdentity(new IdentityTranscript('combined').input())).toEqual([]);
    });

    it('accepts canonical zero write baseline, queued retained work, and reset counters in the new document', () => {
        const transcript = new IdentityTranscript('reload');
        const sender = transcript.sender;
        recordAt(sender.result(sender.command('storage.counters')).value).byKind = {};
        recordAt(sender.result(sender.command('messages.observe')).value).state = 'queued';
        const recovered = sender.command('storage.counters', 2);
        sender.replaceResult({ ...sender.result(recovered), value: { total: 0, byOwner: { 'al-admission': 0, 'al-work': 0 }, byKind: {} } });
        expect(assessAlmConformanceIdentity(transcript.input())).toEqual([]);
    });

    it.each(['origin', 'clientId', 'sessionId', 'missing-document', 'zero-time', 'nonfinite-time'] as const)(
        'rejects sender reconnect %s',
        (defect) => {
            const transcript = new IdentityTranscript('reload');
            const reconnect = recordAt(transcript.sender.result(transcript.sender.command('rtc.connect', 1)).value);
            if (defect === 'origin') {
                recordAt(reconnect, 'document').origin = 'https://elsewhere.test';
            }
            if (defect === 'clientId' || defect === 'sessionId') {
                reconnect[defect] = 'different';
            }
            if (defect === 'missing-document') {
                delete reconnect.document;
            }
            if (defect === 'zero-time') {
                recordAt(reconnect, 'document').timeOrigin = 0;
            }
            if (defect === 'nonfinite-time') {
                recordAt(reconnect, 'document').timeOrigin = Number.POSITIVE_INFINITY;
            }
            expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
        }
    );

    it.each(['origin', 'timeOrigin'] as const)('rejects changed receiver %s', (field) => {
        const transcript = new IdentityTranscript('reload');
        recordAt(transcript.receiver.result(transcript.receiver.command('health', 1)).value, 'rallar', 'document')[field] = field === 'origin'
            ? 'https://other.test'
            : 200;
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it.each(['msgId', 'typeId', 'payload', 'transport'] as const)('rejects wrong recovered original %s', (field) => {
        const transcript = new IdentityTranscript('reload');
        recordAt(transcript.receiver.result(transcript.receiver.command('wait', 1)).value, 'event', 'payload', 'data')[field] = 'unrelated';
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it.each(['state', 'enqueued', 'submitted', 'handleId'] as const)('rejects invalid retained %s', (field) => {
        const transcript = new IdentityTranscript('reload');
        recordAt(transcript.sender.result(transcript.sender.command('messages.observe')).value)[field] = field === 'enqueued'
            ? false
            : field === 'submitted'
            ? true
            : field === 'state'
            ? 'pending-authority'
            : 'other';
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it.each(['state', 'handleId', 'authored-handle'] as const)('rejects missing original handle loss via %s', (defect) => {
        const transcript = new IdentityTranscript('reload');
        const observe = transcript.sender.command('messages.observe', 1);
        if (defect === 'authored-handle') {
            transcript.sender.replaceCommand({ ...observe, handleId: 'unrelated' });
        }
        else {
            recordAt(transcript.sender.result(observe).value)[defect] = defect === 'state' ? 'queued' : 'unrelated';
        }
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it.each(
        ['no-write', 'work-write-only', 'same-write', 'decreased-owner', 'missing-owner', 'missing-bucket', 'negative-baseline', 'nonfinite-held'] as const
    )(
        'rejects storage evidence %s despite positive totals',
        (defect) => {
            const transcript = new IdentityTranscript('reload');
            const baseline = recordAt(transcript.sender.result(transcript.sender.command('storage.counters')).value);
            const held = recordAt(transcript.sender.result(transcript.sender.command('storage.counters', 1)).value);
            if (defect === 'no-write') {
                delete recordAt(held, 'byKind').write;
            }
            if (defect === 'work-write-only') {
                held.byKind = { 'work-write': 9 };
            }
            if (defect === 'same-write') {
                recordAt(held, 'byKind').write = 1;
            }
            if (defect === 'decreased-owner') {
                recordAt(held, 'byOwner')['al-work'] = 1;
            }
            if (defect === 'missing-owner') {
                delete recordAt(baseline, 'byOwner')['al-admission'];
            }
            if (defect === 'missing-bucket') {
                delete baseline.byKind;
            }
            if (defect === 'negative-baseline') {
                recordAt(baseline, 'byKind').write = -1;
            }
            if (defect === 'nonfinite-held') {
                recordAt(held, 'byOwner')['al-work'] = Number.NaN;
            }
            expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
        }
    );

    it.each(['missing', 'wrong-type', 'wrong-action', 'finite-lifetime', 'extra-match'] as const)(
        'rejects %s native hold on a possible fallback carrier',
        (defect) => {
            const transcript = new IdentityTranscript('reload', 'rtc-with-ws-fallback');
            const hold = transcript.sender.command('fault.inject', 1);
            if (defect === 'missing') {
                transcript.sender.removeCommand(hold);
            }
            if (defect === 'wrong-type') {
                transcript.sender.replaceCommand({ ...hold, match: { typeId: 'another' } });
            }
            if (defect === 'wrong-action') {
                transcript.sender.replaceCommand({ ...hold, carrier: 'ws', action: 'drop' });
            }
            if (defect === 'finite-lifetime') {
                transcript.sender.replaceCommand({ ...hold, remaining: 1 });
            }
            if (defect === 'extra-match') {
                transcript.sender.replaceCommand({ ...hold, match: { ...hold.match, msgId: 'not-the-original' } });
            }
            expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
        }
    );

    it.each(['send-after-suffix', 'nested-send-after-suffix', 'nested-release-before-reload', 'close-before-reload'] as const)(
        'rejects hidden work %s',
        (defect) => {
            const transcript = new IdentityTranscript('reload');
            const sender = transcript.sender;
            const send = sender.command('messages.send');
            const extra: RallarBlackBoxTestCommand = { ...send, commandId: 'unmarked-original-resend', payload: {} };
            if (defect === 'send-after-suffix') {
                sender.append(extra);
            }
            if (defect === 'nested-send-after-suffix') {
                sender.append({ kind: 'loop', commandId: 'hidden-resend', count: 1, commands: [extra] });
            }
            if (defect === 'nested-release-before-reload' || defect === 'close-before-reload') {
                const assertion = sender.commands.find((command) => command.commandId?.endsWith('assert-storage-write'))!;
                const hold = sender.command('fault.inject');
                sender.replaceCommand(
                    defect === 'close-before-reload'
                        ? { kind: 'close', commandId: assertion.commandId }
                        : { kind: 'parallel', commandId: assertion.commandId, groups: [{ commands: [{ ...hold, remaining: 0 }] }] }
                );
            }
            expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
        }
    );

    it.each(['reload-result', 'absence-result', 'failed-assertion', 'authored-restore', 'storage-reset'] as const)(
        'rejects concealed reload prerequisite defect %s',
        (defect) => {
            const transcript = new IdentityTranscript('reload');
            if (defect === 'reload-result') {
                recordAt(transcript.sender.result(transcript.sender.command('agent.reload')).value).reloading = false;
            }
            if (defect === 'absence-result') {
                recordAt(transcript.receiver.result(transcript.receiver.command('wait')).value).matched = true;
            }
            if (defect === 'failed-assertion') {
                const result = transcript.sender.result(transcript.sender.command('assert'));
                transcript.sender.replaceResult({ ...result, ok: false, status: 'failed' });
            }
            if (defect === 'authored-restore') {
                const reconnect = transcript.sender.command('rtc.connect', 1);
                transcript.sender.replaceCommand({ ...reconnect, rallar: { ...reconnect.rallar, username: 'fresh-login' } });
            }
            if (defect === 'storage-reset') {
                transcript.sender.replaceCommand({ ...transcript.sender.command('storage.counters'), reset: true });
            }
            expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
        }
    );

    it.each(['invalid', -1, Number.NaN])('rejects malformed other baseline kind %s when write is omitted', (invalid) => {
        const transcript = new IdentityTranscript('reload');
        recordAt(transcript.sender.result(transcript.sender.command('storage.counters')).value).byKind = { read: invalid };
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it('rejects malformed unrelated held counts even with a positive write delta', () => {
        const transcript = new IdentityTranscript('reload');
        recordAt(transcript.sender.result(transcript.sender.command('storage.counters', 1)).value, 'byKind').read = Number.POSITIVE_INFINITY;
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it('requires original recovery inside its authored receiver checkpoint', () => {
        const transcript = new IdentityTranscript('reload');
        const receive = transcript.receiver.command('wait', 1);
        const index = transcript.receiver.commands.indexOf(receive);
        transcript.receiver.commands.splice(index, 1);
        transcript.receiver.commands.push(receive);
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it('rejects a receiver subscription reconnect before a later checkpoint', () => {
        const transcript = new IdentityTranscript('combined');
        const sender = transcript.receiver;
        const health = sender.command('health', 2);
        const reconnect = { ...sender.command('rtc.connect'), commandId: 'receiver-reconnect' };
        sender.append(reconnect);
        sender.commands.pop();
        sender.commands.splice(sender.commands.indexOf(health), 0, reconnect);
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it('rejects hidden receiver child failure after the final recovery boundary', () => {
        const transcript = new IdentityTranscript('reload');
        const hidden: RallarBlackBoxTestCommand = {
            kind: 'loop',
            commandId: 'hidden-receiver-work',
            count: 1,
            commands: [{ kind: 'stats', commandId: 'hidden-failure' }]
        };
        transcript.receiver.append(hidden);
        transcript.receiver.replaceResult({
            ...transcript.receiver.result(hidden),
            value: { results: [{ ...transcriptResult('hidden-failure', 'stats', {}), ok: false, status: 'failed' }] }
        });
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it('rejects fallback hold IDs that overwrite the other native carrier hold', () => {
        const transcript = new IdentityTranscript('reload', 'rtc-with-ws-fallback');
        const first = transcript.sender.command('fault.inject');
        const second = transcript.sender.command('fault.inject', 1);
        transcript.sender.replaceCommand({ ...second, faultId: first.faultId });
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it('rejects the sole receiver connect moved beyond initial readiness', () => {
        const transcript = new IdentityTranscript('combined');
        const receiver = transcript.receiver;
        const connect = receiver.command('rtc.connect');
        const laterHealth = receiver.command('health', 2);
        receiver.commands.splice(receiver.commands.indexOf(connect), 1);
        receiver.commands.splice(receiver.commands.indexOf(laterHealth), 0, connect);
        expect(assessAlmConformanceIdentity(transcript.input())).not.toEqual([]);
    });

    it.each(['missing', 'mismatched', 'duplicate'] as const)('rejects %s authored checkpoint contracts', (defect) => {
        const transcript = new IdentityTranscript('reload');
        const input = transcript.input();
        const sender = input.participants[0];
        const metadata = sender.recipe.metadata;
        const checkpoints = metadata?.almReloadCheckpoints;
        if (!Array.isArray(checkpoints)) {
            throw new Error('Missing generated test checkpoints.');
        }
        const changed = defect === 'missing' ? {} : {
            ...metadata,
            almReloadCheckpoints: defect === 'duplicate'
                ? [...checkpoints, ...checkpoints]
                : [{ ...recordAt(checkpoints[0]), receiverRecoveryEnd: 'wrong-boundary' }]
        };
        expect(
            assessAlmConformanceIdentity({ ...input, participants: [{ ...sender, recipe: { ...sender.recipe, metadata: changed } }, input.participants[1]] })
        ).not.toEqual([]);
    });
});

namespace IdentityTranscript {
    export type Kind = 'lifecycle' | 'reload' | 'combined';
    export type Role = 'sender' | 'receiver';
}

class IdentityTranscript {
    readonly sender: ParticipantTranscript;
    readonly receiver: ParticipantTranscript;

    constructor(kind: IdentityTranscript.Kind, carrier: AlmConformanceCarrier = 'ws') {
        const recipes = transcriptRecipes(kind, carrier);
        this.sender = new ParticipantTranscript('sender', recipes.sender, recipes.sender);
        this.receiver = new ParticipantTranscript('receiver', recipes.receiver, recipes.sender);
    }

    input(): AlmConformanceIdentityInput {
        return { runId: 'run', participants: [this.sender.participant(), this.receiver.participant()] };
    }
}

class ParticipantTranscript {
    readonly role: IdentityTranscript.Role;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly commands: RallarBlackBoxTestCommand[];
    readonly results: RallarBlackBoxTestResult[];

    constructor(
        role: IdentityTranscript.Role,
        recipe: RallarBlackBoxTestRecipe,
        sender: RallarBlackBoxTestRecipe
    ) {
        this.role = role;
        this.recipe = recipe;
        this.commands = structuredClone([...recipe.commands]);
        this.results = toTranscriptResults({ role, commands: this.commands, sender });
    }

    command<Kind extends RallarBlackBoxTestCommand['kind']>(kind: Kind, occurrence = 0): Extract<RallarBlackBoxTestCommand, { kind: Kind; }> {
        const command =
            this.commands.filter((candidate): candidate is Extract<RallarBlackBoxTestCommand, { kind: Kind; }> => candidate.kind === kind)[occurrence];
        if (!command) {
            throw new Error(`Missing transcript command: ${kind}.`);
        }
        return command;
    }

    replaceCommand(command: RallarBlackBoxTestCommand): void {
        const index = this.commands.findIndex((candidate) => candidate.commandId === command.commandId);
        this.commands[index] = command;
        this.replaceResult({ ...this.results[index], kind: command.kind });
    }

    removeCommand(command: RallarBlackBoxTestCommand): void {
        const index = this.commands.indexOf(command);
        this.commands.splice(index, 1);
        this.results.splice(index, 1);
    }

    append(command: RallarBlackBoxTestCommand): void {
        this.commands.push(command);
        this.results.push(transcriptResult(command.commandId!, command.kind, {}));
    }

    result(command: RallarBlackBoxTestCommand): RallarBlackBoxTestResult {
        const result = this.results.find((entry) => entry.commandId === command.commandId);
        if (!result) {
            throw new Error('Missing test transcript command.');
        }
        return result;
    }

    replaceResult(result: RallarBlackBoxTestResult): void {
        this.results[this.results.findIndex((entry) => entry.commandId === result.commandId)] = result;
    }

    participant(): AlmConformanceIdentityParticipant {
        const commandId = `${this.role}-root`;
        return {
            role: this.role,
            agentId: this.role,
            commandId,
            recipe: { ...this.recipe, commands: this.commands },
            result: {
                kind: 'result',
                protocolVersion: 1,
                runId: 'run',
                agentId: this.role,
                commandId,
                ok: true,
                result: transcriptResult(commandId, 'recipe.run', { recipeId: this.recipe.recipeId, results: this.results })
            }
        };
    }
}

function transcriptRecipes(kind: IdentityTranscript.Kind, carrier: AlmConformanceCarrier) {
    if (kind === 'combined') {
        const recipes = createAlmConformance2AgentEntry().manifest.recipes;
        const sender = recipes.find((entry) => entry.role === 'sender')?.recipe;
        const receiver = recipes.find((entry) => entry.role === 'receiver')?.recipe;
        if (!sender || !receiver) {
            throw new Error('Generated combined recipes missing.');
        }
        return { sender, receiver };
    }
    const scenario = createAlmConformanceRecipes({
        group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        carrier,
        typeId: 'identity',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000
    }).find((candidate) => candidate.scenarioId === (kind === 'reload' ? 'delivery-reload' : 'delivery-lifecycle'));
    if (!scenario) {
        throw new Error('Generated identity scenario missing.');
    }
    return scenario;
}

interface TranscriptResultsInput {
    readonly role: IdentityTranscript.Role;
    readonly commands: readonly RallarBlackBoxTestCommand[];
    readonly sender: RallarBlackBoxTestRecipe;
}

function toTranscriptResults({ role, commands, sender }: TranscriptResultsInput): RallarBlackBoxTestResult[] {
    let document = 100;
    return commands.map((command) => {
        if (command.kind === 'agent.reload') {
            document += 100;
        }
        return transcriptResult(command.commandId!, command.kind, transcriptValue({ command, role, document, sender }));
    });
}

interface TranscriptValueInput {
    readonly command: RallarBlackBoxTestCommand;
    readonly role: IdentityTranscript.Role;
    readonly document: number;
    readonly sender: RallarBlackBoxTestRecipe;
}

function transcriptValue({ command, role, document, sender }: TranscriptValueInput): ApiJsonObject {
    if (isRallarBlackBoxTestMessagesSendCommand(command)) {
        return { msgId: `original:${command.commandId}`, ...(command.handleId === undefined ? {} : { handleId: command.handleId }), carrier: command.carrier };
    }
    if (command.kind === 'agent.reload') {
        return { reloading: true, ...(command.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: command.readyTimeoutMs }) };
    }
    if (command.kind === 'wait' && command.absent === true) {
        return { absent: true, matched: false };
    }
    if (command.kind === 'rtc.connect') {
        return { document: { origin: 'https://example.test', timeOrigin: document }, clientId: role, sessionId: `${role}-session` };
    }
    if (command.kind === 'health') {
        return { rallar: { document: { origin: 'https://example.test', timeOrigin: document }, session: { clientId: role, sessionId: `${role}-session` } } };
    }
    if (command.kind === 'storage.counters') {
        const held = command.commandId?.endsWith('storage-counters-held');
        return {
            total: held ? 9 : 3,
            byOwner: { 'al-admission': held ? 4 : 1, 'al-work': held ? 5 : 2 },
            byKind: { write: held ? 2 : 1, 'work-read': held ? 4 : 0 }
        };
    }
    if (command.kind === 'messages.observe') {
        return {
            handleId: command.handleId,
            state: command.state.length === 1 && command.state[0] === 'unobservable' ? 'unobservable' : 'accepted',
            enqueued: true,
            submitted: false
        };
    }
    if (command.kind === 'messages.receipts') {
        return {
            handleId: command.handleId,
            confirmedHopPeerIds: ['receiver-session'],
            unconfirmedHopPeerIds: [],
            confirmedRecipientPeerIds: ['receiver-session'],
            unconfirmedRecipientPeerIds: []
        };
    }
    if (command.kind === 'wait' && command.absent !== true) {
        const sent = sender.commands.filter(isRallarBlackBoxTestMessagesSendCommand).find((candidate) =>
            isSameJsonValue(decodeJsonValue(candidate.payload), command.match.equals)
        );
        if (sent?.kind !== 'messages.send') {
            return {};
        }
        const payload = decodeJsonValue(sent.payload);
        if (payload === undefined) {
            throw new Error('Generated transcript message must have a JSON payload.');
        }
        return {
            matched: true,
            event: {
                kind: 'message',
                payload: {
                    data: { msgId: `original:${sent.commandId}`, typeId: sent.typeId, transport: sent.carrier === 'ws' ? 'ws' : 'rtc', payload }
                }
            }
        };
    }
    return {};
}

function transcriptResult<T>(commandId: string, kind: RallarBlackBoxTestCommand['kind'], value: T): RallarBlackBoxTestResult<T> {
    return { commandId, kind, value, ok: true, status: 'ok', startedAtEpochMs: 1, endedAtEpochMs: 2, durationMs: 1 };
}

function recordAt(value: unknown, ...path: readonly string[]): Record<string, unknown> {
    let current = value;
    for (const field of path) {
        if (!isJsonRecordValue(current)) {
            throw new Error('Malformed test transcript record.');
        }
        current = current[field];
    }
    if (!isJsonRecordValue(current)) {
        throw new Error('Malformed test transcript value.');
    }
    return current;
}
