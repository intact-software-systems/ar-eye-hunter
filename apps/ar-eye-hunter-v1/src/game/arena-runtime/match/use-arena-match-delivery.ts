import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarDirectorOutputOptions, RallarUnsubscribe } from '@shared-web/browser/rallar.ts';

import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaMatchLifecycleMessage } from '../../types.ts';
import type { MatchDelivery } from '../arena-connection-contracts.ts';
import { toMatchDelivery } from './to-match-delivery.ts';

const MATCH_LIFECYCLE_OUTPUT_OPTIONS: RallarDirectorOutputOptions = { ack: 'all-logical-recipients' };

interface ArenaMatchDeliveryInput {
    readonly currentNetworkSignal: () => AbortSignal;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly networkGenerationRef: RefObject<number>;
}

interface ArenaMatchDeliveryObserverInput extends ArenaMatchDeliveryInput {
    readonly setMatchDelivery: Dispatch<SetStateAction<MatchDelivery | undefined>>;
}

export interface ArenaMatchDelivery {
    readonly matchDelivery: MatchDelivery | undefined;
    publishMatchLifecycleOutput(
        match: Pick<ArenaRallarGameMatchHandle, 'publishEvent'>,
        message: ArenaMatchLifecycleMessage
    ): Promise<void>;
}

export function useArenaMatchDelivery(input: ArenaMatchDeliveryInput): ArenaMatchDelivery {
    const [matchDelivery, setMatchDelivery] = useState<MatchDelivery | undefined>();
    const [observer] = useState(() => new ArenaMatchDeliveryObserver({ ...input, setMatchDelivery }));
    useEffect(() => () => observer.stop(), [observer]);
    const publishMatchLifecycleOutput = useCallback(
        (match: Pick<ArenaRallarGameMatchHandle, 'publishEvent'>, message: ArenaMatchLifecycleMessage) =>
            observer.publish(match, message),
        [observer]
    );
    return { matchDelivery, publishMatchLifecycleOutput };
}

class ArenaMatchDeliveryObserver {
    private readonly input: ArenaMatchDeliveryObserverInput;
    private unsubscribeReceipt: RallarUnsubscribe | undefined;
    private observedSignal: AbortSignal | undefined;
    private readonly clearOnNetworkEnd = () => {
        this.stop();
        this.input.setMatchDelivery(undefined);
    };

    constructor(input: ArenaMatchDeliveryObserverInput) {
        this.input = input;
    }

    async publish(
        match: Pick<ArenaRallarGameMatchHandle, 'publishEvent'>,
        message: ArenaMatchLifecycleMessage
    ): Promise<void> {
        const generation = this.input.networkGenerationRef.current;
        const result = await match.publishEvent(message, MATCH_LIFECYCLE_OUTPUT_OPTIONS);
        const receipt = result.relay?.receipt;
        if (receipt && this.input.isCurrentNetworkGeneration(generation)) {
            this.observe(message.kind, receipt);
        }
    }

    stop(): void {
        this.observedSignal?.removeEventListener('abort', this.clearOnNetworkEnd);
        this.observedSignal = undefined;
        this.unsubscribeReceipt?.();
        this.unsubscribeReceipt = undefined;
    }

    private observe(output: MatchDelivery['output'], receipt: RallarMessageHandle): void {
        this.stop();
        this.observedSignal = this.input.currentNetworkSignal();
        this.observedSignal.addEventListener('abort', this.clearOnNetworkEnd, { once: true });
        this.input.setMatchDelivery(toMatchDelivery(output, receipt.lifecycle()));
        this.unsubscribeReceipt = receipt.onEvent((lifecycle) =>
            this.input.setMatchDelivery(toMatchDelivery(output, lifecycle))
        );
    }
}
