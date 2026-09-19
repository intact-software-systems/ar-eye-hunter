import type { UseRallarServerControllerInput } from './rallar-server-contracts.ts';
import {
    useRallarServerCollectionController,
    type RallarServerCollectionController
} from './use-rallar-server-collection-controller.ts';
import { useRallarServerDefaults } from './use-rallar-server-defaults.ts';
import {
    useRallarServerRequestController,
    type RallarServerRequestController
} from './use-rallar-server-request-controller.ts';

export interface RallarServerControllerModel extends RallarServerRequestController, RallarServerCollectionController {}

export function useRallarServerController(input: UseRallarServerControllerInput): RallarServerControllerModel {
    const defaults = useRallarServerDefaults(input);
    const request = useRallarServerRequestController(input, defaults);
    const collection = useRallarServerCollectionController(input, defaults, request);
    return { ...request, ...collection };
}
