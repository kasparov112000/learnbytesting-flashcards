import { UserProgress } from '../models';
import * as mongoose from 'mongoose';
import { FSRSService, Rating, State } from './fsrs.service';

export class UserProgressService {
    private fsrsService: FSRSService;

    constructor(fsrsOptions?: { requestRetention?: number; maximumInterval?: number }) {
        this.fsrsService = new FSRSService({
            requestRetention: fsrsOptions?.requestRetention || 0.9,
            maximumInterval: fsrsOptions?.maximumInterval || 365
        });
    }

    /**
     * Get or create progress for a user-flashcard pair
     */
    async getOrCreate(userId: string, flashcardId: string) {
        const flashcardObjectId = new mongoose.Types.ObjectId(flashcardId);

        let progress = await UserProgress.findOne({
            userId: userId,
            flashcardId: flashcardObjectId
        });

        if (!progress) {
            progress = new UserProgress({
                userId: userId,
                flashcardId: flashcardObjectId,
                algorithm: 'fsrs',  // Default to FSRS for new cards
                fsrsState: State.New,
                stability: 0,
                fsrsDifficulty: 0
            });
            await progress.save();
        }

        return progress;
    }

    /**
     * Process a review for a flashcard using FSRS or SM-2
     * @param userId - User ID
     * @param flashcardId - Flashcard ID
     * @param rating - Rating (1-4 for FSRS, 0-5 for SM-2)
     * @param responseTimeMs - Time taken to respond
     * @param useLegacyQuality - If true, treat rating as SM-2 quality (0-5) and convert
     */
    async processReview(
        userId: string,
        flashcardId: string,
        rating: number,
        responseTimeMs?: number,
        useLegacyQuality: boolean = false
    ) {
        const progress = await this.getOrCreate(userId, flashcardId);
        const now = new Date();

        // Determine which algorithm to use
        const algorithm = (progress as any).algorithm || 'fsrs';

        if (algorithm === 'fsrs') {
            // Convert legacy quality to FSRS rating if needed
            const fsrsRating = useLegacyQuality
                ? FSRSService.qualityToRating(rating)
                : FSRSService.getRating(rating);

            return this.processReviewFSRS(progress, fsrsRating, responseTimeMs, now);
        } else {
            // Legacy SM-2 processing
            return this.processReviewSM2(progress, rating, responseTimeMs);
        }
    }

    /**
     * Process review using FSRS algorithm
     */
    private async processReviewFSRS(
        progress: any,
        rating: Rating,
        responseTimeMs?: number,
        now?: Date
    ) {
        const reviewDate = now || new Date();
        const oldScheduledDays = progress.scheduled_days || 0;

        // Process through FSRS
        const result = this.fsrsService.processReview(progress, rating, reviewDate);
        const updatedFields = this.fsrsService.cardToProgressFields(result.card);

        // Store review in history
        progress.reviewHistory.push({
            date: reviewDate,
            quality: rating,  // Store FSRS rating (1-4)
            responseTimeMs,
            intervalBefore: oldScheduledDays,
            intervalAfter: result.card.scheduled_days,
            algorithm: 'fsrs'
        });

        // Update statistics
        progress.totalReviews = (progress.totalReviews || 0) + 1;
        if (rating >= Rating.Good) {
            progress.correctCount = (progress.correctCount || 0) + 1;
        } else {
            progress.incorrectCount = (progress.incorrectCount || 0) + 1;
        }

        // Update response time average
        if (responseTimeMs) {
            const prevTotal = (progress.averageResponseTime || 0) * (progress.totalReviews - 1);
            progress.averageResponseTime = (prevTotal + responseTimeMs) / progress.totalReviews;
        }

        // Apply FSRS updates
        Object.assign(progress, updatedFields);
        progress.algorithm = 'fsrs';
        progress.lastQuality = rating;

        // Update mastered state for high stability
        if (updatedFields.stability > 30 && updatedFields.scheduled_days > 21) {
            progress.state = 'mastered';
        }

        await progress.save();
        return progress;
    }

    /**
     * Process review using legacy SM-2 algorithm
     */
    private async processReviewSM2(progress: any, quality: number, responseTimeMs?: number) {
        // Use the SM-2 method defined on the schema
        (progress as any).processReview(quality, responseTimeMs);
        progress.algorithm = 'sm2';
        await progress.save();
        return progress;
    }

    /**
     * Get scheduling preview showing what each FSRS rating would do
     */
    async getSchedulingPreview(userId: string, flashcardId: string) {
        const progress = await this.getOrCreate(userId, flashcardId);
        return this.fsrsService.getSchedulingOptions(progress);
    }

    /**
     * Get retrievability (probability of recall) for a card
     */
    async getRetrievability(userId: string, flashcardId: string): Promise<number> {
        const progress = await this.getOrCreate(userId, flashcardId);
        return this.fsrsService.getRetrievability(progress);
    }

    /**
     * Get all progress records for a user
     */
    async getUserProgress(userId: string) {
        return await UserProgress.find({
            userId: userId
        }).populate('flashcardId');
    }

    /**
     * Get cards due for review
     * @param userId - User ID
     * @param limit - Maximum number of cards to return
     */
    async getDueCards(userId: string, limit: number = 20) {
        const now = new Date();

        return await UserProgress.find({
            userId: userId,
            nextReviewDate: { $lte: now },
            isSuspended: false
        })
        .sort({ nextReviewDate: 1 })
        .limit(limit)
        .populate('flashcardId');
    }

    /**
     * Get new cards (never reviewed)
     * @param userId - User ID
     * @param limit - Maximum number of cards
     */
    async getNewCards(userId: string, limit: number = 10) {
        return await UserProgress.find({
            userId: userId,
            state: 'new',
            isSuspended: false
        })
        .limit(limit)
        .populate('flashcardId');
    }

    /**
     * Get cards in learning state
     */
    async getLearningCards(userId: string, limit: number = 10) {
        return await UserProgress.find({
            userId: userId,
            state: { $in: ['learning', 'relearning'] },
            isSuspended: false
        })
        .sort({ nextReviewDate: 1 })
        .limit(limit)
        .populate('flashcardId');
    }

    /**
     * Get user's study statistics
     */
    async getUserStats(userId: string) {
        // State distribution
        const stateStats = await UserProgress.aggregate([
            { $match: { userId: userId } },
            {
                $group: {
                    _id: '$state',
                    count: { $sum: 1 }
                }
            }
        ]);

        // Due count
        const dueCount = await UserProgress.countDocuments({
            userId: userId,
            nextReviewDate: { $lte: new Date() },
            isSuspended: false
        });

        // Total cards
        const totalCards = await UserProgress.countDocuments({
            userId: userId
        });

        // Reviews today
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const todayStats = await UserProgress.aggregate([
            { $match: { userId: userId } },
            { $unwind: '$reviewHistory' },
            { $match: { 'reviewHistory.date': { $gte: startOfDay } } },
            {
                $group: {
                    _id: null,
                    reviewsToday: { $sum: 1 },
                    avgQuality: { $avg: '$reviewHistory.quality' },
                    correctToday: {
                        $sum: { $cond: [{ $gte: ['$reviewHistory.quality', 3] }, 1, 0] }
                    }
                }
            }
        ]);

        // Algorithm distribution
        const algorithmStats = await UserProgress.aggregate([
            { $match: { userId: userId } },
            {
                $group: {
                    _id: '$algorithm',
                    count: { $sum: 1 }
                }
            }
        ]);

        return {
            stateDistribution: stateStats.reduce((acc, s) => {
                acc[s._id] = s.count;
                return acc;
            }, {} as Record<string, number>),
            algorithmDistribution: algorithmStats.reduce((acc, s) => {
                acc[s._id || 'fsrs'] = s.count;
                return acc;
            }, {} as Record<string, number>),
            dueCount,
            totalCards,
            reviewsToday: todayStats[0]?.reviewsToday || 0,
            correctToday: todayStats[0]?.correctToday || 0,
            avgQualityToday: todayStats[0]?.avgQuality || 0
        };
    }

    /**
     * Suspend a card (stop showing it)
     */
    async suspendCard(userId: string, flashcardId: string) {
        return await UserProgress.findOneAndUpdate(
            {
                userId: userId,
                flashcardId: new mongoose.Types.ObjectId(flashcardId)
            },
            { $set: { isSuspended: true } },
            { new: true }
        );
    }

    /**
     * Unsuspend a card
     */
    async unsuspendCard(userId: string, flashcardId: string) {
        return await UserProgress.findOneAndUpdate(
            {
                userId: userId,
                flashcardId: new mongoose.Types.ObjectId(flashcardId)
            },
            { $set: { isSuspended: false } },
            { new: true }
        );
    }

    /**
     * Reset progress for a card (works for both FSRS and SM-2)
     */
    async resetCard(userId: string, flashcardId: string) {
        return await UserProgress.findOneAndUpdate(
            {
                userId: userId,
                flashcardId: new mongoose.Types.ObjectId(flashcardId)
            },
            {
                $set: {
                    // SM-2 fields
                    easinessFactor: 2.5,
                    repetitions: 0,
                    interval: 0,
                    // FSRS fields
                    stability: 0,
                    fsrsDifficulty: 0,
                    elapsed_days: 0,
                    scheduled_days: 0,
                    learning_steps: 0,
                    fsrsState: State.New,
                    // Common fields
                    nextReviewDate: new Date(),
                    state: 'new',
                    lapses: 0,
                    totalReviews: 0,
                    correctCount: 0,
                    incorrectCount: 0
                }
            },
            { new: true }
        );
    }

    /**
     * Initialize progress for multiple flashcards
     */
    async initializeForFlashcards(userId: string, flashcardIds: string[]) {
        const bulkOps = flashcardIds.map(flashcardId => ({
            updateOne: {
                filter: {
                    userId: userId,
                    flashcardId: new mongoose.Types.ObjectId(flashcardId)
                },
                update: {
                    $setOnInsert: {
                        userId: userId,
                        flashcardId: new mongoose.Types.ObjectId(flashcardId),
                        // SM-2 fields (for backward compatibility)
                        easinessFactor: 2.5,
                        repetitions: 0,
                        interval: 0,
                        // FSRS fields
                        algorithm: 'fsrs',
                        stability: 0,
                        fsrsDifficulty: 0,
                        elapsed_days: 0,
                        scheduled_days: 0,
                        learning_steps: 0,
                        fsrsState: State.New,
                        // Common fields
                        nextReviewDate: new Date(),
                        state: 'new'
                    }
                },
                upsert: true
            }
        }));

        return await UserProgress.bulkWrite(bulkOps);
    }

    /**
     * Migrate a card from SM-2 to FSRS
     */
    async migrateToFSRS(userId: string, flashcardId: string) {
        const progress = await this.getOrCreate(userId, flashcardId);

        if ((progress as any).algorithm === 'fsrs') {
            return progress;  // Already using FSRS
        }

        // Convert SM-2 easiness factor to FSRS difficulty
        // EF range: 1.3-2.5 -> D range: 1-10 (inverted, higher EF = lower difficulty)
        const ef = (progress as any).easinessFactor || 2.5;
        const difficulty = Math.round(10 - ((ef - 1.3) / 1.2) * 9);

        // Estimate stability from interval
        const stability = (progress as any).interval || 0;

        // Map state
        const fsrsState = this.fsrsService.legacyStateToFsrsState((progress as any).state || 'new');

        const updated = await UserProgress.findOneAndUpdate(
            {
                userId: userId,
                flashcardId: new mongoose.Types.ObjectId(flashcardId)
            },
            {
                $set: {
                    algorithm: 'fsrs',
                    stability,
                    fsrsDifficulty: Math.max(1, Math.min(10, difficulty)),
                    fsrsState,
                    elapsed_days: 0,
                    scheduled_days: (progress as any).interval || 0,
                    learning_steps: 0
                }
            },
            { new: true }
        );

        console.log('[UserProgressService] Migrated card to FSRS:', {
            flashcardId,
            oldEF: ef,
            newDifficulty: difficulty,
            stability,
            fsrsState: State[fsrsState]
        });

        return updated;
    }
}
