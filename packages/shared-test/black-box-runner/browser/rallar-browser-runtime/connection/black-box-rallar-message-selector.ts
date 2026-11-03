import {
    normalizeRallarMessageSelector,
    type RallarMessageSelector
} from '@shared-web/browser/messages/rallar-message-selectors.ts';

import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarMessageSelector
} from '../black-box-rallar-operation-contracts.ts';

/** The product selector names only what the lanes match on; the channel access stays the harness's own. */
export function toRallarMessageSelector(selector: BlackBoxRallarMessageSelector): RallarMessageSelector {
    return normalizeRallarMessageSelector({
        ...(selector.topicId === undefined ? {} : { topicId: selector.topicId }),
        ...(selector.typeId === undefined ? {} : { typeId: selector.typeId })
    });
}

/** A channel on the connect's granted selector topic is granted; every other channel the page opens is members. */
export function resolveBlackBoxRallarChannelAccess(
    config: BlackBoxRallarConnectionConfig,
    topicId: string | undefined
): 'members' | 'granted' {
    const selector = config.rallar.messageSelector;
    return selector?.access === 'granted' && selector.topicId === topicId ? 'granted' : 'members';
}
