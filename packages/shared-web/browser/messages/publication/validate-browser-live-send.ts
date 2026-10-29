import { isExclusiveSendInput } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type { RallarRtcSendInput } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** The send options a live channel decides itself, and the `resourceId` that names its stream. */
export type BrowserLiveSendOptions = Pick<
    RallarRtcSendInput<never>,
    'reliability' | 'ack' | 'seq' | 'orderingKey' | 'ownership' | 'qos' | 'resourceId'
>;

interface BrowserLiveSendRefusal {
    readonly path: string;
    readonly refused: boolean;
    readonly message: string;
}

/**
 * A live send is one replaceable value of the stream its `resourceId` names, paced and conflated latest-wins
 * before admission, so it asks for no reliability, receipt, ordering, claim, supersedence or storage (D467).
 */
export function validateBrowserLiveSend(send: BrowserLiveSendOptions): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = toBrowserLiveSendRefusals(send)
        .filter((refusal) => refusal.refused)
        .map(({ path, message }) => ({ path, code: 'unsupported', message }));
    if (send.resourceId === undefined) {
        issues.push({
            path: '$.resourceId',
            code: 'missing-resource-id',
            message: 'A live send names the resourceId of the stream it publishes.'
        });
    }
    return issues;
}

function toBrowserLiveSendRefusals(send: BrowserLiveSendOptions): readonly BrowserLiveSendRefusal[] {
    const { qos } = send;
    return [
        {
            path: '$.reliability',
            refused: send.reliability === 'at-least-once',
            message: 'A live send is best-effort.'
        },
        {
            path: '$.qos.delivery',
            refused: qos?.delivery?.algo === 'at-least-once',
            message: 'A live send is best-effort.'
        },
        {
            path: '$.ack',
            refused: send.ack !== undefined && send.ack !== 'none',
            message: 'A live send asks no receipt.'
        },
        {
            path: '$.qos.ack',
            refused: qos?.ack !== undefined && qos.ack.algo !== 'none',
            message: 'A live send asks no receipt.'
        },
        { path: '$.seq', refused: send.seq !== undefined, message: 'A live send is unordered.' },
        { path: '$.orderingKey', refused: send.orderingKey !== undefined, message: 'A live send is unordered.' },
        { path: '$.ownership', refused: isExclusiveSendInput(send), message: 'A live send claims no resource.' },
        {
            path: '$.qos.supersedence',
            refused: qos?.supersedence !== undefined,
            message: 'A live send is conflated latest-wins on its stream.'
        },
        {
            path: '$.qos.durability',
            refused: qos?.durability !== undefined && qos.durability.algo !== 'volatile',
            message: 'A live send is volatile.'
        }
    ];
}
