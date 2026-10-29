import type { BlackBoxRallarDocumentFacts } from '../../../../black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { isRallarBlackBoxTestMessagesSendCommand } from '../../../alm/is-rallar-black-box-test-messages-send-command.ts';
import type {
    RallarBlackBoxTestAgentReloadCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestTransportFaultInjectCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from '../../../runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import { isSameJsonValue } from '../../../wait/wait-event-match.ts';
import { toAlmReloadCheckpoints, type AlmReloadCheckpoint } from '../alm-reload-pair.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';
import { assessAlmReloadStorage } from './assess-alm-reload-storage.ts';
import { toAlmJsonPathValue, toRecordedAlmResultValue } from './to-recorded-alm-result-value.ts';

const ALM_STORAGE_TOPIC = 'rallar.browser.alm.storage';

interface ReloadEvidence {
    readonly sender: RecordedAlmConformanceParticipant;
    readonly receiver: RecordedAlmConformanceParticipant;
    readonly checkpoint: AlmReloadCheckpoint;
    readonly prefix: readonly RallarBlackBoxTestCommand[];
    readonly suffix: readonly RallarBlackBoxTestCommand[];
    readonly receiverBefore: readonly RallarBlackBoxTestCommand[];
    readonly recovery: readonly RallarBlackBoxTestCommand[];
    readonly reload: RallarBlackBoxTestAgentReloadCommand;
    readonly absence: RallarBlackBoxTestWaitCommand;
    readonly send: RallarBlackBoxTestMessagesSendCommand;
    readonly senderNextIndex: number;
    readonly receiverNextIndex: number;
}

/** The coordinator owns causal dispatch; these joins require its complete, exact authored-child transcript. */
export function assessAlmReloadIdentity(
    sender: RecordedAlmConformanceParticipant,
    receiver: RecordedAlmConformanceParticipant,
    reloadSends: readonly RallarBlackBoxTestMessagesSendCommand[]
): readonly string[] {
    const senderRecipe = sender.participant.recipe;
    const receiverRecipe = receiver.participant.recipe;
    const checkpoints = toAlmReloadCheckpoints(senderRecipe.metadata?.almReloadCheckpoints);
    const other = toAlmReloadCheckpoints(receiverRecipe.metadata?.almReloadCheckpoints);
    if (!checkpoints && !other && reloadSends.length === 0) {
        return [];
    }
    if (
        !checkpoints || !other || JSON.stringify(checkpoints) !== JSON.stringify(other) ||
        new Set(checkpoints.map((checkpoint) => checkpoint.key)).size !== checkpoints.length ||
        reloadSends.length !== checkpoints.length ||
        senderRecipe.commands.filter((command) => command.kind === 'agent.reload').length !== checkpoints.length ||
        receiverRecipe.commands.some((command) =>
            ['recipe.run', 'recipe.load', 'loop', 'parallel', 'close', 'reset'].includes(command.kind)
        ) ||
        receiverRecipe.commands.filter((command) => command.kind === 'rtc.connect').length > 1 ||
        receiverRecipe.commands.some((command, index) =>
            command.kind === 'rtc.connect' &&
            index >= receiverRecipe.commands.findIndex((candidate) =>
                    candidate.commandId === checkpoints[0].receiverReadyEnd
                )
        )
    ) {
        return ['ALM reload requires matching, complete authored checkpoints and original sends.'];
    }
    const issues: string[] = [];
    let senderStart = 0;
    let receiverStart = 0;
    for (const checkpoint of checkpoints) {
        const evidence = readReloadEvidence({ sender, receiver, reloadSends, checkpoint, senderStart, receiverStart });
        if (!evidence) {
            issues.push(`${checkpoint.key}: malformed reload phase boundaries or original send.`);
            continue;
        }
        issues.push(...assessReloadCommands(evidence));
        issues.push(...assessReloadTrace(evidence));
        issues.push(...assessReloadDocuments(evidence));
        issues.push(...assessReloadRetention(evidence));
        issues.push(...assessAlmReloadStorage(evidence));
        senderStart = evidence.senderNextIndex;
        receiverStart = evidence.receiverNextIndex;
    }
    return issues;
}

interface ReadReloadEvidenceInput {
    readonly reloadSends: readonly RallarBlackBoxTestMessagesSendCommand[];
    readonly sender: RecordedAlmConformanceParticipant;
    readonly receiver: RecordedAlmConformanceParticipant;
    readonly checkpoint: AlmReloadCheckpoint;
    readonly senderStart: number;
    readonly receiverStart: number;
}

function readReloadEvidence(read: ReadReloadEvidenceInput): ReloadEvidence | undefined {
    const { sender, receiver, checkpoint, senderStart, receiverStart } = read;
    const senderCommands = sender.participant.recipe.commands;
    const receiverCommands = receiver.participant.recipe.commands;
    const prefixEnd = senderCommands.findIndex((command) => command.commandId === checkpoint.senderPrefixEnd);
    const reloadIndex = senderCommands.findIndex((command) => command.commandId === checkpoint.senderReload);
    const suffixEnd = senderCommands.findIndex((command) => command.commandId === checkpoint.senderSuffixEnd);
    const readyEnd = receiverCommands.findIndex((command) => command.commandId === checkpoint.receiverReadyEnd);
    const absenceEnd = receiverCommands.findIndex((command) => command.commandId === checkpoint.receiverAbsenceEnd);
    const recoveryEnd = receiverCommands.findIndex((command) => command.commandId === checkpoint.receiverRecoveryEnd);
    const reload = senderCommands[reloadIndex];
    const absence = receiverCommands[absenceEnd];
    if (
        prefixEnd < senderStart || reloadIndex !== prefixEnd + 1 || suffixEnd <= reloadIndex ||
        readyEnd < receiverStart || absenceEnd !== readyEnd + 1 || recoveryEnd <= absenceEnd ||
        reload?.kind !== 'agent.reload' || absence?.kind !== 'wait' || absence.absent !== true ||
        receiverCommands[readyEnd]?.kind !== 'health' || receiverCommands[recoveryEnd]?.kind !== 'health'
    ) {
        return undefined;
    }
    const prefix = senderCommands.slice(senderStart, prefixEnd + 1);
    const sends = prefix.filter(isRallarBlackBoxTestMessagesSendCommand);
    const send = sends[0];
    if (
        sends.length !== 1 || !send || !read.reloadSends.includes(send) ||
        !nonemptyString(send.handleId)
    ) {
        return undefined;
    }
    return {
        sender,
        receiver,
        checkpoint,
        prefix,
        send,
        reload,
        absence,
        senderNextIndex: suffixEnd + 1,
        receiverNextIndex: recoveryEnd + 1,
        suffix: senderCommands.slice(reloadIndex + 1, suffixEnd + 1),
        receiverBefore: receiverCommands.slice(receiverStart, readyEnd + 1),
        recovery: receiverCommands.slice(absenceEnd + 1, recoveryEnd + 1)
    };
}

function assessReloadCommands(evidence: ReloadEvidence): readonly string[] {
    const { send, prefix, suffix, sender, receiverBefore, recovery, absence, checkpoint } = evidence;
    // A paced cell's loop repeats one send template, so its children count beside the root's own commands.
    const allCommands = sender.participant.recipe.commands.flatMap((command) =>
        command.kind === 'loop' ? command.commands : [command]
    );
    const linearRoot = allCommands.every((command) =>
        !['recipe.run', 'recipe.load', 'loop', 'parallel'].includes(command.kind)
    );
    const originals = allCommands.filter((command) =>
        isRallarBlackBoxTestMessagesSendCommand(command) &&
        (command.typeId === send.typeId ||
            isSameJsonValue(decodeJsonValue(command.payload), decodeJsonValue(send.payload)))
    );
    const sendIndex = prefix.indexOf(send);
    // The combined Hetzner recipe opens every scenario, this checkpoint's too, at its two barriers (D62).
    const linearKinds = [
        'http.request',
        'rtc.connect',
        'health',
        'stats',
        'storage.counters',
        'fault.inject',
        'messages.send',
        'messages.observe',
        'assert',
        'barrier'
    ];
    const validPrefix = prefix.every((command) => linearKinds.includes(command.kind)) &&
        !prefix.slice(sendIndex + 1).some((command) => command.kind === 'rtc.connect');
    const validSuffix = suffix[0]?.kind === 'rtc.connect' && suffix[0].rallar?.restoreSession === true &&
        suffix[0].rallar.username === '' && suffix[0].rallar.password === '' &&
        suffix[0].connection === send.connection &&
        suffix.at(-1)?.kind === 'storage.counters' &&
        suffix.slice(1).every(isReloadSuffixCommand);
    const receiverPreserved =
        [...receiverBefore, ...recovery].every((command) =>
            ['http.request', 'rtc.connect', 'health', 'stats', 'wait', 'barrier'].includes(command.kind)
        ) && recovery.every((command) => command.kind !== 'rtc.connect');
    const absenceValue = toRecordedAlmResultValue(evidence.receiver, absence);
    const receives = resolveRecoveredReceives(evidence);
    const correctAbsence = receives.length === 1 && absence.match.kind === 'message' &&
        absence.match.payloadPath === 'data.payload' &&
        isSameJsonValue(absence.match.equals, decodeJsonValue(send.payload)) &&
        isJsonRecordValue(absenceValue) && absenceValue.absent === true && absenceValue.matched === false;
    const reloadValue = toRecordedAlmResultValue(sender, evidence.reload);
    return linearRoot && originals.length === 1 && hasReloadNativeHolds(evidence) && validPrefix && validSuffix &&
            receiverPreserved &&
            correctAbsence && isJsonRecordValue(reloadValue) && reloadValue.reloading === true &&
            reloadValue.readyTimeoutMs === evidence.reload.readyTimeoutMs
        ? []
        : [`${checkpoint.key}: reload must preserve native holds, one original send, subscriptions and exact phase work.`];
}

/** The recovered original keeps its generated identity, so it carries the trace its pre-reload send returned. */
function assessReloadTrace(evidence: ReloadEvidence): readonly string[] {
    const sent = toAlmJsonPathValue(toRecordedAlmResultValue(evidence.sender, evidence.send), 'traceId');
    const receives = resolveRecoveredReceives(evidence);
    const received = toAlmJsonPathValue(
        toRecordedAlmResultValue(evidence.receiver, receives[0]),
        'event.payload.data.traceId'
    );
    return receives.length === 1 && nonemptyString(sent) && received === sent
        ? []
        : [`${evidence.checkpoint.key}: the recovered original must carry the original send's trace.`];
}

function resolveRecoveredReceives({ recovery, send }: ReloadEvidence): readonly RallarBlackBoxTestWaitCommand[] {
    return recovery.filter((command): command is RallarBlackBoxTestWaitCommand =>
        command.kind === 'wait' && command.absent !== true &&
        command.match.kind === 'message' && command.match.payloadPath === 'data.payload' &&
        isSameJsonValue(command.match.equals, decodeJsonValue(send.payload))
    );
}

/** The suffix only reads: its waits are the reloaded stores' recovery reads on the storage topic. */
function isReloadSuffixCommand(command: RallarBlackBoxTestCommand): boolean {
    if (command.kind === 'wait') {
        return command.match.kind === 'diagnostic' && command.match.topic === ALM_STORAGE_TOPIC;
    }
    return ['messages.observe', 'assert', 'storage.counters'].includes(command.kind);
}

/** Fault IDs own map entries, so each possible native lane must retain a distinct held fault. */
function hasReloadNativeHolds({ send, prefix }: ReloadEvidence): boolean {
    const selectedCarriers = send.carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [send.carrier];
    const sendIndex = prefix.indexOf(send);
    const holds = prefix.filter((command): command is RallarBlackBoxTestTransportFaultInjectCommand =>
        command.kind === 'fault.inject' && command.carrier !== 'storage'
    );
    const matchingHolds = selectedCarriers.every((carrier) =>
        holds.some((hold) =>
            hold.carrier === carrier && hold.action === (carrier === 'ws' ? 'not-ready' : 'drop') &&
            hold.remaining === 'until-cleared' && hold.match.typeId === send.typeId &&
            Object.keys(hold.match).length === 1 && prefix.indexOf(hold) < sendIndex
        )
    );
    return matchingHolds && holds.length === selectedCarriers.length &&
        holds.every((hold) => nonemptyString(hold.faultId)) &&
        new Set(holds.map((hold) => hold.faultId)).size === holds.length;
}

function assessReloadDocuments(evidence: ReloadEvidence): readonly string[] {
    const beforeCommands = evidence.prefix.filter((command) => command.kind === 'health');
    const before = toAlmJsonPathValue(toRecordedAlmResultValue(evidence.sender, beforeCommands[0]), 'rallar');
    const after = toRecordedAlmResultValue(evidence.sender, evidence.suffix[0]);
    const receiverBefore = toAlmJsonPathValue(
        toRecordedAlmResultValue(evidence.receiver, evidence.receiverBefore.at(-1)),
        'rallar'
    );
    const receiverAfter = toAlmJsonPathValue(
        toRecordedAlmResultValue(evidence.receiver, evidence.recovery.at(-1)),
        'rallar'
    );
    const beforeDocument = toAlmJsonPathValue(before, 'document');
    const afterDocument = toAlmJsonPathValue(after, 'document');
    const receiverDocument = toAlmJsonPathValue(receiverBefore, 'document');
    const receiverAfterDocument = toAlmJsonPathValue(receiverAfter, 'document');
    const session = toAlmJsonPathValue(before, 'session');
    const sameSession = isJsonRecordValue(session) && isJsonRecordValue(after) &&
        nonemptyString(session.clientId) && nonemptyString(session.sessionId) &&
        session.clientId === after.clientId && session.sessionId === after.sessionId;
    const replaced = validDocument(beforeDocument) && validDocument(afterDocument) &&
        beforeDocument.origin === afterDocument.origin && beforeDocument.timeOrigin !== afterDocument.timeOrigin;
    const receiverUnchanged = validDocument(receiverDocument) && validDocument(receiverAfterDocument) &&
        receiverDocument.origin === receiverAfterDocument.origin &&
        receiverDocument.timeOrigin === receiverAfterDocument.timeOrigin;
    return beforeCommands.length === 1 && sameSession && replaced && receiverUnchanged
        ? []
        : [`${evidence.checkpoint.key}: sender document must change in the same origin/session while receiver document remains.`];
}

function assessReloadRetention(evidence: ReloadEvidence): readonly string[] {
    const { prefix, suffix, send, sender, checkpoint } = evidence;
    const sendValue = toRecordedAlmResultValue(sender, send);
    const retained = prefix.filter((command) => command.kind === 'messages.observe');
    const lost = suffix.filter((command) => command.kind === 'messages.observe');
    const retainedValue = toRecordedAlmResultValue(sender, retained[0]);
    const lostValue = toRecordedAlmResultValue(sender, lost[0]);
    const originalHandle = nonemptyString(send.handleId) && isJsonRecordValue(sendValue) &&
        sendValue.handleId === send.handleId && sendValue.carrier === send.carrier;
    const held = retained.length === 1 && retained[0].handleId === send.handleId &&
        retained[0].connection === send.connection &&
        prefix.indexOf(retained[0]) > prefix.indexOf(send) && isJsonRecordValue(retainedValue) &&
        retainedValue.handleId === send.handleId && retainedValue.enqueued === true &&
        retainedValue.submitted === false &&
        (retainedValue.state === 'accepted' || retainedValue.state === 'queued');
    const unobservable = lost.length === 1 && lost[0].handleId === send.handleId &&
        lost[0].connection === send.connection &&
        lost[0].state.length === 1 && lost[0].state[0] === 'unobservable' &&
        isJsonRecordValue(lostValue) && lostValue.handleId === send.handleId && lostValue.state === 'unobservable';
    return originalHandle && held && unobservable
        ? []
        : [`${checkpoint.key}: exact original must be durable, unsubmitted and lose its old handle.`];
}

function validDocument(value: unknown): value is BlackBoxRallarDocumentFacts {
    return isJsonRecordValue(value) && nonemptyString(value.origin) &&
        typeof value.timeOrigin === 'number' && Number.isFinite(value.timeOrigin) && value.timeOrigin > 0;
}

function nonemptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}
