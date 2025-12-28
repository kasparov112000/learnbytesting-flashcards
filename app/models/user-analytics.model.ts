import * as mongoose from 'mongoose';
const Schema = mongoose.Schema;

/**
 * UserAnalytics Schema
 * Stores computed/cached analytics for faster dashboard loading
 * One document per user, updated periodically
 */
const UserAnalyticsSchema = new Schema({
    // Reference to the user (unique)
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    // Streak information
    currentStreak: {
        type: Number,
        default: 0
    },

    longestStreak: {
        type: Number,
        default: 0
    },

    lastStudyDate: {
        type: Date
    },

    // Total lifetime stats
    totalCardsLearned: {
        type: Number,
        default: 0
    },

    totalCardsReviewed: {
        type: Number,
        default: 0
    },

    totalStudyTimeMs: {
        type: Number,
        default: 0
    },

    totalSessions: {
        type: Number,
        default: 0
    },

    // Overall accuracy
    lifetimeCorrect: {
        type: Number,
        default: 0
    },

    lifetimeIncorrect: {
        type: Number,
        default: 0
    },

    // Mastery by category (cached for quick access)
    masteryByCategory: [{
        categoryId: { type: String },
        categoryName: { type: String },
        cardsTotal: { type: Number, default: 0 },
        cardsMastered: { type: Number, default: 0 },  // Cards with high stability
        cardsLearning: { type: Number, default: 0 },  // Cards being learned
        cardsNew: { type: Number, default: 0 },       // Cards never seen
        masteryPercent: { type: Number, default: 0 },
        averageStability: { type: Number, default: 0 },
        totalReviews: { type: Number, default: 0 },
        accuracy: { type: Number, default: 0 }
    }],

    // Weekly activity summary (last 12 weeks)
    weeklyActivity: [{
        weekStart: { type: Date },
        cardsReviewed: { type: Number, default: 0 },
        studyTimeMs: { type: Number, default: 0 },
        accuracy: { type: Number, default: 0 },
        activeDays: { type: Number, default: 0 }
    }],

    // Monthly mastery trend (last 12 months)
    monthlyMastery: [{
        month: { type: Date },
        masteryPercent: { type: Number, default: 0 },
        cardsTotal: { type: Number, default: 0 },
        cardsMastered: { type: Number, default: 0 }
    }],

    // Rating distribution (lifetime)
    ratingDistribution: {
        again: { type: Number, default: 0 },
        hard: { type: Number, default: 0 },
        good: { type: Number, default: 0 },
        easy: { type: Number, default: 0 }
    },

    // Best performance stats
    bestStreak: {
        value: { type: Number, default: 0 },
        achievedAt: { type: Date }
    },

    bestDailyCards: {
        value: { type: Number, default: 0 },
        achievedAt: { type: Date }
    },

    bestAccuracyDay: {
        value: { type: Number, default: 0 },  // Percentage
        achievedAt: { type: Date },
        cardsReviewed: { type: Number, default: 0 }
    },

    // Daily goal settings
    dailyGoal: {
        type: Number,
        default: 20  // Default goal of 20 cards per day
    },

    // Learning preferences (for analytics)
    preferredStudyTime: {
        type: String,  // e.g., "morning", "afternoon", "evening", "night"
        default: 'unknown'
    },

    averageSessionDuration: {
        type: Number,
        default: 0  // ms
    },

    // Last time analytics were computed
    lastComputedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true,
    collection: 'user_analytics'
});

/**
 * Get overall mastery percentage
 */
UserAnalyticsSchema.methods.getOverallMastery = function(): number {
    if (this.masteryByCategory.length === 0) return 0;

    let totalCards = 0;
    let totalMastered = 0;

    for (const cat of this.masteryByCategory) {
        totalCards += cat.cardsTotal;
        totalMastered += cat.cardsMastered;
    }

    if (totalCards === 0) return 0;
    return Math.round((totalMastered / totalCards) * 1000) / 10;
};

/**
 * Get overall accuracy percentage
 */
UserAnalyticsSchema.methods.getOverallAccuracy = function(): number {
    const total = this.lifetimeCorrect + this.lifetimeIncorrect;
    if (total === 0) return 0;
    return Math.round((this.lifetimeCorrect / total) * 1000) / 10;
};

/**
 * Get total study time in hours
 */
UserAnalyticsSchema.methods.getStudyHours = function(): number {
    return Math.round((this.totalStudyTimeMs / 3600000) * 10) / 10;
};

/**
 * Update best records if current values are higher
 */
UserAnalyticsSchema.methods.updateBestRecords = function(
    todayCards: number,
    todayAccuracy: number,
    currentStreak: number
) {
    const now = new Date();

    if (currentStreak > this.bestStreak.value) {
        this.bestStreak = {
            value: currentStreak,
            achievedAt: now
        };
    }

    if (todayCards > this.bestDailyCards.value) {
        this.bestDailyCards = {
            value: todayCards,
            achievedAt: now
        };
    }

    if (todayAccuracy > this.bestAccuracyDay.value && todayCards >= 10) {
        // Only count if at least 10 cards reviewed
        this.bestAccuracyDay = {
            value: todayAccuracy,
            achievedAt: now,
            cardsReviewed: todayCards
        };
    }

    return this;
};

/**
 * Get summary for dashboard
 */
UserAnalyticsSchema.methods.getDashboardSummary = function() {
    return {
        currentStreak: this.currentStreak,
        longestStreak: this.longestStreak,
        lastStudyDate: this.lastStudyDate,
        totalCards: this.totalCardsLearned,
        totalReviews: this.totalCardsReviewed,
        studyHours: this.getStudyHours(),
        overallAccuracy: this.getOverallAccuracy(),
        overallMastery: this.getOverallMastery(),
        dailyGoal: this.dailyGoal,
        ratingDistribution: this.ratingDistribution,
        bestRecords: {
            streak: this.bestStreak,
            dailyCards: this.bestDailyCards,
            accuracy: this.bestAccuracyDay
        }
    };
};

/**
 * Static: Get or create analytics for a user
 */
UserAnalyticsSchema.statics.getOrCreate = async function(userId: string) {
    let analytics = await this.findOne({ userId });

    if (!analytics) {
        analytics = new this({ userId });
        await analytics.save();
    }

    return analytics;
};

/**
 * Static: Update category mastery for a user
 */
UserAnalyticsSchema.statics.updateCategoryMastery = async function(
    userId: string,
    categoryId: string,
    categoryName: string,
    stats: {
        cardsTotal: number;
        cardsMastered: number;
        cardsLearning: number;
        cardsNew: number;
        totalReviews: number;
        correctCount: number;
        averageStability: number;
    }
) {
    const analytics = await this.getOrCreate(userId);

    const existingIndex = analytics.masteryByCategory.findIndex(
        c => c.categoryId === categoryId
    );

    const categoryData = {
        categoryId,
        categoryName,
        cardsTotal: stats.cardsTotal,
        cardsMastered: stats.cardsMastered,
        cardsLearning: stats.cardsLearning,
        cardsNew: stats.cardsNew,
        masteryPercent: stats.cardsTotal > 0
            ? Math.round((stats.cardsMastered / stats.cardsTotal) * 1000) / 10
            : 0,
        averageStability: stats.averageStability,
        totalReviews: stats.totalReviews,
        accuracy: stats.totalReviews > 0
            ? Math.round((stats.correctCount / stats.totalReviews) * 1000) / 10
            : 0
    };

    if (existingIndex >= 0) {
        analytics.masteryByCategory[existingIndex] = categoryData;
    } else {
        analytics.masteryByCategory.push(categoryData);
    }

    analytics.lastComputedAt = new Date();
    await analytics.save();

    return analytics;
};

/**
 * Static: Record a completed session
 */
UserAnalyticsSchema.statics.recordSession = async function(
    userId: string,
    sessionStats: {
        cardsReviewed: number;
        correctCount: number;
        incorrectCount: number;
        durationMs: number;
        newCardsLearned: number;
        ratingDistribution: {
            again: number;
            hard: number;
            good: number;
            easy: number;
        };
    }
) {
    const analytics = await this.getOrCreate(userId);

    // Update totals
    analytics.totalCardsReviewed += sessionStats.cardsReviewed;
    analytics.totalCardsLearned += sessionStats.newCardsLearned;
    analytics.totalStudyTimeMs += sessionStats.durationMs;
    analytics.totalSessions++;
    analytics.lifetimeCorrect += sessionStats.correctCount;
    analytics.lifetimeIncorrect += sessionStats.incorrectCount;

    // Update rating distribution
    analytics.ratingDistribution.again += sessionStats.ratingDistribution.again;
    analytics.ratingDistribution.hard += sessionStats.ratingDistribution.hard;
    analytics.ratingDistribution.good += sessionStats.ratingDistribution.good;
    analytics.ratingDistribution.easy += sessionStats.ratingDistribution.easy;

    // Update average session duration
    analytics.averageSessionDuration = Math.round(
        analytics.totalStudyTimeMs / analytics.totalSessions
    );

    analytics.lastStudyDate = new Date();
    analytics.lastComputedAt = new Date();

    await analytics.save();
    return analytics;
};

/**
 * Static: Update streak information
 */
UserAnalyticsSchema.statics.updateStreak = async function(
    userId: string,
    currentStreak: number,
    lastStudyDate: Date
) {
    const analytics = await this.getOrCreate(userId);

    analytics.currentStreak = currentStreak;
    analytics.lastStudyDate = lastStudyDate;

    if (currentStreak > analytics.longestStreak) {
        analytics.longestStreak = currentStreak;
    }

    analytics.updateBestRecords(0, 0, currentStreak);
    analytics.lastComputedAt = new Date();

    await analytics.save();
    return analytics;
};

export const UserAnalytics = mongoose.model('UserAnalytics', UserAnalyticsSchema);
export { UserAnalyticsSchema };
