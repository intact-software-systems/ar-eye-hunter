import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

export type RallarMessageSelector = Readonly<{
    topicId?: string;
    typeId?: string;
}>;

export type RallarMessageSelectorInput = string | RallarMessageSelector;

export function normalizeRallarMessageSelector(
    selector: RallarMessageSelectorInput
): RallarMessageSelector {
    if (typeof selector === 'string') {
        return { typeId: selector };
    }

    if (!selector.topicId && !selector.typeId) {
        throw new Error('Message selector requires topicId or typeId.');
    }

    return selector;
}

export function toRallarMessageSelectorKey(
    selector: RallarMessageSelector
): string {
    return `${selector.topicId ?? '*'}/${selector.typeId ?? '*'}`;
}

export function matchesRallarMessageSelector(
    selector: RallarMessageSelector,
    message: ALMessage
): boolean {
    return (selector.topicId === undefined ||
        selector.topicId === message.route.topicId) &&
        (selector.typeId === undefined ||
            selector.typeId === message.payload.typeId);
}

export function readRallarMessageRoomId(
    message: ALMessage
): string | undefined {
    if (message.targets?.mode === 'multicast') {
        return message.targets.groupRef.groupId;
    }

    if (
        message.targets?.mode === 'broadcast' && message.targets.scope === 'room'
    ) {
        return message.route.contextId;
    }

    return undefined;
}
