import { FlashcardService } from './flashcard.service';
import { UserProgressService } from './user-progress.service';
import { UserProgress, Flashcard } from '../models';
import { DailyActivity } from '../models/daily-activity.model';
import { buildCategoryMatchStage } from '../utils/category-match';
import axios from 'axios';

// Qdrant webhook URL - uses internal K8s service or n8n webhook
const QDRANT_WEBHOOK_URL = process.env.QDRANT_WEBHOOK_URL || 'https://n8n.learnbytesting.ai/webhook/save-practice-qdrant';

/**
 * Study session configuration
 */
interface StudySessionConfig {
    newCardsLimit?: number;      // Max new cards per session (default 20)
    reviewCardsLimit?: number;   // Max review cards per session (default 100)
    learningFirst?: boolean;     // Prioritize learning cards
    categoryId?: string;         // Scope to category (hierarchical)
    categoryName?: string;       // Fallback name matching
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
     * Get cards for a study session using a single aggregation pipeline.
     * Joins flashcards with user_progress, sorts by FSRS priority buckets,
     * and applies per-bucket limits (Anki-style: 20 new + 100 reviews).
     */
    async getStudySession(userId: string, config: StudySessionConfig = {}) {
        const {
            newCardsLimit = 20,
            reviewCardsLimit = 100,
            categoryId,
            categoryName,
        } = config;

        const now = new Date();

        // Build match stage from shared helper (category + visibility + base filters)
        const matchStage = buildCategoryMatchStage({
            filterCategoryId: categoryId,
            filterCategoryName: categoryName,
            userId,
        });

        const pipeline: any[] = [
            { $match: matchStage },
            // Left join with UserProgress for this user
            {
                $lookup: {
                    from: 'user_progress',
                    let: { cardId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$userId', userId] },
                                        { $eq: ['$flashcardId', '$$cardId'] },
                                    ],
                                },
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: '_progress',
                },
            },
            {
                $addFields: {
                    _prog: { $ifNull: [{ $arrayElemAt: ['$_progress', 0] }, null] },
                },
            },
            // Compute sort bucket: 0=overdue, 1=learning/relearning, 2=new, 3=future
            {
                $addFields: {
                    _sortBucket: {
                        $switch: {
                            branches: [
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog', null] },
                                            { $ne: ['$_prog.nextReviewDate', null] },
                                            { $lte: ['$_prog.nextReviewDate', now] },
                                        ],
                                    },
                                    then: 0,
                                },
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog', null] },
                                            { $in: ['$_prog.fsrsState', [1, 3]] },
                                        ],
                                    },
                                    then: 1,
                                },
                                {
                                    case: {
                                        $or: [
                                            { $eq: ['$_prog', null] },
                                            { $eq: ['$_prog.fsrsState', 0] },
                                        ],
                                    },
                                    then: 2,
                                },
                            ],
                            default: 3,
                        },
                    },
                    _sortDate: {
                        $ifNull: ['$_prog.nextReviewDate', new Date('2099-01-01')],
                    },
                },
            },
            { $sort: { _sortBucket: 1, _sortDate: 1 } },
            // Project FSRS fields onto flashcard
            {
                $addFields: {
                    fsrsStatus: {
                        $switch: {
                            branches: [
                                { case: { $eq: ['$_prog', null] }, then: 'new' },
                                { case: { $eq: ['$_prog.fsrsState', 0] }, then: 'new' },
                                {
                                    case: { $in: ['$_prog.fsrsState', [1, 3]] },
                                    then: {
                                        $cond: [{ $eq: ['$_prog.fsrsState', 3] }, 'relearning', 'learning'],
                                    },
                                },
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog.nextReviewDate', null] },
                                            { $lte: ['$_prog.nextReviewDate', now] },
                                        ],
                                    },
                                    then: 'due',
                                },
                            ],
                            default: 'review',
                        },
                    },
                    fsrsNextReview: '$_prog.nextReviewDate',
                    fsrsStability: '$_prog.stability',
                    fsrsTotalReviews: '$_prog.totalReviews',
                    fsrsLastReview: '$_prog.lastReviewDate',
                },
            },
            // Generous limit — we partition in JS below
            { $limit: newCardsLimit + reviewCardsLimit + 50 },
            // Clean up temporary fields
            {
                $project: {
                    _progress: 0,
                    _prog: 0,
                    _sortBucket: 0,
                    _sortDate: 0,
                },
            },
        ];

        const allCards: any[] = await Flashcard.aggregate(pipeline).exec();

        // Partition by FSRS status and apply per-bucket limits
        const overdue: any[] = [];
        const learning: any[] = [];
        const newCards: any[] = [];
        const future: any[] = [];

        for (const card of allCards) {
            switch (card.fsrsStatus) {
                case 'due':
                    overdue.push(card);
                    break;
                case 'learning':
                case 'relearning':
                    learning.push(card);
                    break;
                case 'new':
                    newCards.push(card);
                    break;
                default:
                    future.push(card);
            }
        }

        // Apply limits: learning uncapped (always shown), overdue + future share reviewCardsLimit, new capped
        const cappedOverdue = overdue.slice(0, reviewCardsLimit);
        const remainingReviewSlots = Math.max(0, reviewCardsLimit - cappedOverdue.length);
        const cappedFuture = future.slice(0, remainingReviewSlots);
        const cappedNew = newCards.slice(0, newCardsLimit);

        // Final order: learning first, then overdue, then new
        const sessionCards = [...learning, ...cappedOverdue, ...cappedNew, ...cappedFuture];

        return {
            cards: sessionCards,
            stats: {
                dueCount: overdue.length,
                learningCount: learning.length,
                newCount: newCards.length,
                totalInSession: sessionCards.length,
            },
        };
    }

    /**
     * Get a study session scoped to a specific set of flashcard IDs.
     * Uses the same FSRS aggregation pipeline as getStudySession() but
     * matches by _id instead of category. Used for weakness-targeted study.
     */
    async getStudySessionByFlashcardIds(userId: string, flashcardIds: any[], config: Omit<StudySessionConfig, 'categoryId' | 'categoryName'> = {}) {
        const {
            newCardsLimit = 20,
            reviewCardsLimit = 100,
        } = config;

        const mongoose = require('mongoose');
        const now = new Date();

        // Convert to ObjectId where valid
        const objectIds = flashcardIds.map(id => {
            if (id instanceof mongoose.Types.ObjectId) return id;
            if (mongoose.Types.ObjectId.isValid(id)) {
                try { return new mongoose.Types.ObjectId(id); } catch (_e) { /* fall through */ }
            }
            return id;
        });

        const matchStage: any = {
            _id: { $in: objectIds },
            isActive: true,
        };

        const pipeline: any[] = [
            { $match: matchStage },
            {
                $lookup: {
                    from: 'user_progress',
                    let: { cardId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$userId', userId] },
                                        { $eq: ['$flashcardId', '$$cardId'] },
                                    ],
                                },
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: '_progress',
                },
            },
            {
                $addFields: {
                    _prog: { $ifNull: [{ $arrayElemAt: ['$_progress', 0] }, null] },
                },
            },
            {
                $addFields: {
                    _sortBucket: {
                        $switch: {
                            branches: [
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog', null] },
                                            { $ne: ['$_prog.nextReviewDate', null] },
                                            { $lte: ['$_prog.nextReviewDate', now] },
                                        ],
                                    },
                                    then: 0,
                                },
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog', null] },
                                            { $in: ['$_prog.fsrsState', [1, 3]] },
                                        ],
                                    },
                                    then: 1,
                                },
                                {
                                    case: {
                                        $or: [
                                            { $eq: ['$_prog', null] },
                                            { $eq: ['$_prog.fsrsState', 0] },
                                        ],
                                    },
                                    then: 2,
                                },
                            ],
                            default: 3,
                        },
                    },
                    _sortDate: {
                        $ifNull: ['$_prog.nextReviewDate', new Date('2099-01-01')],
                    },
                },
            },
            { $sort: { _sortBucket: 1, _sortDate: 1 } },
            {
                $addFields: {
                    fsrsStatus: {
                        $switch: {
                            branches: [
                                { case: { $eq: ['$_prog', null] }, then: 'new' },
                                { case: { $eq: ['$_prog.fsrsState', 0] }, then: 'new' },
                                {
                                    case: { $in: ['$_prog.fsrsState', [1, 3]] },
                                    then: {
                                        $cond: [{ $eq: ['$_prog.fsrsState', 3] }, 'relearning', 'learning'],
                                    },
                                },
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog.nextReviewDate', null] },
                                            { $lte: ['$_prog.nextReviewDate', now] },
                                        ],
                                    },
                                    then: 'due',
                                },
                            ],
                            default: 'review',
                        },
                    },
                    fsrsNextReview: '$_prog.nextReviewDate',
                    fsrsStability: '$_prog.stability',
                    fsrsTotalReviews: '$_prog.totalReviews',
                    fsrsLastReview: '$_prog.lastReviewDate',
                },
            },
            { $limit: newCardsLimit + reviewCardsLimit + 50 },
            {
                $project: {
                    _progress: 0,
                    _prog: 0,
                    _sortBucket: 0,
                    _sortDate: 0,
                },
            },
        ];

        const allCards: any[] = await Flashcard.aggregate(pipeline).exec();

        // Partition and apply per-bucket limits (same logic as getStudySession)
        const overdue: any[] = [];
        const learning: any[] = [];
        const newCards: any[] = [];
        const future: any[] = [];

        for (const card of allCards) {
            switch (card.fsrsStatus) {
                case 'due': overdue.push(card); break;
                case 'learning': case 'relearning': learning.push(card); break;
                case 'new': newCards.push(card); break;
                default: future.push(card);
            }
        }

        const cappedOverdue = overdue.slice(0, reviewCardsLimit);
        const remainingReviewSlots = Math.max(0, reviewCardsLimit - cappedOverdue.length);
        const cappedFuture = future.slice(0, remainingReviewSlots);
        const cappedNew = newCards.slice(0, newCardsLimit);

        const sessionCards = [...learning, ...cappedOverdue, ...cappedNew, ...cappedFuture];

        return {
            cards: sessionCards,
            stats: {
                dueCount: overdue.length,
                learningCount: learning.length,
                newCount: newCards.length,
                totalInSession: sessionCards.length,
            },
        };
    }

    /**
     * Get the next card for a per-card-fetch study session.
     * Returns a single card with FSRS scheduling and session stats.
     */
    async getNextCard(userId: string, request: {
        categoryIds?: string[];
        exactCategoryIds?: string[];
        tags?: string[];
        flashcardIds?: string[];
        excludeCardIds?: string[];
        newCardsLimit?: number;
        includeAhead?: boolean;
    } = {}) {
        const {
            categoryIds,
            exactCategoryIds,
            tags,
            flashcardIds,
            excludeCardIds = [],
            newCardsLimit = 20,
            includeAhead = false,
        } = request;

        const mongoose = require('mongoose');
        const now = new Date();

        // Get today's new card count from DailyActivity
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const dailyActivity = await DailyActivity.findOne({ userId, date: today });
        const newCardsToday = dailyActivity?.cardsLearned || 0;
        const newCardsBudget = Math.max(0, newCardsLimit - newCardsToday);

        // Build match stage with multi-category/tags/flashcardIds support
        // When exactCategoryIds is provided, use the first one as exactCategoryId
        // to match only primaryCategory (no children)
        const matchStage = buildCategoryMatchStage({
            filterCategoryIds: exactCategoryIds ? undefined : categoryIds,
            exactCategoryId: exactCategoryIds?.[0],
            filterTags: tags,
            filterFlashcardIds: flashcardIds,
            userId,
        });

        // Exclude already-reviewed cards this session
        if (excludeCardIds.length > 0) {
            const excludeObjectIds = excludeCardIds.map(id => {
                if (mongoose.Types.ObjectId.isValid(id)) {
                    try { return new mongoose.Types.ObjectId(id); } catch (_e) { /* fall through */ }
                }
                return id;
            });
            if (!matchStage.$and) matchStage.$and = [];
            matchStage.$and.push({ _id: { $nin: excludeObjectIds } });
        }

        // Single-card aggregation pipeline (same FSRS join as getStudySession but $limit: 1)
        const pipeline: any[] = [
            { $match: matchStage },
            {
                $lookup: {
                    from: 'user_progress',
                    let: { cardId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$userId', userId] },
                                        { $eq: ['$flashcardId', '$$cardId'] },
                                    ],
                                },
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: '_progress',
                },
            },
            {
                $addFields: {
                    _prog: { $ifNull: [{ $arrayElemAt: ['$_progress', 0] }, null] },
                },
            },
            {
                $addFields: {
                    _sortBucket: {
                        $switch: {
                            branches: [
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog', null] },
                                            { $ne: ['$_prog.nextReviewDate', null] },
                                            { $lte: ['$_prog.nextReviewDate', now] },
                                        ],
                                    },
                                    then: 0, // overdue
                                },
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog', null] },
                                            { $in: ['$_prog.fsrsState', [1, 3]] },
                                        ],
                                    },
                                    then: 1, // learning/relearning
                                },
                                {
                                    case: {
                                        $or: [
                                            { $eq: ['$_prog', null] },
                                            { $eq: ['$_prog.fsrsState', 0] },
                                        ],
                                    },
                                    then: 2, // new
                                },
                            ],
                            default: 3, // future
                        },
                    },
                    _sortDate: {
                        $ifNull: ['$_prog.nextReviewDate', new Date('2099-01-01')],
                    },
                    // Insight cards sort first when studying all cards in a category
                    _isInsight: {
                        $cond: [{ $eq: ['$cardType', 'insight'] }, 0, 1],
                    },
                },
            },
        ];

        // If no new card budget left, exclude new cards (unless includeAhead bypasses limits)
        if (newCardsBudget <= 0 && !includeAhead) {
            pipeline.push({
                $match: { _sortBucket: { $ne: 2 } },
            });
        }

        // If not including ahead, exclude future cards
        if (!includeAhead) {
            pipeline.push({
                $match: { _sortBucket: { $ne: 3 } },
            });
        }

        pipeline.push(
            { $sort: { _isInsight: 1, _sortBucket: 1, _sortDate: 1 } },
            { $limit: 1 },
            {
                $addFields: {
                    fsrsStatus: {
                        $switch: {
                            branches: [
                                { case: { $eq: ['$_prog', null] }, then: 'new' },
                                { case: { $eq: ['$_prog.fsrsState', 0] }, then: 'new' },
                                {
                                    case: { $in: ['$_prog.fsrsState', [1, 3]] },
                                    then: {
                                        $cond: [{ $eq: ['$_prog.fsrsState', 3] }, 'relearning', 'learning'],
                                    },
                                },
                                {
                                    case: {
                                        $and: [
                                            { $ne: ['$_prog.nextReviewDate', null] },
                                            { $lte: ['$_prog.nextReviewDate', now] },
                                        ],
                                    },
                                    then: 'due',
                                },
                            ],
                            default: 'review',
                        },
                    },
                    fsrsNextReview: '$_prog.nextReviewDate',
                    fsrsStability: '$_prog.stability',
                    fsrsTotalReviews: '$_prog.totalReviews',
                    fsrsLastReview: '$_prog.lastReviewDate',
                },
            },
            {
                $project: {
                    _progress: 0,
                    _prog: 0,
                    _sortBucket: 0,
                    _sortDate: 0,
                },
            },
        );

        const cards: any[] = await Flashcard.aggregate(pipeline).exec();
        const card = cards[0] || null;

        // If card is new, increment daily new card count
        if (card && (card.fsrsStatus === 'new')) {
            await DailyActivity.findOneAndUpdate(
                { userId, date: today },
                { $inc: { cardsLearned: 1 } },
                { upsert: true },
            );
        }

        // Lightweight count aggregation for session stats
        const countMatchStage = buildCategoryMatchStage({
            filterCategoryIds: exactCategoryIds ? undefined : categoryIds,
            exactCategoryId: exactCategoryIds?.[0],
            filterTags: tags,
            filterFlashcardIds: flashcardIds,
            userId,
        });

        // Stable total count (ignores excludeCardIds so it doesn't shrink as cards are studied)
        const totalInScope = await Flashcard.countDocuments(countMatchStage);

        // Exclude already-reviewed cards for per-bucket counts
        if (excludeCardIds.length > 0) {
            const excludeObjectIds = excludeCardIds.map(id => {
                if (mongoose.Types.ObjectId.isValid(id)) {
                    try { return new mongoose.Types.ObjectId(id); } catch (_e) { /* fall through */ }
                }
                return id;
            });
            if (!countMatchStage.$and) countMatchStage.$and = [];
            countMatchStage.$and.push({ _id: { $nin: excludeObjectIds } });
        }

        const countPipeline: any[] = [
            { $match: countMatchStage },
            {
                $lookup: {
                    from: 'user_progress',
                    let: { cardId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$userId', userId] },
                                        { $eq: ['$flashcardId', '$$cardId'] },
                                    ],
                                },
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: '_progress',
                },
            },
            {
                $addFields: {
                    _prog: { $ifNull: [{ $arrayElemAt: ['$_progress', 0] }, null] },
                },
            },
            {
                $group: {
                    _id: null,
                    dueRemaining: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ['$_prog', null] },
                                        { $ne: ['$_prog.nextReviewDate', null] },
                                        { $lte: ['$_prog.nextReviewDate', now] },
                                    ],
                                },
                                1, 0,
                            ],
                        },
                    },
                    learningRemaining: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ['$_prog', null] },
                                        { $in: ['$_prog.fsrsState', [1, 3]] },
                                    ],
                                },
                                1, 0,
                            ],
                        },
                    },
                    newRemaining: {
                        $sum: {
                            $cond: [
                                {
                                    $or: [
                                        { $eq: ['$_prog', null] },
                                        { $eq: ['$_prog.fsrsState', 0] },
                                    ],
                                },
                                1, 0,
                            ],
                        },
                    },
                },
            },
        ];

        const countResult = await Flashcard.aggregate(countPipeline).exec();
        const counts = countResult[0] || { dueRemaining: 0, learningRemaining: 0, newRemaining: 0 };

        // Get next due time if no card found
        let nextDueTime: Date | null = null;
        if (!card) {
            const nextDue = await UserProgress.findOne({
                userId,
                nextReviewDate: { $gt: now },
                isSuspended: { $ne: true },
            }).sort({ nextReviewDate: 1 }).select('nextReviewDate').lean();
            nextDueTime = nextDue?.nextReviewDate || null;
        }

        return {
            card,
            fsrsStatus: card?.fsrsStatus || null,
            sessionStats: {
                dueRemaining: counts.dueRemaining,
                learningRemaining: counts.learningRemaining,
                newRemaining: Math.min(counts.newRemaining, newCardsBudget),
                newCardsToday,
                dailyNewLimit: newCardsLimit,
                nextDueTime,
                totalInScope,
            },
        };
    }

    /**
     * Get due card counts per category for the study builder.
     */
    async getDueCounts(userId: string, categoryIds: string[]) {
        const now = new Date();
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        const results: Array<{
            categoryId: string;
            dueCount: number;
            newCount: number;
            totalCards: number;
        }> = [];

        for (const categoryId of categoryIds) {
            const matchStage = buildCategoryMatchStage({
                filterCategoryId: categoryId,
                userId,
            });

            const countPipeline: any[] = [
                { $match: matchStage },
                {
                    $lookup: {
                        from: 'user_progress',
                        let: { cardId: '$_id' },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $and: [
                                            { $eq: ['$userId', userId] },
                                            { $eq: ['$flashcardId', '$$cardId'] },
                                        ],
                                    },
                                },
                            },
                            { $limit: 1 },
                        ],
                        as: '_progress',
                    },
                },
                {
                    $addFields: {
                        _prog: { $ifNull: [{ $arrayElemAt: ['$_progress', 0] }, null] },
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalCards: { $sum: 1 },
                        dueCount: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$_prog', null] },
                                            { $ne: ['$_prog.nextReviewDate', null] },
                                            { $lte: ['$_prog.nextReviewDate', now] },
                                        ],
                                    },
                                    1, 0,
                                ],
                            },
                        },
                        newCount: {
                            $sum: {
                                $cond: [
                                    {
                                        $or: [
                                            { $eq: ['$_prog', null] },
                                            { $eq: ['$_prog.fsrsState', 0] },
                                        ],
                                    },
                                    1, 0,
                                ],
                            },
                        },
                    },
                },
            ];

            const countResult = await Flashcard.aggregate(countPipeline).exec();
            const counts = countResult[0] || { totalCards: 0, dueCount: 0, newCount: 0 };

            results.push({
                categoryId,
                dueCount: counts.dueCount,
                newCount: counts.newCount,
                totalCards: counts.totalCards,
            });
        }

        return results;
    }

    /**
     * Get study suggestions: categories with most overdue cards.
     * Returns top 3 categories sorted by overdue urgency.
     */
    async getStudySuggestions(userId: string): Promise<Array<{
        categoryId: string;
        categoryName: string;
        reason: string;
        priority: number;
    }>> {
        const now = new Date();

        const pipeline: any[] = [
            {
                $lookup: {
                    from: 'user_progress',
                    let: { cardId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$userId', userId] },
                                        { $eq: ['$flashcardId', '$$cardId'] },
                                    ],
                                },
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: '_progress',
                },
            },
            {
                $addFields: {
                    _prog: { $ifNull: [{ $arrayElemAt: ['$_progress', 0] }, null] },
                },
            },
            {
                $match: {
                    '_prog.nextReviewDate': { $lte: now },
                    '_prog': { $ne: null },
                },
            },
            {
                $group: {
                    _id: { $arrayElemAt: ['$categoryIds', 0] },
                    categoryName: { $first: { $ifNull: [{ $arrayElemAt: ['$categories.name', 0] }, 'Unknown'] } },
                    overdueCount: { $sum: 1 },
                    avgOverdueDays: {
                        $avg: {
                            $divide: [
                                { $subtract: [now, '$_prog.nextReviewDate'] },
                                86400000, // ms per day
                            ],
                        },
                    },
                },
            },
            { $sort: { overdueCount: -1 } },
            { $limit: 3 },
        ];

        const results = await Flashcard.aggregate(pipeline).exec();

        return results.map((r: any) => ({
            categoryId: r._id || '',
            categoryName: r.categoryName || 'Unknown',
            reason: `${r.overdueCount} overdue cards (avg ${Math.round(r.avgOverdueDays || 0)} days)`,
            priority: r.overdueCount,
        }));
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

        // Return study session scoped to this category
        return await this.getStudySession(userId, { categoryId });
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
     * @param userId - User ID
     * @param flashcardId - Flashcard ID
     * @param rating - FSRS rating (1-4) or legacy quality (0-5 if useLegacyQuality=true)
     * @param responseTimeMs - Time taken to respond in milliseconds
     * @param useLegacyQuality - If true, treat rating as SM-2 quality (0-5) and convert to FSRS
     * @param userEmail - Optional user email for Qdrant analytics
     */
    async submitAnswer(
        userId: string,
        flashcardId: string,
        rating: number,
        responseTimeMs?: number,
        useLegacyQuality: boolean = false,
        userEmail?: string
    ) {
        // Process the review
        const progress = await this.userProgressService.processReview(
            userId,
            flashcardId,
            rating,
            responseTimeMs,
            useLegacyQuality
        );

        // Send to Qdrant for RAG analytics (async, non-blocking)
        if (userEmail) {
            try {
                const flashcard = await Flashcard.findById(flashcardId).populate('categoryId');
                this.sendToQdrant(userEmail, flashcardId, rating, responseTimeMs || 0, progress, flashcard);
            } catch (err) {
                console.error('[StudyService] Error fetching flashcard for Qdrant:', err);
            }
        }

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
     * Send practice evaluation to Qdrant for RAG analytics (async, non-blocking)
     */
    private async sendToQdrant(
        userEmail: string,
        flashcardId: string,
        rating: number,
        responseTimeMs: number,
        progress: any,
        flashcard: any
    ): Promise<void> {
        try {
            const payload = {
                user_email: userEmail,
                flashcard_id: flashcardId,
                rating: rating,
                response_time_ms: responseTimeMs || 0,
                flashcard_front: flashcard?.front || '',
                flashcard_back: flashcard?.back || '',
                weakness_tags: flashcard?.weaknessTags || [],
                difficulty: flashcard?.difficulty || 3,
                category_name: flashcard?.categoryId?.name || flashcard?.category || 'Unknown',
                stability: progress?.stability || 0,
                new_stability: progress?.stability || 0,
                repetitions: progress?.repetitions || progress?.totalReviews || 0
            };

            // Fire and forget - don't wait for response
            axios.post(QDRANT_WEBHOOK_URL, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            }).then(() => {
                console.log(`[StudyService] Practice evaluation saved to Qdrant for user ${userEmail}`);
            }).catch((err) => {
                console.error(`[StudyService] Failed to save to Qdrant: ${err.message}`);
            });
        } catch (error) {
            console.error('[StudyService] Error preparing Qdrant payload:', error);
        }
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
