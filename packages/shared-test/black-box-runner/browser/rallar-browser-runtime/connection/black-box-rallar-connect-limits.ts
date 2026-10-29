import { LatestValue } from '@shared/cache/LatestValue.ts';

import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';

export namespace BlackBoxRallarConnectLimits {
    export interface Input<TLimits> {
        readonly defaults: TLimits;
        /** The limits a connect's config names; undefined restores the defaults. */
        readonly readFromConfig: (config: BlackBoxRallarConnectionConfig) => TLimits | undefined;
    }
}

/**
 * The facade is composed before any connect arrives, so it holds only `get` and reads it once per session
 * initialisation (D74, D477); a connect sets the value from its own config before it connects.
 */
export class BlackBoxRallarConnectLimits<TLimits> {
    readonly #input: BlackBoxRallarConnectLimits.Input<TLimits>;
    readonly #latest = new LatestValue<TLimits>();

    constructor(input: BlackBoxRallarConnectLimits.Input<TLimits>) {
        this.#input = input;
    }

    get = (): TLimits => this.#latest.getOrElse(this.#input.defaults);

    set(config: BlackBoxRallarConnectionConfig): void {
        this.#latest.accept(this.#input.readFromConfig(config) ?? this.#input.defaults);
    }
}
