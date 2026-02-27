import { StudySession } from '../models/study-session.model';
import { DailyActivity } from '../models/daily-activity.model';
import { UserAnalytics } from '../models/user-analytics.model';
import { UserProgress, Flashcard } from '../models';
import axios from 'axios';
import mongoose from 'mongoose';

/**
 * AnalyticsService - Handles all analytics calculations and data aggregation
 */
export class AnalyticsService {

    /**
     * Get dashboard summary for a user
     * @param userId User ID
     * @param categoryId Optional category ID to filter by
     */
    async getSummary(userId: string, categoryId?: string) {
        // Get or create user analytics
        const analytics = await (UserAnalytics as any).getOrCreate(userId);

        // Get current streak (category-specific if categoryId provided)
        const streakData = await (DailyActivity as any).calculateStreak(userId, categoryId);

        // Update streak in analytics if changed (only for global analytics)
        if (!categoryId && streakData.currentStreak !== analytics.currentStreak) {
            analytics.currentStreak = streakData.currentStreak;
            analytics.lastStudyDate = streakData.lastStudyDate;
            if (streakData.currentStreak > analytics.longestStreak) {
                analytics.longestStreak = streakData.currentStreak;
            }
            await analytics.save();
        }

        // Get today's activity
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const todayQuery: any = { userId, date: today };
        const todayActivity = await DailyActivity.findOne(todayQuery);

        // Build query filter for category using hierarchical filtering via flashcard IDs
        let flashcardIds: any[] | null = null;
        if (categoryId) {
            // Get all flashcard IDs that belong to this category hierarchy
            const flashcards = await Flashcard.find(
                { categoryIds: categoryId, isActive: { $ne: false } },
                { _id: 1 }
            ).lean();
            flashcardIds = flashcards.map((f: any) => f._id);
        }

        // Build query for user progress, optionally filtered by flashcard IDs
        const cardQuery: any = { userId };
        if (flashcardIds !== null) {
            cardQuery.flashcardId = { $in: flashcardIds };
        }

        // Get total cards in system for this user (filtered by category if provided)
        const totalCards = await UserProgress.countDocuments(cardQuery);

        // Get mastered cards (stability >= 21 days)
        const masteredQuery = { ...cardQuery, stability: { $gte: 21 } };
        const masteredCards = await UserProgress.countDocuments(masteredQuery);

        // Get new cards (state = 'new' or fsrsState = 0)
        const newCardsQuery = { ...cardQuery, $or: [{ state: 'new' }, { fsrsState: 0 }] };
        const newCards = await UserProgress.countDocuments(newCardsQuery);

        // Get studying cards (not new and not mastered)
        const studyingCards = totalCards - masteredCards - newCards;

        // Get cards due for review (nextReviewDate <= now)
        const now = new Date();
        const dueCardsQuery = { ...cardQuery, nextReviewDate: { $lte: now }, isSuspended: { $ne: true } };
        const dueCards = await UserProgress.countDocuments(dueCardsQuery);

        // Calculate category-specific today progress if categoryId provided
        let todayStats = {
            cardsReviewed: 0,
            studyTimeMinutes: 0,
            accuracy: 0,
            goalProgress: 0
        };

        if (todayActivity) {
            if (categoryId) {
                // Get category-specific stats from today's activity
                const catStats = todayActivity.categories?.find(
                    (c: any) => c.categoryId === categoryId
                );
                if (catStats) {
                    todayStats = {
                        cardsReviewed: catStats.count || 0,
                        studyTimeMinutes: Math.round((catStats.studyTimeMs || 0) / 60000),
                        accuracy: catStats.count > 0 && catStats.correctCount !== undefined
                            ? Math.round((catStats.correctCount / catStats.count) * 100)
                            : 0,
                        goalProgress: analytics.dailyGoal > 0
                            ? Math.min(100, Math.round(((catStats.count || 0) / analytics.dailyGoal) * 100))
                            : 0
                    };
                }
            } else {
                todayStats = {
                    cardsReviewed: todayActivity.cardsReviewed,
                    studyTimeMinutes: Math.round(todayActivity.studyTimeMs / 60000),
                    accuracy: todayActivity.getAccuracy(),
                    goalProgress: analytics.dailyGoal > 0
                        ? Math.min(100, Math.round((todayActivity.cardsReviewed / analytics.dailyGoal) * 100))
                        : 0
                };
            }
        }

        // Get category-specific total reviews if categoryId provided
        let totalReviews = analytics.totalCardsReviewed;
        let studyHours = Math.round((analytics.totalStudyTimeMs / 3600000) * 10) / 10;
        let ratingDistribution = analytics.ratingDistribution;

        if (categoryId) {
            // Aggregate category-specific stats from daily activities
            const categoryAggregation = await DailyActivity.aggregate([
                { $match: { userId } },
                { $unwind: '$categories' },
                { $match: { 'categories.categoryId': categoryId } },
                {
                    $group: {
                        _id: null,
                        totalReviews: { $sum: '$categories.count' },
                        totalTimeMs: { $sum: '$categories.studyTimeMs' }
                    }
                }
            ]);

            if (categoryAggregation.length > 0) {
                totalReviews = categoryAggregation[0].totalReviews || 0;
                studyHours = Math.round(((categoryAggregation[0].totalTimeMs || 0) / 3600000) * 10) / 10;
            } else {
                totalReviews = 0;
                studyHours = 0;
            }
        }

        return {
            currentStreak: streakData.currentStreak,
            longestStreak: categoryId ? streakData.currentStreak : analytics.longestStreak,
            lastStudyDate: streakData.lastStudyDate || analytics.lastStudyDate,
            totalCards: totalCards,
            masteredCards: masteredCards,
            newCards: newCards,
            studyingCards: studyingCards,
            dueCards: dueCards,
            totalReviews: totalReviews,
            studyHours: studyHours,
            hoursStudied: studyHours,  // Alias for frontend compatibility
            cardsToday: todayStats.cardsReviewed,
            averageRetention: categoryId ? 0 : analytics.getOverallAccuracy(),  // Accuracy as retention metric
            overallAccuracy: categoryId ? 0 : analytics.getOverallAccuracy(),
            overallMastery: totalCards > 0
                ? Math.round((masteredCards / totalCards) * 1000) / 10
                : 0,
            dailyGoal: analytics.dailyGoal,
            todayProgress: todayStats,
            ratingDistribution: ratingDistribution,
            bestRecords: {
                streak: analytics.bestStreak,
                dailyCards: analytics.bestDailyCards,
                accuracy: analytics.bestAccuracyDay
            }
        };
    }

    /**
     * Get mastery trend over time (for line chart)
     * @param userId User ID
     * @param days Number of days to include
     * @param categoryId Optional category ID to filter by
     */
    async getMasteryTrend(userId: string, days: number = 30, categoryId?: string) {
        const endDate = new Date();
        endDate.setUTCHours(23, 59, 59, 999);

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        startDate.setUTCHours(0, 0, 0, 0);

        // Get daily activity for the period
        const activities = await DailyActivity.find({
            userId,
            date: { $gte: startDate, $lte: endDate }
        }).sort({ date: 1 });

        // Get mastery snapshots by calculating cumulative progress
        const trend: {
            date: string;
            masteryPercent: number;
            cardsReviewed: number;
            accuracy: number;
        }[] = [];

        // Get current total cards (filtered by category if provided)
        // Use flashcard IDs for hierarchical filtering via Flashcard model
        let flashcardIds: any[] | null = null;
        if (categoryId) {
            const flashcards = await Flashcard.find(
                { categoryIds: categoryId, isActive: { $ne: false } },
                { _id: 1 }
            ).lean();
            flashcardIds = flashcards.map((f: any) => f._id);
        }

        const cardQuery: any = { userId };
        if (flashcardIds !== null) {
            cardQuery.flashcardId = { $in: flashcardIds };
        }
        const totalCards = await UserProgress.countDocuments(cardQuery);

        // For each day in the range, calculate the mastery at that point
        // This is an approximation based on cumulative reviews
        let cumulativeCorrect = 0;
        let cumulativeTotal = 0;

        for (const activity of activities) {
            let dayCorrect = activity.correctCount;
            let dayTotal = activity.cardsReviewed;

            // If filtering by category, get category-specific stats
            if (categoryId && activity.categories) {
                const catStats = activity.categories.find((c: any) => c.categoryId === categoryId);
                if (catStats) {
                    dayCorrect = catStats.correctCount || 0;
                    dayTotal = catStats.count || 0;
                } else {
                    dayCorrect = 0;
                    dayTotal = 0;
                }
            }

            cumulativeCorrect += dayCorrect;
            cumulativeTotal += dayTotal;

            const accuracy = cumulativeTotal > 0
                ? Math.round((cumulativeCorrect / cumulativeTotal) * 1000) / 10
                : 0;

            // Estimate mastery based on cumulative reviews and accuracy
            // This is a simplified estimation
            const estimatedMastery = Math.min(
                100,
                Math.round((cumulativeTotal * accuracy / (totalCards || 1)) / 10)
            );

            trend.push({
                date: (activity.date as Date).toISOString().split('T')[0],
                masteryPercent: estimatedMastery,
                cardsReviewed: dayTotal,
                accuracy
            });
        }

        return trend;
    }

    /**
     * Get category statistics
     * @param userId User ID
     * @param parentCategoryId Optional parent category ID to filter subcategories
     */
    async getCategoryStats(userId: string, parentCategoryId?: string) {
        // Build match query - use flashcard IDs for hierarchical filtering
        const matchQuery: any = { userId };
        if (parentCategoryId) {
            // Get all flashcard IDs that belong to this category hierarchy
            const flashcards = await Flashcard.find(
                { categoryIds: parentCategoryId, isActive: { $ne: false } },
                { _id: 1 }
            ).lean();
            const flashcardIds = flashcards.map((f: any) => f._id);
            matchQuery.flashcardId = { $in: flashcardIds };
        }

        // Get all user progress grouped by category
        const progressByCategory = await UserProgress.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: '$category',
                    cardsTotal: { $sum: 1 },
                    cardsMastered: {
                        $sum: { $cond: [{ $gte: ['$stability', 21] }, 1, 0] }
                    },
                    cardsLearning: {
                        $sum: { $cond: [
                            { $and: [
                                { $gt: ['$stability', 0] },
                                { $lt: ['$stability', 21] }
                            ]},
                            1,
                            0
                        ]}
                    },
                    cardsNew: {
                        $sum: { $cond: [{ $eq: ['$state', 0] }, 1, 0] }
                    },
                    totalReviews: { $sum: '$totalReviews' },
                    correctCount: { $sum: '$correctCount' },
                    avgStability: { $avg: '$stability' }
                }
            }
        ]);

        // Fetch category names
        const categories = progressByCategory.map(cat => ({
            categoryId: cat._id || 'uncategorized',
            categoryName: cat._id || 'Uncategorized',  // Would need to join with categories
            cardsTotal: cat.cardsTotal,
            cardsMastered: cat.cardsMastered,
            cardsLearning: cat.cardsLearning,
            cardsNew: cat.cardsNew,
            masteryPercent: cat.cardsTotal > 0
                ? Math.round((cat.cardsMastered / cat.cardsTotal) * 1000) / 10
                : 0,
            accuracy: cat.totalReviews > 0
                ? Math.round((cat.correctCount / cat.totalReviews) * 1000) / 10
                : 0,
            averageStability: Math.round((cat.avgStability || 0) * 10) / 10
        }));

        return categories;
    }

    /**
     * Get streak information
     */
    async getStreak(userId: string) {
        const currentStreakData = await (DailyActivity as any).calculateStreak(userId);
        const longestStreak = await (DailyActivity as any).getLongestStreak(userId);

        return {
            current: currentStreakData.currentStreak,
            longest: longestStreak,
            lastStudyDate: currentStreakData.lastStudyDate,
            isActiveToday: currentStreakData.currentStreak > 0 &&
                currentStreakData.lastStudyDate &&
                this.isToday(new Date(currentStreakData.lastStudyDate))
        };
    }

    /**
     * Get heatmap data (GitHub-style activity)
     * @param userId User ID
     * @param months Number of months to include
     * @param categoryId Optional category ID to filter by
     */
    async getHeatmapData(userId: string, months: number = 12, categoryId?: string) {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - months);
        startDate.setUTCHours(0, 0, 0, 0);

        const activities = await (DailyActivity as any).getActivityRange(userId, startDate, endDate);

        // Create a map of date -> activity level (0-4)
        const heatmapData: {
            date: string;
            count: number;
            level: number;
        }[] = [];

        // Build activity map, filtering by category if provided
        const activityMap = new Map<string, number>();
        let maxCards = 1;

        for (const activity of activities) {
            const dateStr = (activity.date as Date).toISOString().split('T')[0];
            let count = activity.cardsReviewed;

            // If filtering by category, get category-specific count
            if (categoryId && activity.categories) {
                const catStats = activity.categories.find((c: any) => c.categoryId === categoryId);
                count = catStats?.count || 0;
            }

            activityMap.set(dateStr, count);
            if (count > maxCards) {
                maxCards = count;
            }
        }

        // Fill in all days in the range
        const currentDate = new Date(startDate);

        while (currentDate <= endDate) {
            const dateStr = currentDate.toISOString().split('T')[0];
            const count = activityMap.get(dateStr) || 0;

            // Calculate level (0-4) based on activity
            let level = 0;
            if (count > 0) {
                const ratio = count / maxCards;
                if (ratio >= 0.75) level = 4;
                else if (ratio >= 0.5) level = 3;
                else if (ratio >= 0.25) level = 2;
                else level = 1;
            }

            heatmapData.push({
                date: dateStr,
                count,
                level
            });

            currentDate.setDate(currentDate.getDate() + 1);
        }

        return heatmapData;
    }

    /**
     * Get weekly summary
     */
    async getWeeklySummary(userId: string, weeks: number = 12) {
        return await (DailyActivity as any).getWeeklySummary(userId, weeks);
    }

    /**
     * Start a new study session
     */
    async startSession(userId: string, sessionType: string = 'all', targetCategoryId?: string) {
        const session = new StudySession({
            userId,
            sessionType,
            targetCategoryId,
            startTime: new Date(),
            status: 'active'
        });

        await session.save();

        return {
            sessionId: (session as any)._id.toString(),
            startTime: session.startTime
        };
    }

    /**
     * End a study session and calculate final stats
     */
    async endSession(sessionId: string) {
        const session = await StudySession.findById(sessionId);

        if (!session) {
            throw new Error('Session not found');
        }

        // End the session
        (session as any).endSession();
        await session.save();

        // Update user analytics with session data
        await (UserAnalytics as any).recordSession(session.userId, {
            cardsReviewed: session.cardsReviewed,
            correctCount: session.cardsCorrect,
            incorrectCount: session.cardsFailed,
            durationMs: session.durationMs,
            newCardsLearned: session.newCardsLearned,
            ratingDistribution: session.ratingDistribution
        });

        // Update daily activity
        const dailyActivity = await (DailyActivity as any).getOrCreateToday(session.userId);
        (dailyActivity as any).addSessionTime(session.durationMs);
        await dailyActivity.save();

        // Update streak
        const streakData = await (DailyActivity as any).calculateStreak(session.userId);
        await (UserAnalytics as any).updateStreak(
            session.userId,
            streakData.currentStreak,
            streakData.lastStudyDate
        );

        return (session as any).getStats();
    }

    /**
     * Record a review within a session
     */
    async recordReview(
        sessionId: string,
        quality: number,
        responseTimeMs: number,
        categoryId?: string,
        categoryName?: string,
        isNewCard: boolean = false,
        weaknessTagData?: Array<{ tagId: string; tagType: string; tagSpecific: string }>
    ) {
        // Update session
        const session = await StudySession.findById(sessionId);
        if (session) {
            (session as any).recordReview(quality, responseTimeMs, categoryId, isNewCard);
            await session.save();
        }

        // Update daily activity
        const userId = session?.userId;
        if (userId) {
            const dailyActivity = await (DailyActivity as any).getOrCreateToday(userId);
            (dailyActivity as any).recordReview(quality, responseTimeMs, categoryId, categoryName, isNewCard, weaknessTagData);
            await dailyActivity.save();
        }

        return { success: true, userId: userId || null };
    }

    /**
     * Get session history for a user
     */
    async getSessionHistory(userId: string, limit: number = 10) {
        const sessions = await StudySession.find({
            userId,
            status: 'completed'
        })
        .sort({ startTime: -1 })
        .limit(limit);

        return sessions.map(session => ({
            id: (session as any)._id.toString(),
            startTime: session.startTime,
            endTime: session.endTime,
            durationMinutes: Math.round(session.durationMs / 60000),
            cardsReviewed: session.cardsReviewed,
            accuracy: session.cardsReviewed > 0
                ? Math.round((session.cardsCorrect / session.cardsReviewed) * 1000) / 10
                : 0,
            sessionType: session.sessionType
        }));
    }

    /**
     * Set daily goal for a user
     */
    async setDailyGoal(userId: string, goal: number) {
        const analytics = await (UserAnalytics as any).getOrCreate(userId);
        analytics.dailyGoal = goal;
        await analytics.save();

        return { dailyGoal: goal };
    }

    /**
     * Get upcoming review forecast
     * @param userId User ID
     * @param days Number of days to forecast
     * @param categoryId Optional category ID to filter by
     */
    async getForecast(userId: string, days: number = 7, categoryId?: string) {
        const forecast: { date: string; count: number }[] = [];

        // Get flashcard IDs for category filter (once, before the loop)
        let flashcardIds: any[] | null = null;
        if (categoryId) {
            const flashcards = await Flashcard.find(
                { categoryIds: categoryId, isActive: { $ne: false } },
                { _id: 1 }
            ).lean();
            flashcardIds = flashcards.map((f: any) => f._id);
        }

        for (let i = 0; i < days; i++) {
            const date = new Date();
            date.setDate(date.getDate() + i);
            date.setHours(23, 59, 59, 999);

            const startOfDay = new Date(date);
            startOfDay.setHours(0, 0, 0, 0);

            // Build query with optional category filter - use flashcard IDs for hierarchical filtering
            const query: any = {
                userId: userId,
                nextReviewDate: { $lte: date, $gte: startOfDay },
                isSuspended: false
            };

            if (flashcardIds !== null) {
                query.flashcardId = { $in: flashcardIds };
            }

            const count = await UserProgress.countDocuments(query);

            forecast.push({
                date: date.toISOString().split('T')[0],
                count
            });
        }

        return forecast;
    }

    /**
     * Get weakness tag statistics for a user
     * @param userId User ID
     * @param tagType Optional filter by weakness type (e.g., 'endgame', 'tactics')
     */
    async getWeaknessTagStats(userId: string, tagType?: string) {
        // Build match query for flashcards with weakness tags belonging to this user
        // Note: userId can be email or MongoDB ObjectId, so check all user fields
        const flashcardMatch: any = {
            weaknessTags: { $exists: true, $ne: [] },
            weaknessTagData: { $exists: true, $ne: [] },
            isActive: { $ne: false },
            $or: [
                { users: userId },
                { createdBy: userId },
                { userEmail: userId }  // Also check userEmail field (for email-based lookups)
            ]
        };

        // Start from Flashcard collection and LEFT JOIN to UserProgress
        // This ensures we count flashcards even if they haven't been reviewed yet
        const progressByTag = await Flashcard.aggregate([
            { $match: flashcardMatch },
            { $unwind: '$weaknessTagData' },
            ...(tagType ? [{ $match: { 'weaknessTagData.type': tagType } }] : []),
            {
                $lookup: {
                    from: 'userprogresses',
                    let: { flashcardId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$flashcardId', '$$flashcardId'] },
                                        { $eq: ['$userId', userId] }
                                    ]
                                }
                            }
                        }
                    ],
                    as: 'progress'
                }
            },
            {
                $addFields: {
                    progressData: { $arrayElemAt: ['$progress', 0] }
                }
            },
            {
                $group: {
                    _id: '$weaknessTagData.fullTag',
                    tagType: { $first: '$weaknessTagData.type' },
                    tagSpecific: { $first: '$weaknessTagData.specific' },
                    cardsTotal: { $sum: 1 },
                    cardsMastered: {
                        $sum: { $cond: [{ $gte: ['$progressData.stability', 21] }, 1, 0] }
                    },
                    cardsLearning: {
                        $sum: {
                            $cond: [
                                { $and: [{ $gt: ['$progressData.stability', 0] }, { $lt: ['$progressData.stability', 21] }] },
                                1,
                                0
                            ]
                        }
                    },
                    cardsNew: {
                        $sum: {
                            $cond: [
                                { $or: [
                                    { $eq: ['$progressData', null] },
                                    { $eq: ['$progressData.fsrsState', 0] }
                                ]},
                                1,
                                0
                            ]
                        }
                    },
                    totalReviews: { $sum: { $ifNull: ['$progressData.totalReviews', 0] } },
                    correctCount: { $sum: { $ifNull: ['$progressData.correctCount', 0] } },
                    avgStability: { $avg: { $ifNull: ['$progressData.stability', 0] } },
                    firstSeen: { $min: '$createdAt' },
                    lastReviewed: { $max: '$progressData.lastReviewDate' }
                }
            },
            { $sort: { cardsTotal: -1 } }
        ]);

        // Format the results
        return progressByTag.map(tag => ({
            tagId: tag._id,
            tagType: tag.tagType,
            tagSpecific: tag.tagSpecific,
            displayName: this.formatDisplayName(tag.tagSpecific),
            cardsTotal: tag.cardsTotal,
            cardsMastered: tag.cardsMastered,
            cardsLearning: tag.cardsLearning,
            cardsNew: tag.cardsNew,
            masteryPercent: tag.cardsTotal > 0
                ? Math.round((tag.cardsMastered / tag.cardsTotal) * 1000) / 10
                : 0,
            accuracy: tag.totalReviews > 0
                ? Math.round((tag.correctCount / tag.totalReviews) * 1000) / 10
                : 0,
            averageStability: Math.round((tag.avgStability || 0) * 10) / 10,
            totalReviews: tag.totalReviews,
            firstSeen: tag.firstSeen,
            lastReviewed: tag.lastReviewed
        }));
    }

    /**
     * Get aggregated weakness statistics by type
     * @param userId User ID
     */
    async getWeaknessTypeStats(userId: string) {
        // Get all tag stats first
        const allTagStats = await this.getWeaknessTagStats(userId);

        // Aggregate by type
        const typeMap = new Map<string, {
            cardsTotal: number;
            cardsMastered: number;
            cardsLearning: number;
            cardsNew: number;
            totalReviews: number;
            correctCount: number;
            subTags: string[];
        }>();

        for (const tag of allTagStats) {
            const existing = typeMap.get(tag.tagType) || {
                cardsTotal: 0,
                cardsMastered: 0,
                cardsLearning: 0,
                cardsNew: 0,
                totalReviews: 0,
                correctCount: 0,
                subTags: []
            };

            existing.cardsTotal += tag.cardsTotal;
            existing.cardsMastered += tag.cardsMastered;
            existing.cardsLearning += tag.cardsLearning;
            existing.cardsNew += tag.cardsNew;
            existing.totalReviews += tag.totalReviews;
            existing.correctCount += (tag.accuracy * tag.totalReviews) / 100;
            existing.subTags.push(tag.tagId);

            typeMap.set(tag.tagType, existing);
        }

        // Format results
        const result: any[] = [];
        for (const [tagType, data] of typeMap.entries()) {
            result.push({
                tagType,
                displayName: this.formatDisplayName(tagType),
                cardsTotal: data.cardsTotal,
                cardsMastered: data.cardsMastered,
                masteryPercent: data.cardsTotal > 0
                    ? Math.round((data.cardsMastered / data.cardsTotal) * 1000) / 10
                    : 0,
                accuracy: data.totalReviews > 0
                    ? Math.round((data.correctCount / data.totalReviews) * 1000) / 10
                    : 0,
                subTagCount: data.subTags.length
            });
        }

        return result.sort((a, b) => b.cardsTotal - a.cardsTotal);
    }

    /**
     * Get mastery trend for a specific weakness tag over time
     * @param userId User ID
     * @param tagId Full weakness tag ID (e.g., 'weakness:endgame:rook-technique')
     * @param days Number of days to include
     */
    async getWeaknessTagTrend(userId: string, tagId: string, days: number = 30) {
        const endDate = new Date();
        endDate.setUTCHours(23, 59, 59, 999);

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        startDate.setUTCHours(0, 0, 0, 0);

        // Get daily activity with weakness tag tracking
        const activities = await DailyActivity.find({
            userId,
            date: { $gte: startDate, $lte: endDate },
            'weaknessTags.tagId': tagId
        }).sort({ date: 1 });

        const trend: {
            date: string;
            cardsReviewed: number;
            correctCount: number;
            accuracy: number;
            studyTimeMinutes: number;
        }[] = [];

        for (const activity of activities) {
            const tagData = (activity as any).weaknessTags?.find(
                (t: any) => t.tagId === tagId
            );

            if (tagData) {
                const accuracy = tagData.count > 0
                    ? Math.round((tagData.correctCount / tagData.count) * 1000) / 10
                    : 0;

                trend.push({
                    date: (activity.date as Date).toISOString().split('T')[0],
                    cardsReviewed: tagData.count,
                    correctCount: tagData.correctCount,
                    accuracy,
                    studyTimeMinutes: Math.round((tagData.studyTimeMs || 0) / 60000)
                });
            }
        }

        return trend;
    }

    /**
     * Get flashcards by weakness tag
     * @param tagId Full weakness tag ID
     * @param userId Optional user ID to filter by user's flashcards
     * @param limit Max number of flashcards to return
     */
    async getFlashcardsByWeaknessTag(tagId: string, userId?: string, limit: number = 50) {
        const query: any = {
            weaknessTags: tagId,
            isActive: { $ne: false }
        };

        if (userId) {
            query.$or = [
                { users: userId },
                { createdBy: userId },
                { userEmail: userId }
            ];
        }

        const flashcards = await Flashcard.find(query)
            .limit(limit)
            .sort({ createdAt: -1 })
            .lean();

        return flashcards;
    }

    /**
     * Recalculate and cache all analytics for a user
     */
    async recalculateAnalytics(userId: string) {
        const analytics = await (UserAnalytics as any).getOrCreate(userId);

        // Recalculate streak
        const streakData = await (DailyActivity as any).calculateStreak(userId);
        analytics.currentStreak = streakData.currentStreak;
        analytics.lastStudyDate = streakData.lastStudyDate;

        // Recalculate longest streak
        analytics.longestStreak = await (DailyActivity as any).getLongestStreak(userId);

        // Recalculate totals from daily activity
        const totals = await DailyActivity.aggregate([
            { $match: { userId } },
            {
                $group: {
                    _id: null,
                    totalCards: { $sum: '$cardsReviewed' },
                    totalTime: { $sum: '$studyTimeMs' },
                    totalCorrect: { $sum: '$correctCount' },
                    totalIncorrect: { $sum: '$incorrectCount' },
                    sessions: { $sum: '$sessionsCount' }
                }
            }
        ]);

        if (totals.length > 0) {
            analytics.totalCardsReviewed = totals[0].totalCards;
            analytics.totalStudyTimeMs = totals[0].totalTime;
            analytics.lifetimeCorrect = totals[0].totalCorrect;
            analytics.lifetimeIncorrect = totals[0].totalIncorrect;
            analytics.totalSessions = totals[0].sessions;
        }

        // Update category mastery
        const categoryStats = await this.getCategoryStats(userId);
        analytics.masteryByCategory = categoryStats;

        // Update weakness tag mastery
        const weaknessTagStats = await this.getWeaknessTagStats(userId);
        console.log('[AnalyticsService] Weakness tag stats:', JSON.stringify(weaknessTagStats, null, 2));
        analytics.masteryByWeaknessTag = weaknessTagStats;

        // Update weakness type mastery (aggregated)
        const weaknessTypeStats = await this.getWeaknessTypeStats(userId);
        console.log('[AnalyticsService] Weakness type stats:', JSON.stringify(weaknessTypeStats, null, 2));
        analytics.masteryByWeaknessType = weaknessTypeStats;

        analytics.lastComputedAt = new Date();
        const savedAnalytics = await analytics.save();
        console.log('[AnalyticsService] Saved analytics masteryByWeaknessTag:', savedAnalytics.masteryByWeaknessTag?.length || 0);

        // Sync weakness profile to users microservice for easy LLM access
        await this.syncWeaknessProfileToUser(userId, weaknessTagStats, weaknessTypeStats);

        return savedAnalytics;
    }

    /**
     * Sync weakness profile to users microservice
     * This denormalizes the weakness data to the user document for easy access
     * when generating new flashcards (LLM needs to know existing weaknesses)
     */
    async syncWeaknessProfileToUser(
        userId: string,
        tagStats: any[],
        typeStats: any[]
    ): Promise<void> {
        console.log(`[AnalyticsService] syncWeaknessProfileToUser called with userId: ${userId}, tags: ${tagStats.length}, types: ${typeStats.length}`);
        try {
            // Get users service URL
            const envName = process.env.ENV_NAME || 'LOCAL';
            const usersServiceUrl = envName !== 'LOCAL'
                ? 'http://orchestrator-helm.default.svc.cluster.local:8080'
                : 'http://localhost:8080';

            // First, find a flashcard with this userId AND userEmail to get the userEmail
            console.log(`[AnalyticsService] Looking for flashcard with userId: ${userId}`);

            // Query for flashcard that has both the userId and a userEmail
            const flashcard = await Flashcard.findOne({
                userEmail: { $exists: true, $ne: null, $ne: '' },
                $or: [
                    { createdBy: userId },
                    { users: userId }
                ]
            }, { userEmail: 1, createdBy: 1, users: 1 }).lean();

            if (!flashcard || !flashcard.userEmail) {
                console.log(`[AnalyticsService] No flashcard with email found for userId ${userId}, skipping sync`);
                return;
            }
            console.log(`[AnalyticsService] Found flashcard with email: ${flashcard.userEmail}`);

            // Get the user from users service by email to get the correct _id
            const userResponse = await axios.get(`${usersServiceUrl}/api/users`, {
                params: { email: flashcard.userEmail },
                timeout: 10000
            });

            if (!userResponse.data || !userResponse.data._id) {
                console.log(`[AnalyticsService] User not found by email ${flashcard.userEmail}, skipping sync`);
                return;
            }

            const usersServiceUserId = userResponse.data._id;

            // Format tags for the user profile
            const tags = tagStats.map(tag => ({
                tagId: tag.tagId,
                tagType: tag.tagType,
                tagSpecific: tag.tagSpecific,
                displayName: tag.displayName || this.formatDisplayName(tag.tagSpecific),
                cardsTotal: tag.cardsTotal,
                cardsMastered: tag.cardsMastered,
                masteryPercent: tag.masteryPercent,
                accuracy: tag.accuracy,
                lastReviewedAt: tag.lastReviewedAt || new Date()
            }));

            // Format type aggregations
            const byType = typeStats.map(type => ({
                type: type.tagType,
                displayName: type.displayName || this.formatDisplayName(type.tagType),
                totalTags: type.subTagCount,
                avgMastery: type.masteryPercent
            }));

            console.log(`[AnalyticsService] Syncing weakness profile for ${flashcard.userEmail} (users svc ID: ${usersServiceUserId})`);
            console.log(`[AnalyticsService] Tags: ${tags.length}, Types: ${byType.length}`);

            // Call users microservice to update weakness profile using the correct ID
            await axios.put(`${usersServiceUrl}/api/users/${usersServiceUserId}/weakness-profile`, {
                tags,
                byType
            }, {
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' }
            });

            console.log(`[AnalyticsService] Weakness profile synced successfully for ${flashcard.userEmail}`);
        } catch (error: any) {
            // Log but don't fail - this is a background sync
            console.error(`[AnalyticsService] Failed to sync weakness profile to user:`, error.message);
            if (error.response) {
                console.error(`[AnalyticsService] Response status:`, error.response.status);
                console.error(`[AnalyticsService] Response data:`, JSON.stringify(error.response.data));
            }
        }
    }

    // Helper methods
    private isToday(date: Date): boolean {
        const today = new Date();
        return date.getUTCFullYear() === today.getUTCFullYear() &&
               date.getUTCMonth() === today.getUTCMonth() &&
               date.getUTCDate() === today.getUTCDate();
    }

    /**
     * Convert kebab-case to Title Case for display
     * e.g., 'rook-endgame-technique' -> 'Rook Endgame Technique'
     */
    private formatDisplayName(kebabCase: string): string {
        if (!kebabCase) return '';
        return kebabCase
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }
}
