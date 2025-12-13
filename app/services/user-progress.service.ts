import { UserProgress } from '../models';
import * as mongoose from 'mongoose';

export class UserProgressService {
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
                flashcardId: flashcardObjectId
            });
            await progress.save();
        }

        return progress;
    }

    /**
     * Process a review for a flashcard
     * @param userId - User ID
     * @param flashcardId - Flashcard ID
     * @param quality - Quality rating 0-5
     * @param responseTimeMs - Time taken to respond
     */
    async processReview(userId: string, flashcardId: string, quality: number, responseTimeMs?: number) {
        const progress = await this.getOrCreate(userId, flashcardId);

        // Use the SM-2 method defined on the schema
        (progress as any).processReview(quality, responseTimeMs);

        await progress.save();
        return progress;
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

        return {
            stateDistribution: stateStats.reduce((acc, s) => {
                acc[s._id] = s.count;
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
     * Reset progress for a card
     */
    async resetCard(userId: string, flashcardId: string) {
        return await UserProgress.findOneAndUpdate(
            {
                userId: userId,
                flashcardId: new mongoose.Types.ObjectId(flashcardId)
            },
            {
                $set: {
                    easinessFactor: 2.5,
                    repetitions: 0,
                    interval: 0,
                    nextReviewDate: new Date(),
                    state: 'new',
                    lapses: 0
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
                        easinessFactor: 2.5,
                        repetitions: 0,
                        interval: 0,
                        nextReviewDate: new Date(),
                        state: 'new'
                    }
                },
                upsert: true
            }
        }));

        return await UserProgress.bulkWrite(bulkOps);
    }
}
