/**
 * Generalized difficulty classification for flashcards.
 * Each card type registers a classifier that maps card data → difficulty (1-5).
 * All logic lives here on the backend — frontends never compute difficulty.
 */

export interface DifficultyClassifier {
    cardType: string;
    classify(cardData: any): number;
}

/**
 * Chess Opening classifier
 * Factors: move depth, number of moves in history (deeper = harder)
 */
const chessOpeningClassifier: DifficultyClassifier = {
    cardType: 'chessOpening',
    classify(cardData: any): number {
        const moveNumber = cardData.moveNumber
            ?? cardData.chessData?.moves?.length
            ?? 0;

        // Early moves (1-4) = easy, mid-game (5-12) = medium, deep theory (13+) = hard
        if (moveNumber <= 4) return 1;
        if (moveNumber <= 8) return 2;
        if (moveNumber <= 12) return 3;
        if (moveNumber <= 16) return 4;
        return 5;
    }
};

/**
 * Chess Puzzle classifier
 * Factors: number of options (more plausible moves = harder),
 * whether a suggested move exists, answer length
 */
const chessPuzzleClassifier: DifficultyClassifier = {
    cardType: 'chessPuzzle',
    classify(cardData: any): number {
        let score = 3; // baseline

        // More options = harder to pick the right one
        const optionCount = cardData.options?.length ?? 0;
        if (optionCount <= 2) score -= 1;
        else if (optionCount >= 5) score += 1;

        // Longer move history = more complex position
        const moveCount = cardData.chessData?.moves?.length ?? 0;
        if (moveCount > 20) score += 1;
        if (moveCount <= 5) score -= 1;

        return Math.max(1, Math.min(5, score));
    }
};

/**
 * Multiple Choice classifier
 * Factors: number of options, similarity of answer lengths
 */
const multipleChoiceClassifier: DifficultyClassifier = {
    cardType: 'multipleChoice',
    classify(cardData: any): number {
        const optionCount = cardData.options?.length ?? 4;
        const wrongCount = cardData.wrongAnswers?.length ?? 0;

        // 2 options = easy, 4 = medium, 5+ = hard
        if (optionCount <= 2) return 1;
        if (optionCount <= 3) return 2;
        if (optionCount <= 4 && wrongCount <= 3) return 3;
        return 4;
    }
};

/**
 * True/False classifier — inherently simpler format
 */
const trueFalseClassifier: DifficultyClassifier = {
    cardType: 'trueFalse',
    classify(_cardData: any): number {
        return 1; // 50% chance of guessing correctly
    }
};

/**
 * Match pairs classifier
 * Factors: number of pairs to match
 */
const matchClassifier: DifficultyClassifier = {
    cardType: 'match',
    classify(cardData: any): number {
        const pairCount = cardData.matchPairs?.length ?? 0;
        if (pairCount <= 3) return 1;
        if (pairCount <= 5) return 2;
        if (pairCount <= 7) return 3;
        return 4;
    }
};

/**
 * Text/general classifier — fallback for simple recall cards
 * Factors: answer length (longer answers = more to remember)
 */
const textClassifier: DifficultyClassifier = {
    cardType: 'text',
    classify(cardData: any): number {
        const backLength = (cardData.back || '').length;

        if (backLength <= 20) return 1;   // single word/phrase
        if (backLength <= 80) return 2;   // short sentence
        if (backLength <= 200) return 3;  // paragraph
        if (backLength <= 500) return 4;  // detailed answer
        return 5;                          // essay-length
    }
};

/**
 * Registry that holds all classifiers and dispatches based on card type.
 */
class DifficultyClassifierRegistry {
    private classifiers = new Map<string, DifficultyClassifier>();

    register(classifier: DifficultyClassifier): void {
        this.classifiers.set(classifier.cardType, classifier);
    }

    /**
     * Classify a card's difficulty.
     * @param cardData - The card data (must have cardType or data to infer it)
     * @returns difficulty 1-5
     */
    classify(cardData: any): number {
        const cardType = cardData.cardType;
        if (!cardType) return 3; // no type known, use neutral default

        const classifier = this.classifiers.get(cardType);
        if (!classifier) return 3; // no classifier for this type

        const result = classifier.classify(cardData);
        return Math.max(1, Math.min(5, Math.round(result)));
    }
}

// Singleton registry with all built-in classifiers
export const difficultyRegistry = new DifficultyClassifierRegistry();
difficultyRegistry.register(chessOpeningClassifier);
difficultyRegistry.register(chessPuzzleClassifier);
difficultyRegistry.register(multipleChoiceClassifier);
difficultyRegistry.register(trueFalseClassifier);
difficultyRegistry.register(matchClassifier);
difficultyRegistry.register(textClassifier);
