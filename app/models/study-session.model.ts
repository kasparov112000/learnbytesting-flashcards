import * as mongoose from 'mongoose';
const Schema = mongoose.Schema;

/**
 * StudySession Schema
 * Tracks individual study sessions for analytics
 * A session starts when user begins studying and ends when they leave
 */
const StudySessionSchema = new Schema({
    // Reference to the user
    userId: {
        type: String,
        required: true,
        index: true
    },

    // Session timing
    startTime: {
        type: Date,
        required: true,
        default: Date.now
    },

    endTime: {
        type: Date
    },

    // Duration in milliseconds
    durationMs: {
        type: Number,
        default: 0
    },

    // Session status
    status: {
        type: String,
        enum: ['active', 'completed', 'abandoned'],
        default: 'active'
    },

    // Cards reviewed in this session
    cardsReviewed: {
        type: Number,
        default: 0
    },

    // Cards answered correctly (quality >= 3)
    cardsCorrect: {
        type: Number,
        default: 0
    },

    // Cards answered incorrectly (quality < 3)
    cardsFailed: {
        type: Number,
        default: 0
    },

    // New cards introduced in this session
    newCardsLearned: {
        type: Number,
        default: 0
    },

    // Categories studied (array of category IDs)
    categories: [{
        type: String
    }],

    // Average response time for this session (ms)
    averageResponseTime: {
        type: Number,
        default: 0
    },

    // Total response time (for averaging)
    totalResponseTime: {
        type: Number,
        default: 0
    },

    // Session type
    sessionType: {
        type: String,
        enum: ['all', 'due', 'new', 'category', 'single'],
        default: 'all'
    },

    // If studying a specific category
    targetCategoryId: {
        type: String
    },

    // Review ratings distribution
    ratingDistribution: {
        again: { type: Number, default: 0 },  // Rating 1
        hard: { type: Number, default: 0 },   // Rating 2
        good: { type: Number, default: 0 },   // Rating 3
        easy: { type: Number, default: 0 }    // Rating 4
    },

    // Device/platform info (optional)
    platform: {
        type: String,
        enum: ['web', 'mobile', 'unknown'],
        default: 'unknown'
    },

    // User agent (for debugging)
    userAgent: {
        type: String
    }
}, {
    timestamps: true,
    collection: 'study_sessions'
});

// Index for finding user's sessions
StudySessionSchema.index({ userId: 1, startTime: -1 });
StudySessionSchema.index({ userId: 1, status: 1 });
StudySessionSchema.index({ startTime: -1 });

/**
 * End the session and calculate final statistics
 */
StudySessionSchema.methods.endSession = function() {
    this.endTime = new Date();
    this.durationMs = this.endTime.getTime() - this.startTime.getTime();
    this.status = 'completed';

    if (this.cardsReviewed > 0 && this.totalResponseTime > 0) {
        this.averageResponseTime = this.totalResponseTime / this.cardsReviewed;
    }

    return this;
};

/**
 * Record a card review within this session
 */
StudySessionSchema.methods.recordReview = function(
    quality: number,
    responseTimeMs: number,
    categoryId?: string,
    isNewCard?: boolean
) {
    this.cardsReviewed++;

    if (quality >= 3) {
        this.cardsCorrect++;
    } else {
        this.cardsFailed++;
    }

    if (isNewCard) {
        this.newCardsLearned++;
    }

    // Track rating distribution (FSRS ratings 1-4)
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
    if (categoryId && !this.categories.includes(categoryId)) {
        this.categories.push(categoryId);
    }

    return this;
};

/**
 * Get session statistics
 */
StudySessionSchema.methods.getStats = function() {
    const accuracy = this.cardsReviewed > 0
        ? (this.cardsCorrect / this.cardsReviewed) * 100
        : 0;

    return {
        duration: this.durationMs,
        durationMinutes: Math.round(this.durationMs / 60000),
        cardsReviewed: this.cardsReviewed,
        cardsCorrect: this.cardsCorrect,
        cardsFailed: this.cardsFailed,
        newCardsLearned: this.newCardsLearned,
        accuracy: Math.round(accuracy * 10) / 10,
        averageResponseTime: Math.round(this.averageResponseTime),
        ratingDistribution: this.ratingDistribution,
        categoriesCount: this.categories.length
    };
};

/**
 * Static: Get user's session statistics
 */
StudySessionSchema.statics.getUserSessionStats = async function(userId: string, days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const stats = await this.aggregate([
        {
            $match: {
                userId,
                status: 'completed',
                startTime: { $gte: startDate }
            }
        },
        {
            $group: {
                _id: null,
                totalSessions: { $sum: 1 },
                totalDuration: { $sum: '$durationMs' },
                totalCardsReviewed: { $sum: '$cardsReviewed' },
                totalCorrect: { $sum: '$cardsCorrect' },
                totalFailed: { $sum: '$cardsFailed' },
                avgSessionDuration: { $avg: '$durationMs' },
                avgCardsPerSession: { $avg: '$cardsReviewed' }
            }
        }
    ]);

    return stats[0] || {
        totalSessions: 0,
        totalDuration: 0,
        totalCardsReviewed: 0,
        totalCorrect: 0,
        totalFailed: 0,
        avgSessionDuration: 0,
        avgCardsPerSession: 0
    };
};

export const StudySession = mongoose.model('StudySession', StudySessionSchema);
export { StudySessionSchema };
