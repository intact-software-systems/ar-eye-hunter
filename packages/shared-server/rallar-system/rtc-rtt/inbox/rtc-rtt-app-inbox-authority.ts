import { type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import { hashCanonicalCommand } from '../../app-inbox/hash-canonical-command.ts';
import { GroupMutationAuthorizationError } from '../../group-state/group-mutation-authority.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import {
    constantTimeTopologyProofEqual,
    readTopologyMutationAuthorityProof
} from '../../topology/inbox/topology-app-inbox-authority.ts';
import { isTopologyRecord, requireExactTopologyKeys } from '../../topology/inbox/topology-app-inbox-command.ts';
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
        mutationCommandHash: await hashCanonicalCommand(stableRequest),
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
        commandHash: await hashCanonicalCommand(stableCommand)
    };
    const proof = await createTopologyMutationAuthorityProof(session, command.commandHash);
    return {
        type: AppInboxType.RTC_RTT_SUBMIT,
        resourceId: requestId,
        data: command,
        authority: { kind: 'rtc-rtt', proof, command } satisfies RtcRttAppInboxAuthority
    };
}

export function readRtcRttAppInboxAuthority(value: unknown): RtcRttAppInboxAuthority {
    try {
        if (!isTopologyRecord(value)) {
            throw new TypeError('authority is not a record');
        }
        requireExactTopologyKeys(value, ['kind', 'proof', 'command']);
        if (value.kind !== 'rtc-rtt') {
            throw new TypeError('authority kind is invalid');
        }
        readTopologyMutationAuthorityProof(value.proof);
        const command = isTopologyRecord(value.command) ? value.command : null;
        if (!command) {
            throw new TypeError('RTC RTT command is invalid');
        }
        requireExactTopologyKeys(command, [
            'actor',
            'requestId',
            'commandHash',
            'mutationCommandHash',
            'capturedAtEpochMs',
            'rtt'
        ]);
        validateRtcRttMeasurement(command.rtt);
        return value as RtcRttAppInboxAuthority;
    }
    catch {
        throw new GroupMutationAuthorizationError('RTC RTT AppInbox durable authority is malformed.');
    }
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
        (await hashCanonicalCommand(canonicalStableCommand)) !== command.commandHash ||
        (await hashCanonicalCommand({
                rtt: command.rtt,
                alSenderId: command.actor.sessionId
            })) !== command.mutationCommandHash
    ) {
        throw new GroupMutationAuthorizationError('RTC RTT durable command hash is invalid.');
    }
}
