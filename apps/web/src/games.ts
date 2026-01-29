export enum GameId {
    TicTacToe = 'tictactoe',
    WhackAWorm = 'whackaworm',
}

export type GameDefinition = {
    readonly id: GameId;
    readonly title: string;
    readonly description: string;
    readonly href: string; // hash route
    readonly badge: string; // e.g. "New" / "3 modes" / etc
};

export const GAMES: readonly GameDefinition[] = [
    {
        id: GameId.TicTacToe,
        title: 'Tic-tac-toe',
        description: 'Single-player, server multiplayer, and P2P WebRTC.',
        href: '#/tictactoe',
        badge: '3 modes',
    },
    {
        id: GameId.WhackAWorm,
        title: 'Whack-a-worm',
        description: 'Coming next.',
        href: '#/whackaworm',
        badge: 'New',
    },
];
