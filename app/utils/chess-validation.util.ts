import { Chess } from 'chess.js';

/**
 * Chess data structure for flashcards
 */
/** Single Q/A pair for a position */
export interface PositionQuestionItem {
    id: string;
    question: string;
    answer: string;
}

/** Questions linked to a specific position (FEN + moveIndex) */
export interface PositionQuestion {
    fen: string;
    moveIndex?: number;
    questions: PositionQuestionItem[];
}

/**
 * Chess data structure for flashcards
 */
export interface ChessData {
    startingFen?: string;
    moves: string[];
    targetFen?: string;
    orientation?: 'white' | 'black';
    practiceFromMove?: number;
    openingName?: string;
    isValid?: boolean;
    validationError?: string;
    /** Position-linked Q/A for concept review at specific positions */
    positionQuestions?: PositionQuestion[];
}

/**
 * Result of chess data validation
 */
export interface ChessValidationResult {
    isValid: boolean;
    computedTargetFen?: string;
    error?: string;
    moveCount?: number;
}

// Default starting position FEN
const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Validate and process chess data for a flashcard
 * - Validates starting FEN (if provided)
 * - Validates each move in sequence
 * - Computes the target FEN
 * - Optionally validates against provided target FEN
 *
 * @param chessData - The chess data to validate
 * @returns Validation result with computed target FEN
 */
export function validateChessData(chessData: ChessData): ChessValidationResult {
    if (!chessData) {
        return { isValid: false, error: 'No chess data provided' };
    }

    if (!chessData.moves || !Array.isArray(chessData.moves)) {
        return { isValid: false, error: 'Moves array is required' };
    }

    if (chessData.moves.length === 0) {
        return { isValid: false, error: 'At least one move is required' };
    }

    try {
        // Use provided starting FEN or default
        const startingFen = chessData.startingFen || INITIAL_FEN;

        // Validate starting FEN by trying to load it
        const chess = new Chess(startingFen);

        // Play each move and validate
        for (let i = 0; i < chessData.moves.length; i++) {
            const move = chessData.moves[i];

            // Try to make the move
            const result = chess.move(move);

            if (!result) {
                return {
                    isValid: false,
                    error: `Invalid move at position ${i + 1}: "${move}" is not legal in this position`
                };
            }
        }

        // Get the final position
        const computedTargetFen = chess.fen();

        // If target FEN was provided, validate it matches
        if (chessData.targetFen) {
            // Compare just the position part (ignore move counters)
            const computedPosition = computedTargetFen.split(' ')[0];
            const providedPosition = chessData.targetFen.split(' ')[0];

            if (computedPosition !== providedPosition) {
                return {
                    isValid: false,
                    computedTargetFen,
                    error: `Target FEN does not match computed position. Expected: ${computedPosition}, Provided: ${providedPosition}`
                };
            }
        }

        return {
            isValid: true,
            computedTargetFen,
            moveCount: chessData.moves.length
        };

    } catch (error: any) {
        return {
            isValid: false,
            error: `Chess validation error: ${error.message || error}`
        };
    }
}

/**
 * Process chess data before saving
 * - Validates the data
 * - Computes and sets the target FEN
 * - Sets validation status
 *
 * @param chessData - The chess data to process
 * @returns Processed chess data with validation status
 */
export function processChessData(chessData: ChessData): ChessData {
    const result = validateChessData(chessData);

    return {
        ...chessData,
        targetFen: result.computedTargetFen || chessData.targetFen,
        isValid: result.isValid,
        validationError: result.error
    };
}

/**
 * Convert legacy fen/pgn format to new chessData format
 *
 * @param fen - Legacy FEN string
 * @param pgn - Legacy PGN string
 * @param openingName - Opening name
 * @param startingFen - Starting FEN for PGN
 * @returns ChessData object or null if no valid data
 */
export function convertLegacyToChessData(
    fen?: string,
    pgn?: string,
    openingName?: string,
    startingFen?: string
): ChessData | null {
    // If we have PGN, parse the moves
    if (pgn) {
        try {
            const moves = parsePgnMoves(pgn);
            if (moves.length > 0) {
                const chessData: ChessData = {
                    startingFen: startingFen || INITIAL_FEN,
                    moves,
                    openingName
                };

                // Validate and compute target FEN
                return processChessData(chessData);
            }
        } catch (error) {
            console.warn('Failed to parse PGN:', error);
        }
    }

    // If we only have FEN, create a chessData with empty moves
    // This allows displaying the position but not practice mode
    if (fen) {
        return {
            startingFen: fen,
            moves: [],
            targetFen: fen,
            openingName,
            isValid: true
        };
    }

    return null;
}

/**
 * Parse moves from a PGN string
 * Handles various PGN formats including move numbers and annotations
 *
 * @param pgn - PGN string
 * @returns Array of moves in SAN notation
 */
export function parsePgnMoves(pgn: string): string[] {
    if (!pgn || typeof pgn !== 'string') {
        return [];
    }

    // Remove comments in curly braces
    let cleaned = pgn.replace(/\{[^}]*\}/g, '');

    // Remove variations in parentheses
    cleaned = cleaned.replace(/\([^)]*\)/g, '');

    // Remove result markers
    cleaned = cleaned.replace(/1-0|0-1|1\/2-1\/2|\*/g, '');

    // Remove move numbers (e.g., "1.", "1...", "12.")
    cleaned = cleaned.replace(/\d+\.+/g, '');

    // Remove NAG symbols ($1, $2, etc.)
    cleaned = cleaned.replace(/\$\d+/g, '');

    // Remove check/checkmate symbols for cleaning (will be in the actual moves)
    // Actually, keep these as they're part of SAN notation

    // Split by whitespace and filter empty strings
    const moves = cleaned.split(/\s+/).filter(move => {
        // Keep only valid-looking moves
        return move.length > 0 &&
               move.length <= 10 &&
               /^[KQRBNP]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?$|^O-O(-O)?[+#]?$/i.test(move);
    });

    return moves;
}

/**
 * Generate PGN from chessData
 * Useful for backward compatibility with components expecting PGN
 *
 * @param chessData - Chess data with moves
 * @returns PGN string
 */
export function generatePgnFromChessData(chessData: ChessData): string {
    if (!chessData || !chessData.moves || chessData.moves.length === 0) {
        return '';
    }

    const parts: string[] = [];

    for (let i = 0; i < chessData.moves.length; i++) {
        if (i % 2 === 0) {
            // White's move - add move number
            parts.push(`${Math.floor(i / 2) + 1}.`);
        }
        parts.push(chessData.moves[i]);
    }

    return parts.join(' ');
}
