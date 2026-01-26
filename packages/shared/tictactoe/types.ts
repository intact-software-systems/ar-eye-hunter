export enum Player {
    X = "X",
    O = "O",
    NA = "NA",
}

export enum MoveIndex {
    NA = -1,
}

export enum Cell {
    X = "X",
    O = "O",
    Empty = "Empty",
}

export enum GameResult {
    InProgress = "InProgress",
    Draw = "Draw",
    XWins = "XWins",
    OWins = "OWins",
}

export enum CpuDifficulty {
    Easy = "Easy",
    Medium = "Medium",
    Hard = "Hard",
    Empty = "Empty",
}

export enum GameModeType {
    Cpu = "Cpu",
    LocalHuman = "LocalHuman",
}

export enum BoardMove {
    Succes = "Succes",
    Failed = "Failed",
}

export type GameMode =
    | {
    type: GameModeType.Cpu;
    difficulty: CpuDifficulty;
}
    | {
    type: GameModeType.LocalHuman;
    difficulty: CpuDifficulty.Empty;
};

export type GameState = {
    board: readonly Cell[];
    currentPlayer: Player;
    result: GameResult;
    mode: GameMode;
};

export interface ApplyMoveResult {
    readonly input: GameState;
    readonly output: GameState;
    readonly move: BoardMove;
}
