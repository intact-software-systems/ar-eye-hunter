import {
    AL_PUBLICATION_STAGE_LIMITS,
    type ALPublicationStageLimits
} from '@shared/al-contracts/publication/al-publication-stage-limits.ts';

import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';

/**
 * Like the volatile limits, the facade holds only `get` and reads it once per session initialisation (D477); a
 * connect sets the value from its own config before it connects, and one that names none restores the defaults.
 */
export class BlackBoxRallarPublicationLimits {
    #limits: ALPublicationStageLimits = AL_PUBLICATION_STAGE_LIMITS;

    get = (): ALPublicationStageLimits => this.#limits;

    set(config: BlackBoxRallarConnectionConfig): void {
        this.#limits = config.rallar.almPublicationLimits ?? AL_PUBLICATION_STAGE_LIMITS;
    }
}
