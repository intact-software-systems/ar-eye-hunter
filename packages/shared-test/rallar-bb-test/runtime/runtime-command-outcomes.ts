import { toBlackBoxRallarSerializedError } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-serialized-error.ts';
import { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';

import type {
    RallarBlackBoxTestCleanupInput,
    RallarBlackBoxTestCloseCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecipeCancelCommand,
    RallarBlackBoxTestRuntimeStatus
} from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_RECIPE_TIMEOUT } from '../recipe/run-recipe-commands.ts';
import { decodeRecord } from './decode-runtime-result-values.ts';
import { isAbortError } from './sleep-with-abort.ts';

export function toInvalidRecipeOutcome(issues: readonly string[]): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        error: { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', message: issues.join('\n') },
        nextStatus: 'failed'
    };
}

export function toTerminalCleanupReason(
    outcome: RallarBlackBoxTestCommandOutcome
): RallarBlackBoxTestCleanupInput['reason'] {
    if (outcome.status === 'cancelled') {
        return 'cancelled';
    }
    return outcome.error?.code === RALLAR_BLACK_BOX_RECIPE_TIMEOUT ? 'timed-out' : 'failed';
}

export function decodeThrownCommandOutcome(error: unknown): RallarBlackBoxTestCommandOutcome {
    if (error instanceof RallarRtcCaptureUnverifiedError) {
        return {
            status: 'failed',
            error: { code: error.code, message: error.message, details: toBlackBoxRallarSerializedError(error) },
            nextStatus: 'failed'
        };
    }
    return isAbortError(error)
        ? {
            status: 'cancelled',
            error: decodeRuntimeTestError(error, 'RALLAR_BLACK_BOX_COMMAND_CANCELLED'),
            nextStatus: 'cancelled'
        }
        : {
            status: 'failed',
            error: decodeRuntimeTestError(error, 'RALLAR_BLACK_BOX_COMMAND_FAILED'),
            nextStatus: 'failed'
        };
}

export function decodeRuntimeTestError(error: unknown, code: string): RallarBlackBoxTestError {
    return error instanceof Error
        ? { code, message: error.message, details: { name: error.name, stack: error.stack } }
        : { code, message: String(error) };
}

/** Children always execute; only top-level commands replay their accepted cached result. */
export type ResultCachePolicy = 'replay' | 'bypass';

export interface RuntimeCleanupAdmissionFacts {
    readonly command: RallarBlackBoxTestCommand;
    readonly cachePolicy: ResultCachePolicy;
    readonly cleanupInProgress: boolean;
    readonly activeTopLevelCount: number;
    readonly exclusiveTopLevelCommandId: string | undefined;
    readonly status: RallarBlackBoxTestRuntimeStatus;
}

/** Refusal is pure; the runtime alone acquires the targeted cleanup fence after acceptance. */
export function resolveRuntimeCleanupRefusal(
    input: RuntimeCleanupAdmissionFacts
): RallarBlackBoxTestCommandOutcome | undefined {
    const { command } = input;
    if (
        input.cachePolicy === 'bypass' && (command.kind === 'close' || command.kind === 'recipe.cancel') &&
        command.targetCommandId !== undefined
    ) {
        return {
            status: 'ok',
            nextStatus: input.status,
            value: {
                ...(command.kind === 'close' ? { closed: false } : { cancelRequested: false }),
                targetCommandId: command.targetCommandId,
                reason: 'targeted-cleanup-requires-top-level'
            }
        };
    }
    if (input.cachePolicy === 'replay' && input.cleanupInProgress) {
        return {
            status: 'failed',
            nextStatus: input.status,
            error: {
                code: 'RALLAR_BLACK_BOX_CLEANUP_IN_PROGRESS',
                message: 'Owned resource cleanup is still settling.'
            }
        };
    }
    if (
        isTargetedRuntimeClose(command) &&
        (input.activeTopLevelCount !== 0 || input.exclusiveTopLevelCommandId !== command.targetCommandId)
    ) {
        return {
            status: 'ok',
            nextStatus: input.status,
            value: {
                closed: false,
                targetCommandId: command.targetCommandId,
                reason: 'target-not-exclusive-idle-owner'
            }
        };
    }
    return undefined;
}

export function isTargetedRuntimeClose(
    command: RallarBlackBoxTestCommand
): command is RallarBlackBoxTestCloseCommand & Readonly<{ targetCommandId: string; }> {
    return command.kind === 'close' && command.targetCommandId !== undefined;
}

export function isTopLevelResourceExecution(
    command: RallarBlackBoxTestCommand,
    cachePolicy: ResultCachePolicy
): boolean {
    return cachePolicy === 'replay' && command.kind !== 'recipe.cancel' && !isTargetedRuntimeClose(command);
}

/** Interpret actual cleanup receipts without acquiring, releasing or changing assignment ownership. */
export function isAcceptedRuntimeCleanup(
    command: RallarBlackBoxTestCommand,
    outcome: RallarBlackBoxTestCommandOutcome
): command is RallarBlackBoxTestCloseCommand | RallarBlackBoxTestRecipeCancelCommand {
    if (outcome.status !== 'ok') {
        return false;
    }
    if (command.kind === 'close') {
        return decodeRecord(outcome.value).closed !== false;
    }
    return command.kind === 'recipe.cancel' && decodeRecord(outcome.value).cancelRequested === true;
}
