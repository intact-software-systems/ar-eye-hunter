import { createRallarAiFunnyRoomName, type RallarAiFunnyRoomNameTheme } from '@shared/rallar-ai/mod.ts';

const RELIC_ROOM_NAME_THEME: RallarAiFunnyRoomNameTheme = {
    id: 'relic-hunters',
    defaultBaseName: 'Relic Hunters Expedition',
    nouns: [
        'Teacup',
        'Compass',
        'Pickle',
        'Noodle',
        'Lantern',
        'Keycard',
        'Scroll',
        'Dojo',
        'Kiosk',
        'Satchel',
        'Map',
        'Pebble'
    ]
};
export function createRelicRoomName(seed: string, existingNames: readonly string[]): string {
    return createRallarAiFunnyRoomName({
        baseName: RELIC_ROOM_NAME_THEME.defaultBaseName,
        theme: RELIC_ROOM_NAME_THEME,
        seed,
        existingNames
    });
}
