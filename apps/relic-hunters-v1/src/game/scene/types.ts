export type CardinalDirection = 'north' | 'south' | 'east' | 'west';

export type PointerLookState = {
    active: boolean;
    lastX: number;
    lastY: number;
    pointerId?: number;
};

export type CollisionBox = Readonly<{
    x: number;
    z: number;
    halfX: number;
    halfZ: number;
}>;

export type ScenePrompt =
    | Readonly<{
        kind: 'move';
        roomId: string;
        roomName: string;
        direction: CardinalDirection;
    }>
    | Readonly<{
        kind: 'search';
        hotspotId?: string;
        label: string;
        detail: string;
        inspecting?: boolean;
    }>;

export type ClueHotspot = Readonly<{
    id: string;
    x: number;
    z: number;
    label: string;
    promptLabel: string;
    detail: string;
    inspectionDetail: string;
    discoveredLabel: string;
}>;

export type InspectionFocus = Readonly<{
    roomId: string;
    hotspot: ClueHotspot;
}>;
