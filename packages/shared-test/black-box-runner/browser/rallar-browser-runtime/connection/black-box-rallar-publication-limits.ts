import {
    AL_PUBLICATION_STAGE_LIMITS,
    type ALPublicationStageLimits
} from '@shared/al-contracts/publication/al-publication-stage-limits.ts';

import { BlackBoxRallarConnectLimits } from './black-box-rallar-connect-limits.ts';

export class BlackBoxRallarPublicationLimits extends BlackBoxRallarConnectLimits<ALPublicationStageLimits> {
    constructor() {
        super({
            defaults: AL_PUBLICATION_STAGE_LIMITS,
            readFromConfig: (config) => config.rallar.almPublicationLimits
        });
    }
}
