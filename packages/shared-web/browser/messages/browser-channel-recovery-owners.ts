import type {
    RallarChannelRecovery,
    RallarTypedMessageChannelDefinition
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { toRallarMessageSelectorKey } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

/**
 * The recovery owners the typed channels declared, by route. A channel that declared a topic owns the
 * messages of that topic and type; one that declared none owns every message of its type.
 */
export class BrowserChannelRecoveryOwners {
    private readonly owners = new Map<string, RallarChannelRecovery>();

    /** The latest declaration for a route stands, as the latest channel for it does. */
    setOwner(
        route: Pick<RallarTypedMessageChannelDefinition, 'topicId' | 'typeId'>,
        owner: RallarChannelRecovery
    ): void {
        this.owners.set(toRallarMessageSelectorKey(route), owner);
    }

    getOwner(msg: ALMessage): RallarChannelRecovery | undefined {
        const typeId = msg.payload.typeId;
        return this.owners.get(toRallarMessageSelectorKey({ topicId: msg.route.topicId, typeId })) ??
            this.owners.get(toRallarMessageSelectorKey({ typeId }));
    }
}
