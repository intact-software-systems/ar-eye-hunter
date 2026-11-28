import type {
    BlackBoxRallarMessageCallRefusalDiagnostics,
    BlackBoxRallarMessageReplayDiagnostics,
    BlackBoxRallarMessageSendDiagnostics
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';

/** A send that observes no call refusal names a message; a test that reads its `msgId` reads it through this. */
export function requireMessageSendHandle(
    result:
        | BlackBoxRallarMessageSendDiagnostics
        | BlackBoxRallarMessageCallRefusalDiagnostics
        | BlackBoxRallarMessageReplayDiagnostics
): BlackBoxRallarMessageSendDiagnostics | BlackBoxRallarMessageReplayDiagnostics {
    if ('callRefusal' in result) {
        throw new Error(`messages.send ${result.handleId} was refused at its call and names no message.`);
    }
    return result;
}
