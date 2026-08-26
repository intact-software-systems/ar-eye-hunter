import { type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import { GroupMutationAuthorizationError } from '../../group-state/group-mutation-authority.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import {
    decodeJsonWireValue,
    hashMutationCommand,
    type JsonWireObject,
    type JsonWireValue
} from '../../protocol/json-wire-identity.ts';
import {
    constantTimeTopologyProofEqual,
    decodeTopologyMutationAuthorityProof
} from '../../topology/inbox/topology-app-inbox-authority.ts';
import { createTopologyMutationAuthorityProof } from '../../topology/inbox/topology-mutation-authority-proof.ts';
import { toRtcRttMutationReceiptId } from '../mutation/rtc-rtt-mutation-identifiers.ts';
import { validateRtcRttMeasurement } from '../persistence/rtc-rtt-persistence-validation.ts';
import type {
    CreateRtcRttAppInboxEnqueueInput,
    RtcRttAppInboxAuthority,
    RtcRttAppInboxCommand
} from './rtc-rtt-app-inbox-contracts.ts';

export interface CreateRtcRttDurableEnqueueInput {
    readonly request: CreateRtcRttAppInboxEnqueueInput;
    readonly groupStateService: GroupStateService;
    readonly nowEpochMs: () => number;
}

export interface VerifyRtcRttAppInboxAuthorityInput {
    readonly authority: RtcRttAppInboxAuthority;
    readonly groupStateService: GroupStateService;
    readonly nowEpochMs: () => number;
}

export async function createRtcRttDurableEnqueue(
    input: CreateRtcRttDurableEnqueueInput
): Promise<AppInboxEnqueueInput<RtcRttAppInboxCommand>> {
    const session = await input.groupStateService.readIssuedAuthSession(input.request.alSenderId);
    if (!session || session.expiresAtEpochMs <= input.nowEpochMs()) {
        throw new GroupMutationAuthorizationError(
            'RTC RTT sender session is missing, expired, or revoked.'
        );
    }
    const requestId = toRtcRttMutationReceiptId(input.request.rtt);
    const stableRequest = {
        rtt: input.request.rtt,
        alSenderId: input.request.alSenderId
    };
    const commandWithoutHash = {
        actor: {
            principalId: session.clientId,
            sessionId: session.sessionId
        },
        requestId,
        mutationCommandHash: await hashMutationCommand(stableRequest),
        capturedAtEpochMs: input.request.capturedAtEpochMs,
        rtt: input.request.rtt
    } as const;
    const stableCommand = {
        actor: commandWithoutHash.actor,
        requestId: commandWithoutHash.requestId,
        mutationCommandHash: commandWithoutHash.mutationCommandHash,
        rtt: commandWithoutHash.rtt
    } as const;
    const command: RtcRttAppInboxCommand = {
        ...commandWithoutHash,
        commandHash: await hashMutationCommand(stableCommand)
    };
    const proof = await createTopologyMutationAuthorityProof(session, command.commandHash);
    return {
        type: AppInboxType.RTC_RTT_SUBMIT,
        resourceId: requestId,
        data: command,
        authority: { kind: 'rtc-rtt', proof, command } satisfies RtcRttAppInboxAuthority
    };
}

export function decodeRtcRttAppInboxAuthority(
    value: JsonWireValue | undefined
): RtcRttAppInboxAuthority {
    try {
        const authority = requireRtcRttJsonObject(value, 'authority');
        requireExactRtcRttKeys(authority, ['kind', 'proof', 'command']);
        if (authority.kind !== 'rtc-rtt') {
            throw new TypeError('authority kind is invalid');
        }
        const proof = decodeTopologyMutationAuthorityProof(authority.proof);
        return {
            kind: 'rtc-rtt',
            proof,
            command: readRtcRttAppInboxCommand(authority.command)
        };
    }
    catch {
        throw new GroupMutationAuthorizationError('RTC RTT AppInbox durable authority is malformed.');
    }
}

export function readRtcRttAppInboxCommand(
    value: JsonWireValue
): RtcRttAppInboxCommand {
    const command = requireRtcRttJsonObject(value, 'command');
    requireExactRtcRttKeys(command, [
        'actor',
        'requestId',
        'commandHash',
        'mutationCommandHash',
        'capturedAtEpochMs',
        'rtt'
    ]);
    const actor = requireRtcRttJsonObject(command.actor, 'actor');
    requireExactRtcRttKeys(actor, ['principalId', 'sessionId']);
    const principalId = actor.principalId;
    const sessionId = actor.sessionId;
    if (typeof principalId !== 'string' || principalId.length === 0) {
        throw new TypeError('RTC RTT AppInbox actor principalId is invalid');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new TypeError('RTC RTT AppInbox actor sessionId is invalid');
    }
    const requestId = requireRtcRttCommandString(command.requestId, 'requestId');
    const commandHash = requireRtcRttCommandString(command.commandHash, 'commandHash');
    const mutationCommandHash = requireRtcRttCommandString(
        command.mutationCommandHash,
        'mutationCommandHash'
    );
    const capturedAtEpochMs = command.capturedAtEpochMs;
    if (typeof capturedAtEpochMs !== 'number' || !Number.isSafeInteger(capturedAtEpochMs) || capturedAtEpochMs < 0) {
        throw new TypeError('RTC RTT AppInbox captured time is invalid');
    }
    const rtt = command.rtt;
    validateRtcRttMeasurement(rtt);
    return {
        actor: { principalId, sessionId },
        requestId,
        commandHash,
        mutationCommandHash,
        capturedAtEpochMs,
        rtt
    };
}

export async function verifyRtcRttAppInboxAuthority(
    input: VerifyRtcRttAppInboxAuthorityInput
): Promise<void> {
    const session = await input.groupStateService.readIssuedAuthSession(
        input.authority.proof.sessionId
    );
    if (
        !session ||
        session.clientId !== input.authority.command.actor.principalId ||
        session.sessionId !== input.authority.command.actor.sessionId ||
        session.expiresAtEpochMs <= input.nowEpochMs() ||
        input.authority.command.commandHash !== input.authority.proof.commandHash
    ) {
        throw new GroupMutationAuthorizationError(
            'RTC RTT authority is missing, expired, revoked, or mismatched.'
        );
    }
    const expected = await createTopologyMutationAuthorityProof(
        session,
        input.authority.command.commandHash
    );
    if (!constantTimeTopologyProofEqual(expected.commandMac, input.authority.proof.commandMac)) {
        throw new GroupMutationAuthorizationError(
            'RTC RTT authority proof does not match the command.'
        );
    }
    await verifyRtcRttCommandHashes(input.authority.command);
}

async function verifyRtcRttCommandHashes(command: RtcRttAppInboxCommand): Promise<void> {
    const canonicalStableCommand = {
        actor: command.actor,
        requestId: command.requestId,
        mutationCommandHash: command.mutationCommandHash,
        rtt: command.rtt
    };
    if (
        (await hashMutationCommand(
                decodeJsonWireValue(canonicalStableCommand, 'RTC RTT stable command')
            )) !== command.commandHash ||
        (await hashMutationCommand(decodeJsonWireValue({
                rtt: command.rtt,
                alSenderId: command.actor.sessionId
            }, 'RTC RTT mutation command'))) !== command.mutationCommandHash
    ) {
        throw new GroupMutationAuthorizationError('RTC RTT durable command hash is invalid.');
    }
}

function requireRtcRttCommandString(value: JsonWireValue, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`RTC RTT AppInbox ${field} is invalid`);
    }
    return value;
}

function requireRtcRttJsonObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (!isRtcRttJsonObject(value)) {
        throw new TypeError(`RTC RTT AppInbox ${label} is invalid`);
    }
    return value;
}

function isRtcRttJsonObject(value: JsonWireValue | undefined): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactRtcRttKeys(
    value: JsonWireObject,
    expected: readonly string[]
): void {
    const actual = Object.keys(value).sort();
    const canonicalExpected = [...expected].sort();
    if (
        actual.length !== canonicalExpected.length ||
        actual.some((key, index) => key !== canonicalExpected[index])
    ) {
        throw new TypeError('RTC RTT AppInbox fields are invalid');
    }
}
