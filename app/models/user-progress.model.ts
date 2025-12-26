import * as mongoose from 'mongoose';
const Schema = mongoose.Schema;

/**
 * UserProgress Schema
 * Tracks a user's learning progress for each flashcard
 * Implements SM-2 Spaced Repetition Algorithm fields
 */
const UserProgressSchema = new Schema({
    // Reference to the user (string for external auth provider IDs like Auth0)
    userId: {
        type: String,
        required: true,
        index: true
    },

    // Reference to the flashcard
    flashcardId: {
        type: Schema.Types.ObjectId,
        ref: 'Flashcard',
        required: true,
        index: true
    },

    // ===== Algorithm Selection =====

    // Which algorithm is active for this card
    algorithm: {
        type: String,
        enum: ['sm2', 'fsrs'],
        default: 'fsrs'
    },

    // ===== FSRS Algorithm Fields =====

    // Stability - time in days for retrievability to drop to 90%
    stability: {
        type: Number,
        default: 0
    },

    // Difficulty - inherent content difficulty [1-10]
    // Lower = easier to remember, higher = harder
    fsrsDifficulty: {
        type: Number,
        default: 0,
        min: 0,
        max: 10
    },

    // Days elapsed since last review
    elapsed_days: {
        type: Number,
        default: 0
    },

    // Scheduled interval until next review (in days)
    scheduled_days: {
        type: Number,
        default: 0
    },

    // Learning step counter (for learning/relearning phases)
    learning_steps: {
        type: Number,
        default: 0
    },

    // FSRS state: New(0), Learning(1), Review(2), Relearning(3)
    fsrsState: {
        type: Number,
        enum: [0, 1, 2, 3],
        default: 0
    },

    // ===== SM-2 Algorithm Fields (Legacy) =====

    // Easiness Factor (EF) - starts at 2.5, min 1.3
    // Higher = easier card, longer intervals
    easinessFactor: {
        type: Number,
        default: 2.5,
        min: 1.3
    },

    // Number of consecutive correct responses
    repetitions: {
        type: Number,
        default: 0
    },

    // Current interval in days until next review
    interval: {
        type: Number,
        default: 0
    },

    // Next scheduled review date
    nextReviewDate: {
        type: Date,
        default: Date.now,
        index: true
    },

    // Last review date
    lastReviewDate: {
        type: Date
    },

    // ===== Quality History =====

    // Last quality rating (0-5)
    // 0 - Complete blackout
    // 1 - Incorrect, remembered on seeing answer
    // 2 - Incorrect, but answer seemed easy to recall
    // 3 - Correct with serious difficulty
    // 4 - Correct with some hesitation
    // 5 - Perfect response
    lastQuality: {
        type: Number,
        min: 0,
        max: 5
    },

    // History of reviews
    reviewHistory: [{
        date: { type: Date, default: Date.now },
        quality: { type: Number, min: 0, max: 5 },  // SM-2: 0-5, FSRS: 1-4
        responseTimeMs: { type: Number },  // How long it took to answer
        intervalBefore: { type: Number },
        intervalAfter: { type: Number },
        algorithm: { type: String, enum: ['sm2', 'fsrs'], default: 'fsrs' }
    }],

    // ===== Statistics =====

    // Total number of reviews
    totalReviews: {
        type: Number,
        default: 0
    },

    // Number of correct responses (quality >= 3)
    correctCount: {
        type: Number,
        default: 0
    },

    // Number of incorrect responses (quality < 3)
    incorrectCount: {
        type: Number,
        default: 0
    },

    // Average response time in milliseconds
    averageResponseTime: {
        type: Number,
        default: 0
    },

    // Learning state
    state: {
        type: String,
        enum: ['new', 'learning', 'review', 'relearning', 'mastered'],
        default: 'new'
    },

    // Number of times this card was "lapsed" (went back to learning)
    lapses: {
        type: Number,
        default: 0
    },

    // Is the card currently suspended/paused
    isSuspended: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true,
    collection: 'user_progress'
});

// Compound index for user + flashcard (unique pair)
UserProgressSchema.index({ userId: 1, flashcardId: 1 }, { unique: true });

// Index for finding due cards
UserProgressSchema.index({ userId: 1, nextReviewDate: 1, isSuspended: 1 });
UserProgressSchema.index({ userId: 1, state: 1 });
UserProgressSchema.index({ userId: 1, algorithm: 1 });
UserProgressSchema.index({ userId: 1, fsrsState: 1 });

/**
 * SM-2 Algorithm Implementation
 * Updates the card's scheduling based on quality of response
 * @param quality - Rating from 0-5
 * @param responseTimeMs - Time taken to answer
 */
UserProgressSchema.methods.processReview = function(quality: number, responseTimeMs?: number) {
    const now = new Date();
    const oldInterval = this.interval;

    // Store review in history
    this.reviewHistory.push({
        date: now,
        quality,
        responseTimeMs,
        intervalBefore: oldInterval,
        intervalAfter: 0  // Will be updated below
    });

    // Update statistics
    this.totalReviews++;
    this.lastReviewDate = now;
    this.lastQuality = quality;

    if (quality >= 3) {
        this.correctCount++;
    } else {
        this.incorrectCount++;
    }

    // Update average response time
    if (responseTimeMs) {
        const totalTime = this.averageResponseTime * (this.totalReviews - 1) + responseTimeMs;
        this.averageResponseTime = totalTime / this.totalReviews;
    }

    // SM-2 Algorithm
    if (quality < 3) {
        // Incorrect response - reset repetitions
        this.repetitions = 0;
        this.interval = 1;  // Review again tomorrow

        // Track lapse if was in review state
        if (this.state === 'review' || this.state === 'mastered') {
            this.lapses++;
            this.state = 'relearning';
        } else {
            this.state = 'learning';
        }
    } else {
        // Correct response
        if (this.repetitions === 0) {
            this.interval = 1;
        } else if (this.repetitions === 1) {
            this.interval = 6;
        } else {
            this.interval = Math.round(this.interval * this.easinessFactor);
        }

        this.repetitions++;

        // Update state based on interval
        if (this.interval >= 21) {
            this.state = 'mastered';
        } else if (this.interval >= 1) {
            this.state = 'review';
        }
    }

    // Update Easiness Factor
    // EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
    const efChange = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
    this.easinessFactor = Math.max(1.3, this.easinessFactor + efChange);

    // Calculate next review date
    this.nextReviewDate = new Date(now.getTime() + this.interval * 24 * 60 * 60 * 1000);

    // Update the last history entry with final interval
    this.reviewHistory[this.reviewHistory.length - 1].intervalAfter = this.interval;

    return this;
};

/**
 * Get user's statistics across all flashcards
 */
UserProgressSchema.statics.getUserStats = async function(userId: string) {
    const stats = await this.aggregate([
        { $match: { userId } },
        {
            $group: {
                _id: '$state',
                count: { $sum: 1 },
                totalReviews: { $sum: '$totalReviews' },
                avgEasiness: { $avg: '$easinessFactor' }
            }
        }
    ]);

    const dueCount = await this.countDocuments({
        userId,
        nextReviewDate: { $lte: new Date() },
        isSuspended: false
    });

    return { stats, dueCount };
};

export const UserProgress = mongoose.model('UserProgress', UserProgressSchema);
export { UserProgressSchema };
