import type { RallarTopicSubscription, RallarTopicSubscriptionStatus } from '@shared-web/browser/messages/rallar-message-contracts.ts';

/** One `subscribe` call's handle; its owner settles it and answers its release. */
export class BrowserTopicSubscriptionToken implements RallarTopicSubscription {
    #status: RallarTopicSubscriptionStatus = 'pending';
    readonly #settled = Promise.withResolvers<RallarTopicSubscriptionStatus>();
    readonly #release: (token: BrowserTopicSubscriptionToken) => Promise<void>;

    public constructor(release: (token: BrowserTopicSubscriptionToken) => Promise<void>) {
        this.#release = release;
    }

    public status(): RallarTopicSubscriptionStatus {
        return this.#status;
    }

    public async wait(): Promise<RallarTopicSubscriptionStatus> {
        return await this.#settled.promise;
    }

    public async unsubscribe(): Promise<void> {
        await this.#release(this);
    }

    /** A refused or lapsed token keeps its status. */
    public settle(status: RallarTopicSubscriptionStatus): void {
        if (this.#status === 'refused' || this.#status === 'lapsed') {
            return;
        }
        this.#status = status;
        if (status !== 'pending') {
            this.#settled.resolve(status);
        }
    }
}
