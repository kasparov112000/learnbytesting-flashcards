import * as mongoose from 'mongoose';
const Schema = mongoose.Schema;

/**
 * DailyActivity Schema
 * Aggregates daily study statistics for streaks and heatmaps
 * One document per user per day
 */
const DailyActivitySchema = new Schema({
    // Reference to the user
    userId: {
        type: String,
        required: true,
        index: true
    },

    // Date (stored as start of day in UTC)
    date: {
        type: Date,
        required: true,
        index: true
    },

    // Total cards reviewed this day
    cardsReviewed: {
        type: Number,
        default: 0
    },

    // New cards introduced (first time seeing)
    cardsLearned: {
        type: Number,
        default: 0
    },

    // Total study time in milliseconds
    studyTimeMs: {
        type: Number,
        default: 0
    },

    // Cards answered correctly (quality >= 3)
    correctCount: {
        type: Number,
        default: 0
    },

    // Cards answered incorrectly (quality < 3)
    incorrectCount: {
        type: Number,
        default: 0
    },

    // Number of study sessions on this day
    sessionsCount: {
        type: Number,
        default: 0
    },

    // Average response time for the day (ms)
    averageResponseTime: {
        type: Number,
        default: 0
    },

    // Total response time (for averaging)
    totalResponseTime: {
        type: Number,
        default: 0
    },

    // Rating distribution for the day
    ratingDistribution: {
        again: { type: Number, default: 0 },  // Rating 1
        hard: { type: Number, default: 0 },   // Rating 2
        good: { type: Number, default: 0 },   // Rating 3
        easy: { type: Number, default: 0 }    // Rating 4
    },

    // Categories studied with counts
    categories: [{
        categoryId: { type: String },
        categoryName: { type: String },
        count: { type: Number, default: 0 }
    }],

    // Goal tracking (optional)
    dailyGoal: {
        type: Number,
        default: 0  // 0 means no goal set
    },

    goalReached: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true,
    collection: 'daily_activity'
});

// Compound index for unique user+date and efficient lookups
DailyActivitySchema.index({ userId: 1, date: -1 }, { unique: true });
DailyActivitySchema.index({ date: 1 });  // For cleanup/aggregation

/**
 * Get accuracy percentage for the day
 */
DailyActivitySchema.methods.getAccuracy = function(): number {
    const total = this.correctCount + this.incorrectCount;
    if (total === 0) return 0;
    return Math.round((this.correctCount / total) * 1000) / 10;
};

/**
 * Get study time in minutes
 */
DailyActivitySchema.methods.getStudyMinutes = function(): number {
    return Math.round(this.studyTimeMs / 60000);
};

/**
 * Check if goal is met
 */
DailyActivitySchema.methods.checkGoal = function(): boolean {
    if (this.dailyGoal <= 0) return false;
    this.goalReached = this.cardsReviewed >= this.dailyGoal;
    return this.goalReached;
};

/**
 * Record a review in this day's activity
 */
DailyActivitySchema.methods.recordReview = function(
    quality: number,
    responseTimeMs: number,
    categoryId?: string,
    categoryName?: string,
    isNewCard?: boolean
) {
    this.cardsReviewed++;

    if (quality >= 3) {
        this.correctCount++;
    } else {
        this.incorrectCount++;
    }

    if (isNewCard) {
        this.cardsLearned++;
    }

    // Track rating distribution
    switch (quality) {
        case 1: this.ratingDistribution.again++; break;
        case 2: this.ratingDistribution.hard++; break;
        case 3: this.ratingDistribution.good++; break;
        case 4: this.ratingDistribution.easy++; break;
    }

    // Update response time tracking
    if (responseTimeMs) {
        this.totalResponseTime += responseTimeMs;
        this.averageResponseTime = this.totalResponseTime / this.cardsReviewed;
    }

    // Track category
    if (categoryId) {
        const existingCat = this.categories.find(c => c.categoryId === categoryId);
        if (existingCat) {
            existingCat.count++;
        } else {
            this.categories.push({
                categoryId,
                categoryName: categoryName || 'Unknown',
                count: 1
            });
        }
    }

    // Check goal
    this.checkGoal();

    return this;
};

/**
 * Add session time to the day
 */
DailyActivitySchema.methods.addSessionTime = function(durationMs: number) {
    this.studyTimeMs += durationMs;
    this.sessionsCount++;
    return this;
};

/**
 * Static: Get or create today's activity for a user
 */
DailyActivitySchema.statics.getOrCreateToday = async function(userId: string) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    let activity = await this.findOne({ userId, date: today });

    if (!activity) {
        activity = new this({
            userId,
            date: today
        });
        await activity.save();
    }

    return activity;
};

/**
 * Static: Get activity for date range (for heatmap)
 */
DailyActivitySchema.statics.getActivityRange = async function(
    userId: string,
    startDate: Date,
    endDate: Date
) {
    return this.find({
        userId,
        date: {
            $gte: startDate,
            $lte: endDate
        }
    }).sort({ date: 1 });
};

/**
 * Static: Calculate current streak for a user
 */
DailyActivitySchema.statics.calculateStreak = async function(userId: string) {
    // Get all activity days in reverse chronological order
    const activities = await this.find({
        userId,
        cardsReviewed: { $gt: 0 }
    }).sort({ date: -1 }).select('date');

    if (activities.length === 0) {
        return { currentStreak: 0, lastStudyDate: null };
    }

    let currentStreak = 0;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const lastStudyDate = new Date(activities[0].date);
    lastStudyDate.setUTCHours(0, 0, 0, 0);

    // Check if studied today or yesterday (streak is still active)
    const daysSinceLastStudy = Math.floor(
        (today.getTime() - lastStudyDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceLastStudy > 1) {
        // Streak is broken
        return { currentStreak: 0, lastStudyDate: activities[0].date };
    }

    // Count consecutive days
    let expectedDate = lastStudyDate;

    for (const activity of activities) {
        const activityDate = new Date(activity.date);
        activityDate.setUTCHours(0, 0, 0, 0);

        const dayDiff = Math.floor(
            (expectedDate.getTime() - activityDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        if (dayDiff === 0) {
            currentStreak++;
            expectedDate = new Date(activityDate);
            expectedDate.setDate(expectedDate.getDate() - 1);
        } else if (dayDiff === 1) {
            // Skip a day gap in expected date, this shouldn't happen
            // as we're iterating sorted activities
            break;
        } else {
            // Gap in streak
            break;
        }
    }

    return {
        currentStreak,
        lastStudyDate: activities[0].date
    };
};

/**
 * Static: Get longest streak for a user
 */
DailyActivitySchema.statics.getLongestStreak = async function(userId: string) {
    const activities = await this.find({
        userId,
        cardsReviewed: { $gt: 0 }
    }).sort({ date: 1 }).select('date');

    if (activities.length === 0) {
        return 0;
    }

    let longestStreak = 1;
    let currentStreak = 1;
    let previousDate = new Date(activities[0].date);
    previousDate.setUTCHours(0, 0, 0, 0);

    for (let i = 1; i < activities.length; i++) {
        const currentDate = new Date(activities[i].date);
        currentDate.setUTCHours(0, 0, 0, 0);

        const dayDiff = Math.floor(
            (currentDate.getTime() - previousDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        if (dayDiff === 1) {
            // Consecutive day
            currentStreak++;
            longestStreak = Math.max(longestStreak, currentStreak);
        } else if (dayDiff > 1) {
            // Gap in streak
            currentStreak = 1;
        }
        // If dayDiff === 0, same day, skip

        previousDate = currentDate;
    }

    return longestStreak;
};

/**
 * Static: Get weekly summary for a user
 */
DailyActivitySchema.statics.getWeeklySummary = async function(userId: string, weeks: number = 4) {
    const endDate = new Date();
    endDate.setUTCHours(23, 59, 59, 999);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (weeks * 7));
    startDate.setUTCHours(0, 0, 0, 0);

    return this.aggregate([
        {
            $match: {
                userId,
                date: { $gte: startDate, $lte: endDate }
            }
        },
        {
            $group: {
                _id: {
                    year: { $year: '$date' },
                    week: { $week: '$date' }
                },
                totalCards: { $sum: '$cardsReviewed' },
                totalCorrect: { $sum: '$correctCount' },
                totalStudyTime: { $sum: '$studyTimeMs' },
                activeDays: { $sum: 1 },
                startDate: { $min: '$date' }
            }
        },
        {
            $project: {
                _id: 0,
                week: '$_id',
                totalCards: 1,
                totalCorrect: 1,
                totalStudyTime: 1,
                activeDays: 1,
                startDate: 1,
                accuracy: {
                    $cond: {
                        if: { $gt: ['$totalCards', 0] },
                        then: {
                            $multiply: [
                                { $divide: ['$totalCorrect', '$totalCards'] },
                                100
                            ]
                        },
                        else: 0
                    }
                }
            }
        },
        { $sort: { startDate: -1 } }
    ]);
};

export const DailyActivity = mongoose.model('DailyActivity', DailyActivitySchema);
export { DailyActivitySchema };
