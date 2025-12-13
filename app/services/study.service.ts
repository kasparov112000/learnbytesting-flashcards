import { FlashcardService } from './flashcard.service';
import { UserProgressService } from './user-progress.service';
import { UserProgress } from '../models';

/**
 * Study session configuration
 */
interface StudySessionConfig {
    newCardsLimit?: number;      // Max new cards per session
    reviewCardsLimit?: number;   // Max review cards per session
    learningFirst?: boolean;     // Prioritize learning cards
}

/**
 * StudyService - Orchestrates study sessions combining flashcards and progress
 */
export class StudyService {
    private flashcardService: FlashcardService;
    private userProgressService: UserProgressService;

    constructor(flashcardService: FlashcardService, userProgressService: UserProgressService) {
        this.flashcardService = flashcardService;
        this.userProgressService = userProgressService;
    }

    /**
     * Get cards for a study session
     * Returns a mix of due cards, learning cards, and new cards
     */
    async getStudySession(userId: string, config: StudySessionConfig = {}) {
        const {
            newCardsLimit = 10,
            reviewCardsLimit = 20,
            learningFirst = true
        } = config;

        // Get learning cards first (highest priority)
        const learningCards = await this.userProgressService.getLearningCards(userId, 10);

        // Get due review cards
        const dueCards = await this.userProgressService.getDueCards(userId, reviewCardsLimit);

        // Get new cards if we have room
        const newCards = await this.userProgressService.getNewCards(userId, newCardsLimit);

        // Build the session queue
        let sessionCards: any[] = [];

        if (learningFirst) {
            sessionCards = [...learningCards, ...dueCards, ...newCards];
        } else {
            sessionCards = [...dueCards, ...learningCards, ...newCards];
        }

        // Get stats
        const stats = await this.userProgressService.getUserStats(userId);

        return {
            cards: sessionCards,
            totalDue: stats.dueCount,
            learningCount: learningCards.length,
            newCount: newCards.length,
            reviewCount: dueCards.length,
            stats
        };
    }

    /**
     * Start a new study session for a category
     * Initializes progress for all flashcards in the category
     */
    async startCategorySession(userId: string, categoryId: string) {
        // Get all flashcards in the category
        const flashcards = await this.flashcardService.getByCategory(categoryId);

        // Initialize progress for all cards
        const flashcardIds = flashcards.map(f => (f as any)._id.toString());
        await this.userProgressService.initializeForFlashcards(userId, flashcardIds);

        // Return study session
        return await this.getStudySession(userId);
    }

    /**
     * Start a study session for a specific question
     * Gets all flashcards linked to the question
     */
    async startQuestionSession(userId: string, questionId: string) {
        // Get flashcards for this question
        const flashcards = await this.flashcardService.getByQuestionId(questionId);

        // Initialize progress
        const flashcardIds = flashcards.map(f => (f as any)._id.toString());
        await this.userProgressService.initializeForFlashcards(userId, flashcardIds);

        // Return the flashcards with their progress
        const progress = await this.userProgressService.getUserProgress(userId);
        const progressMap = new Map(progress.map(p => [(p as any).flashcardId._id.toString(), p]));

        return flashcards.map(flashcard => ({
            flashcard,
            progress: progressMap.get((flashcard as any)._id.toString())
        }));
    }

    /**
     * Submit an answer for a flashcard
     */
    async submitAnswer(userId: string, flashcardId: string, quality: number, responseTimeMs?: number) {
        // Process the review
        const progress = await this.userProgressService.processReview(
            userId,
            flashcardId,
            quality,
            responseTimeMs
        );

        // Get the next card
        const session = await this.getStudySession(userId, {
            newCardsLimit: 1,
            reviewCardsLimit: 5
        });

        return {
            reviewedCard: progress,
            nextCard: session.cards[0] || null,
            remainingCards: session.cards.length,
            stats: session.stats
        };
    }

    /**
     * Get daily study forecast
     * Shows how many cards will be due in upcoming days
     */
    async getDailyForecast(userId: string, days: number = 7) {
        const forecast: { date: string; count: number }[] = [];

        for (let i = 0; i < days; i++) {
            const date = new Date();
            date.setDate(date.getDate() + i);
            date.setHours(23, 59, 59, 999);

            const startOfDay = new Date(date);
            startOfDay.setHours(0, 0, 0, 0);

            const count = await UserProgress.countDocuments({
                userId: userId,
                nextReviewDate: { $lte: date, $gte: startOfDay },
                isSuspended: false
            });

            forecast.push({
                date: date.toISOString().split('T')[0],
                count
            });
        }

        return forecast;
    }
}
