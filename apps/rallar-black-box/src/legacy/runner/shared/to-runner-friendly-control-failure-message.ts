import {
    toControlFailureMessage,
    type ControlRequestFailure
} from '../../../control-run-manager/control-request-failure.ts';
import { runnerFriendlyErrorMessage } from '../../../runner-readiness.ts';

/**
 * The sentence a runner panel shows for a failed control-server read. The readers report these
 * failures as values rather than throwing, so the message still passes through the same runner
 * vocabulary the panel's catch block applied when it was a thrown error.
 */
export function toRunnerFriendlyControlFailureMessage(
    failure: ControlRequestFailure | undefined
): string {
    return runnerFriendlyErrorMessage(toControlFailureMessage(failure));
}
