import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestStorageFaultInjectCommand,
    RallarBlackBoxTestTransportFaultInjectCommand
} from '../../rallar-black-box-test-contracts.ts';

import { toBudgetMs } from './alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
import type { AlmConformanceMessageStepInput, AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from './alm-conformance-step-identities.ts';

export type AlmConformanceFaultCarrier = 'ws' | 'rtc';

export const FAULT_TIMEOUT_MS = 3_000;

interface AlmConformanceFaultCommandInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** Prefixes the scenario's type id: one fault id per carrier and purpose. */
    readonly faultName: string;
    readonly carrier: AlmConformanceFaultCarrier;
    /** The frames the fault meets: every frame of the scenario's type, or the one message a send returned. */
    readonly match: RallarBlackBoxTestTransportFaultInjectCommand['match'];
    readonly action: 'drop' | 'not-ready' | 'backpressure';
    readonly remaining: 'until-cleared' | 0;
}

export function toHeldFaultCommands(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): readonly RallarBlackBoxTestCommand[] {
    return toFaultCarriers(step.input.carrier).map((carrier) =>
        toFaultCommand({
            step,
            name: `${name}-${carrier}`,
            faultName: `hold-${carrier}`,
            carrier,
            match: { typeId: toScenarioTypeId(step) },
            action: toHoldAction(carrier),
            remaining
        })
    );
}

/**
 * Holds one message of the scenario on each carrier the cell can hold, by the message id its send returned: a
 * frame of the type whose id differs passes. The same ids with `remaining: 0` release it. Over WS the frame is never
 * submitted; over RTC each attempt settles `not-ready` and its owner resubmits it, as {@link toHeldFaultCommands}.
 */
export function toHeldMessageFaultCommands(
    step: AlmConformanceMessageStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): readonly RallarBlackBoxTestCommand[] {
    const msgId = `{resultCache.${toCommandId(step, `send-${step.index}`)}.value.msgId}`;
    return toFaultCarriers(step.input.carrier).map((carrier) =>
        toFaultCommand({
            step,
            name: `${name}-${carrier}`,
            faultName: `hold-message-${step.index}-${carrier}`,
            carrier,
            match: { msgId },
            action: toHoldAction(carrier),
            remaining
        })
    );
}

function toHoldAction(carrier: AlmConformanceFaultCarrier): 'drop' | 'not-ready' {
    return carrier === 'ws' ? 'not-ready' : 'drop';
}

/**
 * Drops every RTC frame of the scenario's type this page sends: each attempt settles `not-ready` and its
 * owner resubmits it 50 ms later, so a hold yields the consecutive run D56 hands to WS.
 */
export function toRtcDropFaultCommand(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): RallarBlackBoxTestCommand {
    return toFaultCommand({
        step,
        name,
        faultName: 'drop-rtc',
        carrier: 'rtc',
        match: { typeId: toScenarioTypeId(step) },
        action: 'drop',
        remaining
    });
}

/**
 * Holds the first carrier of the cell's strategy at its high watermark for the frames of the scenario's type (D184):
 * the RTC leg under `rtc-with-ws-fallback`, so its WS leg stays free. The same id with `remaining: 0` releases it.
 */
export function toBackpressureFaultCommand(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): RallarBlackBoxTestTransportFaultInjectCommand {
    const carrier = step.input.carrier === 'ws' ? 'ws' : 'rtc';
    return toFaultCommand({
        step,
        name,
        faultName: `backpressure-${carrier}`,
        carrier,
        match: { typeId: toScenarioTypeId(step) },
        action: 'backpressure',
        remaining
    });
}

/**
 * Fails every admission write and every work-queue write of this page with `QuotaExceededError` while held, each owner
 * under its own fault id; the same ids with `remaining: 0` release them. Reads go through. Both ids start with
 * {@link toStorageQuotaFaultIdPrefix}, so a store's last failure names this cell whichever owner failed last.
 */
export function toStorageQuotaFaultCommands(
    step: AlmConformanceStepInput,
    phase: 'hold' | 'release'
): readonly RallarBlackBoxTestStorageFaultInjectCommand[] {
    const remaining = phase === 'hold' ? 'until-cleared' : 0;
    return [
        toStorageQuotaFaultCommand(step, {
            name: `quota-admission-${phase}`,
            faultId: `${toStorageQuotaFaultIdPrefix(step)}admission`,
            match: { owner: 'al-admission', kind: 'write' },
            remaining
        }),
        toStorageQuotaFaultCommand(step, {
            name: `quota-work-${phase}`,
            faultId: `${toStorageQuotaFaultIdPrefix(step)}work`,
            match: { owner: 'al-work' },
            remaining
        })
    ];
}

/** The cell's type id first: no type id followed by `.quota-` is a prefix of another. */
export function toStorageQuotaFaultIdPrefix(step: AlmConformanceStepInput): string {
    return `${toScenarioTypeId(step)}.quota-`;
}

interface StorageQuotaFault {
    readonly name: string;
    readonly faultId: string;
    readonly match: RallarBlackBoxTestStorageFaultInjectCommand['match'];
    readonly remaining: 'until-cleared' | 0;
}

function toStorageQuotaFaultCommand(
    step: AlmConformanceStepInput,
    fault: StorageQuotaFault
): RallarBlackBoxTestStorageFaultInjectCommand {
    return {
        kind: 'fault.inject',
        commandId: toCommandId(step, fault.name),
        faultId: fault.faultId,
        carrier: 'storage',
        match: fault.match,
        action: 'quota',
        remaining: fault.remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, step.input.deadlineMs)
    };
}

function toFaultCommand(
    input: AlmConformanceFaultCommandInput
): RallarBlackBoxTestTransportFaultInjectCommand {
    return {
        kind: 'fault.inject',
        commandId: toCommandId(input.step, input.name),
        faultId: `${input.faultName}-${toScenarioTypeId(input.step)}`,
        carrier: input.carrier,
        match: input.match,
        action: input.action,
        remaining: input.remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, input.step.input.deadlineMs)
    };
}

export function toFaultCarriers(
    carrier: AlmConformanceCarrier
): readonly AlmConformanceFaultCarrier[] {
    return carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier];
}
