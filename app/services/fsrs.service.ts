import {
    FSRS,
    createEmptyCard,
    Rating,
    State,
    Card,
    RecordLogItem,
    generatorParameters,
    FSRSParameters,
    Grade
} from 'ts-fsrs';

export interface FSRSServiceOptions {
    requestRetention?: number;  // Target retention rate (0.7-0.97), default 0.9
    maximumInterval?: number;   // Maximum interval in days, default 365
    enableFuzz?: boolean;       // Add randomness to intervals, default true
}

export interface SchedulePreview {
    again: { interval: string; intervalDays: number; due: Date };
    hard: { interval: string; intervalDays: number; due: Date };
    good: { interval: string; intervalDays: number; due: Date };
    easy: { interval: string; intervalDays: number; due: Date };
}

/**
 * FSRSService - Wrapper for ts-fsrs library
 * Provides spaced repetition scheduling using the FSRS algorithm
 */
export class FSRSService {
    private scheduler: FSRS;
    private params: FSRSParameters;

    constructor(options?: FSRSServiceOptions) {
        this.params = generatorParameters({
            request_retention: options?.requestRetention || 0.9,  // 90% target retention
            maximum_interval: options?.maximumInterval || 365,    // Max 1 year interval
            enable_fuzz: options?.enableFuzz !== false,           // Add randomness by default
            enable_short_term: true                               // Enable learning steps
        });
        this.scheduler = new FSRS(this.params);

        console.log('[FSRSService] Initialized with params:', {
            requestRetention: this.params.request_retention,
            maximumInterval: this.params.maximum_interval,
            enableFuzz: this.params.enable_fuzz
        });
    }

    /**
     * Create a new empty card for FSRS
     */
    createCard(now?: Date): Card {
        return createEmptyCard(now || new Date());
    }

    /**
     * Convert UserProgress document to FSRS Card
     */
    progressToCard(progress: any): Card {
        return {
            due: progress.nextReviewDate || new Date(),
            stability: progress.stability || 0,
            difficulty: progress.fsrsDifficulty || 0,
            elapsed_days: progress.elapsed_days || 0,
            scheduled_days: progress.scheduled_days || 0,
            learning_steps: progress.learning_steps || 0,
            reps: progress.totalReviews || 0,
            lapses: progress.lapses || 0,
            state: progress.fsrsState ?? State.New,
            last_review: progress.lastReviewDate
        };
    }

    /**
     * Convert FSRS Card back to UserProgress fields
     */
    cardToProgressFields(card: Card): any {
        return {
            nextReviewDate: card.due,
            stability: card.stability,
            fsrsDifficulty: card.difficulty,
            elapsed_days: card.elapsed_days,
            scheduled_days: card.scheduled_days,
            learning_steps: card.learning_steps,
            lapses: card.lapses,
            fsrsState: card.state,
            lastReviewDate: card.last_review,
            // Map FSRS state to existing state field for compatibility
            state: this.fsrsStateToLegacyState(card.state),
            // Keep interval field updated for compatibility
            interval: card.scheduled_days
        };
    }

    /**
     * Map FSRS State enum to legacy state strings
     */
    fsrsStateToLegacyState(fsrsState: State): string {
        switch (fsrsState) {
            case State.New: return 'new';
            case State.Learning: return 'learning';
            case State.Review: return 'review';
            case State.Relearning: return 'relearning';
            default: return 'new';
        }
    }

    /**
     * Map legacy state string to FSRS State enum
     */
    legacyStateToFsrsState(legacyState: string): State {
        switch (legacyState) {
            case 'new': return State.New;
            case 'learning': return State.Learning;
            case 'review': return State.Review;
            case 'relearning': return State.Relearning;
            case 'mastered': return State.Review;  // Mastered is just a long-interval review
            default: return State.New;
        }
    }

    /**
     * Process a review and return the updated card
     * @param progress - Current UserProgress document
     * @param rating - FSRS Rating (1=Again, 2=Hard, 3=Good, 4=Easy)
     * @param now - Review timestamp
     */
    processReview(progress: any, rating: Rating, now?: Date): RecordLogItem {
        const card = this.progressToCard(progress);
        const reviewDate = now || new Date();
        // Cast to Grade (excludes Rating.Manual which is 0)
        const grade = rating as Grade;
        const result = this.scheduler.next(card, reviewDate, grade);

        console.log('[FSRSService] Review processed:', {
            rating: Rating[rating],
            oldState: State[card.state],
            newState: State[result.card.state],
            oldStability: card.stability,
            newStability: result.card.stability,
            scheduledDays: result.card.scheduled_days,
            nextDue: result.card.due
        });

        return result;
    }

    /**
     * Get all possible scheduling outcomes for a card
     * Useful for showing user what each rating would do
     */
    getSchedulingOptions(progress: any, now?: Date): SchedulePreview {
        const card = this.progressToCard(progress);
        const reviewDate = now || new Date();
        const options = this.scheduler.repeat(card, reviewDate);

        return {
            again: {
                interval: FSRSService.formatInterval(options[Rating.Again].card.scheduled_days),
                intervalDays: options[Rating.Again].card.scheduled_days,
                due: options[Rating.Again].card.due
            },
            hard: {
                interval: FSRSService.formatInterval(options[Rating.Hard].card.scheduled_days),
                intervalDays: options[Rating.Hard].card.scheduled_days,
                due: options[Rating.Hard].card.due
            },
            good: {
                interval: FSRSService.formatInterval(options[Rating.Good].card.scheduled_days),
                intervalDays: options[Rating.Good].card.scheduled_days,
                due: options[Rating.Good].card.due
            },
            easy: {
                interval: FSRSService.formatInterval(options[Rating.Easy].card.scheduled_days),
                intervalDays: options[Rating.Easy].card.scheduled_days,
                due: options[Rating.Easy].card.due
            }
        };
    }

    /**
     * Calculate retrievability (probability of recall) for a card
     * @param progress - UserProgress document
     * @param now - Current time
     * @returns Probability of recall (0-1)
     */
    getRetrievability(progress: any, now?: Date): number {
        const card = this.progressToCard(progress);
        if (card.state === State.New || card.stability === 0) {
            return 0;
        }

        const currentDate = now || new Date();
        const lastReview = card.last_review || currentDate;
        const elapsedDays = (currentDate.getTime() - lastReview.getTime()) / (1000 * 60 * 60 * 24);

        // FSRS retrievability formula: R = (1 + FACTOR * t/S)^DECAY
        // where FACTOR = 19/81, DECAY = -0.5
        const FACTOR = 19 / 81;
        const DECAY = -0.5;
        const retrievability = Math.pow(1 + FACTOR * elapsedDays / card.stability, DECAY);

        return Math.max(0, Math.min(1, retrievability));
    }

    /**
     * Convert legacy SM-2 quality (0-5) to FSRS Rating (1-4)
     */
    static qualityToRating(quality: number): Rating {
        if (quality <= 2) return Rating.Again;  // 0, 1, 2 -> Again (failed)
        if (quality === 3) return Rating.Hard;   // 3 -> Hard
        if (quality === 4) return Rating.Good;   // 4 -> Good
        return Rating.Easy;                       // 5 -> Easy
    }

    /**
     * Convert FSRS Rating to display name
     */
    static ratingToName(rating: Rating): string {
        switch (rating) {
            case Rating.Again: return 'Again';
            case Rating.Hard: return 'Hard';
            case Rating.Good: return 'Good';
            case Rating.Easy: return 'Easy';
            default: return 'Unknown';
        }
    }

    /**
     * Get human-readable interval string
     */
    static formatInterval(days: number): string {
        if (days < 1 / 24 / 60) {
            // Less than a minute
            return '<1m';
        }
        if (days < 1 / 24) {
            // Less than an hour - show minutes
            const minutes = Math.round(days * 24 * 60);
            return `${minutes}m`;
        }
        if (days < 1) {
            // Less than a day - show hours
            const hours = Math.round(days * 24);
            return `${hours}h`;
        }
        if (days < 30) {
            // Less than a month - show days
            return `${Math.round(days)}d`;
        }
        if (days < 365) {
            // Less than a year - show months
            const months = Math.round(days / 30);
            return `${months}mo`;
        }
        // Show years
        const years = (days / 365).toFixed(1);
        return `${years}y`;
    }

    /**
     * Get Rating enum value from number
     */
    static getRating(value: number): Rating {
        switch (value) {
            case 1: return Rating.Again;
            case 2: return Rating.Hard;
            case 3: return Rating.Good;
            case 4: return Rating.Easy;
            default: return Rating.Again;
        }
    }

    /**
     * Validate that a rating value is valid for FSRS
     */
    static isValidRating(rating: number): boolean {
        return rating >= 1 && rating <= 4 && Number.isInteger(rating);
    }
}

// Export Rating and State enums for use by other services
export { Rating, State };
