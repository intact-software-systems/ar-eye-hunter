import { toBlackBoxRallarSerializedError } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-serialized-error.ts';
import { RallarRtcCaptureUnverifiedError } from '@shared-web/browser/connection/rallar-rtc-capture-unverified-error.ts';

import type {
    RallarBlackBoxTestCleanupInput,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestError
} from '../rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_RECIPE_TIMEOUT } from '../recipe/run-recipe-commands.ts';
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
