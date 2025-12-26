import { DbService } from '../services/db.service';
import { Flashcard } from '../models';
import { FSRSService } from '../services/fsrs.service';

// Get current environment for flashcard creation
const ENV_NAME = process.env.ENV_NAME || 'LOCAL';

export default function (app, express, services) {
  let router = express.Router();
  const status = require('http-status');

  const { flashcardService, userProgressService, studyService } = services;

  // ==================== HEALTH CHECK ====================

  router.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'flashcards' });
  });

  router.get('/pingflashcards', (req, res) => {
    console.log('info', 'GET Ping Flashcards', {
      timestamp: Date.now(),
      txnId: req.id
    });
    res.status(status.OK).json({ message: 'pong from flashcards' });
  });

  // ==================== FLASHCARD CRUD ====================

  // Create flashcard
  router.post('/flashcards', async (req, res) => {
    try {
      // Auto-set environment based on current ENV_NAME
      const flashcardData = { ...req.body, environment: ENV_NAME };
      const flashcard = await flashcardService.create(flashcardData);
      res.status(201).json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Create error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Create multiple flashcards
  router.post('/flashcards/batch', async (req, res) => {
    try {
      // Handle case where body contains { response: "<JSON string>" } (from HITL/AI workflows)
      let requestBody = req.body;
      if (req.body.response && typeof req.body.response === 'string') {
        console.log('[Flashcards] Parsing response field as JSON string...');
        try {
          const parsed = JSON.parse(req.body.response);
          requestBody = parsed;
          console.log('[Flashcards] Parsed response successfully, flashcards count:', parsed.flashcards?.length || 0);
        } catch (parseErr: any) {
          console.error('[Flashcards] Failed to parse response field:', parseErr.message);
        }
      }

      // Auto-set environment for all flashcards
      const flashcardsWithEnv = (requestBody.flashcards || []).map(fc => ({ ...fc, environment: ENV_NAME }));
      const flashcards = await flashcardService.createMany(flashcardsWithEnv);
      res.status(201).json({ result: flashcards, count: flashcards.length });
    } catch (error: any) {
      console.error('[Flashcards] Batch create error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // AG-Grid endpoint with aggregate pipeline for server-side pagination
  router.post('/flashcards/grid', async (req, res) => {
    try {
      console.log('[Flashcards] Grid request:', JSON.stringify(req.body, null, 2));
      const result = await flashcardService.getGrid(req.body);
      res.json(result);
    } catch (error: any) {
      console.error('[Flashcards] Grid error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get all flashcards with filtering and search (using aggregate pipeline)
  router.get('/flashcards', async (req, res) => {
    try {
      const { category, categoryId, filterCategoryId, tag, userId, limit, skip, sort, search, page, pageSize } = req.query;

      // Build match stage for aggregate pipeline
      // All filters are combined with AND logic (MongoDB implicit $and)
      const matchStage: any = { isActive: true };

      if (category) matchStage.category = category;

      // Hierarchical category filtering - finds all cards that have this category in their ancestry
      if (filterCategoryId) {
        matchStage.categoryIds = filterCategoryId;
      } else if (categoryId) {
        matchStage.categoryId = categoryId;
      }

      if (tag) matchStage.tags = tag;

      // User visibility filter: users see their own cards OR public cards
      if (userId) {
        matchStage.$or = [
          { createdBy: userId },
          { isPublic: true }
        ];
      }

      // Add search filter using $or with regex
      // Combined with AND for other filters: (categoryIds = X) AND (front OR back OR hint matches search)
      if (search && (search as string).trim()) {
        const searchText = (search as string).trim();
        const searchRegex = new RegExp(searchText, 'i');
        const searchConditions = [
          { front: searchRegex },
          { back: searchRegex },
          { hint: searchRegex },
          { tags: searchRegex },
          { 'category.name': searchRegex },
          { 'primaryCategory.name': searchRegex },
          { 'categories.name': searchRegex }
        ];

        // If we already have an $or for visibility, wrap both in $and
        if (matchStage.$or) {
          const visibilityCondition = { $or: matchStage.$or };
          delete matchStage.$or;
          matchStage.$and = [
            visibilityCondition,
            { $or: searchConditions }
          ];
        } else {
          matchStage.$or = searchConditions;
        }
      }

      console.log('[Flashcards] Query params:', { filterCategoryId, search, userId, page, pageSize });
      console.log('[Flashcards] Match stage:', JSON.stringify(matchStage, null, 2));

      // Calculate pagination
      const pageNum = page ? parseInt(page as string, 10) : 1;
      const size = pageSize ? parseInt(pageSize as string, 10) : (limit ? parseInt(limit as string, 10) : 12);
      const skipCount = skip ? parseInt(skip as string, 10) : (pageNum - 1) * size;

      // Build sort stage
      let sortStage: any = { createdAt: -1 };
      if (sort) {
        try {
          sortStage = JSON.parse(sort as string);
        } catch (e) {
          // Keep default sort
        }
      }

      // Use aggregate pipeline for efficient querying
      const pipeline = [
        { $match: matchStage },
        { $sort: sortStage },
        {
          $facet: {
            rows: [
              { $skip: skipCount },
              { $limit: size }
            ],
            totalCount: [
              { $count: 'count' }
            ]
          }
        }
      ];

      const result = await Flashcard.aggregate(pipeline).exec();

      const flashcards = result[0]?.rows || [];
      const total = result[0]?.totalCount[0]?.count || 0;

      res.json({ result: flashcards, count: total, total });
    } catch (error: any) {
      console.error('[Flashcards] Get all error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Search flashcards - must be before /:id route
  router.get('/flashcards/search/:query', async (req, res) => {
    try {
      const { limit, skip, userId } = req.query;
      const options: any = {};
      if (limit) options.limit = parseInt(limit as string, 10);
      if (skip) options.skip = parseInt(skip as string, 10);

      // Build filters for user-scoped search
      // Users can see their own cards OR public cards
      const filters: any = {};
      if (userId) {
        filters.$or = [
          { createdBy: userId },
          { isPublic: true }
        ];
      }

      const flashcards = await flashcardService.search(req.params.query, filters, options);
      res.json({ result: flashcards });
    } catch (error: any) {
      console.error('[Flashcards] Search error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get flashcards by question - must be before /:id route
  router.get('/flashcards/question/:questionId', async (req, res) => {
    try {
      const flashcards = await flashcardService.getByQuestionId(req.params.questionId);
      res.json({ result: flashcards });
    } catch (error: any) {
      console.error('[Flashcards] Get by question error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get flashcard by ID
  router.get('/flashcards/:id', async (req, res) => {
    try {
      const flashcard = await flashcardService.getById(req.params.id);
      if (!flashcard) {
        return res.status(404).json({ error: 'Flashcard not found' });
      }
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Get by ID error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update flashcard
  router.put('/flashcards/:id', async (req, res) => {
    try {
      const flashcard = await flashcardService.update(req.params.id, req.body);
      if (!flashcard) {
        return res.status(404).json({ error: 'Flashcard not found' });
      }
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Update error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Add question reference
  router.post('/flashcards/:id/questions/:questionId', async (req, res) => {
    try {
      const flashcard = await flashcardService.addQuestionReference(
        req.params.id,
        req.params.questionId
      );
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Add question ref error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Remove question reference
  router.delete('/flashcards/:id/questions/:questionId', async (req, res) => {
    try {
      const flashcard = await flashcardService.removeQuestionReference(
        req.params.id,
        req.params.questionId
      );
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Remove question ref error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete flashcard (soft delete)
  router.delete('/flashcards/:id', async (req, res) => {
    try {
      const flashcard = await flashcardService.delete(req.params.id);
      if (!flashcard) {
        return res.status(404).json({ error: 'Flashcard not found' });
      }
      res.json({ result: flashcard, message: 'Flashcard deleted' });
    } catch (error: any) {
      console.error('[Flashcards] Delete error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== QUIZ MODE & QUESTION LINKING ====================

  // Get all quizzable flashcards - must be before /:id routes
  router.get('/flashcards/quizzable', async (req, res) => {
    try {
      const { category, categoryId, limit, skip, sort } = req.query;

      const filters: any = {};
      if (category) filters.category = category;
      if (categoryId) filters.categoryId = categoryId;

      const options: any = {};
      if (limit) options.limit = parseInt(limit as string, 10);
      if (skip) options.skip = parseInt(skip as string, 10);
      if (sort) options.sort = JSON.parse(sort as string);

      const flashcards = await flashcardService.getQuizzableFlashcards(filters, options);
      const total = await flashcardService.count({ canBeQuizzed: true, ...filters });

      res.json({ result: flashcards, total });
    } catch (error: any) {
      console.error('[Flashcards] Get quizzable error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get flashcard by linked question ID - must be before /:id routes
  router.get('/flashcards/linked-question/:questionId', async (req, res) => {
    try {
      const flashcard = await flashcardService.getByLinkedQuestionId(req.params.questionId);
      if (!flashcard) {
        return res.status(404).json({ error: 'No flashcard linked to this question' });
      }
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Get by linked question error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Enable quiz mode for a flashcard
  router.post('/flashcards/:id/quiz/enable', async (req, res) => {
    try {
      const { linkedQuestionId } = req.body;
      const flashcard = await flashcardService.enableQuizMode(req.params.id, linkedQuestionId);
      if (!flashcard) {
        return res.status(404).json({ error: 'Flashcard not found' });
      }
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Enable quiz mode error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Disable quiz mode for a flashcard
  router.post('/flashcards/:id/quiz/disable', async (req, res) => {
    try {
      const { unlinkQuestion } = req.body;
      const flashcard = await flashcardService.disableQuizMode(req.params.id, unlinkQuestion);
      if (!flashcard) {
        return res.status(404).json({ error: 'Flashcard not found' });
      }
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Disable quiz mode error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Link flashcard to a primary question (1:1)
  router.post('/flashcards/:id/link/:questionId', async (req, res) => {
    try {
      const flashcard = await flashcardService.linkToQuestion(req.params.id, req.params.questionId);
      if (!flashcard) {
        return res.status(404).json({ error: 'Flashcard not found' });
      }
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Link to question error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Unlink flashcard from primary question
  router.delete('/flashcards/:id/link', async (req, res) => {
    try {
      const flashcard = await flashcardService.unlinkFromQuestion(req.params.id);
      if (!flashcard) {
        return res.status(404).json({ error: 'Flashcard not found' });
      }
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Unlink from question error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Bulk enable quiz mode
  router.post('/flashcards/bulk/quiz/enable', async (req, res) => {
    try {
      const { flashcardIds } = req.body;
      if (!flashcardIds || !Array.isArray(flashcardIds)) {
        return res.status(400).json({ error: 'flashcardIds array is required' });
      }
      const result = await flashcardService.bulkEnableQuizMode(flashcardIds);
      res.json({ result, modifiedCount: result.modifiedCount });
    } catch (error: any) {
      console.error('[Flashcards] Bulk enable quiz mode error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Bulk link flashcards to questions
  router.post('/flashcards/bulk/link', async (req, res) => {
    try {
      const { mappings } = req.body;
      if (!mappings || !Array.isArray(mappings)) {
        return res.status(400).json({ error: 'mappings array is required' });
      }
      const result = await flashcardService.bulkLinkToQuestions(mappings);
      res.json({ result, modifiedCount: result.modifiedCount });
    } catch (error: any) {
      console.error('[Flashcards] Bulk link error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Convert flashcard to question format (for promotion)
  router.get('/flashcards/:id/promote', async (req, res) => {
    try {
      const flashcard = await flashcardService.getById(req.params.id);
      if (!flashcard) {
        return res.status(404).json({ error: 'Flashcard not found' });
      }
      const questionData = flashcardService.flashcardToQuestionData(flashcard);
      res.json({ result: questionData, flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Promote error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== USER PROGRESS ====================

  // Get user's progress for all cards
  router.get('/progress/:userId', async (req, res) => {
    try {
      const progress = await userProgressService.getUserProgress(req.params.userId);
      res.json({ result: progress });
    } catch (error: any) {
      console.error('[Flashcards] Get progress error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get user's statistics
  router.get('/progress/:userId/stats', async (req, res) => {
    try {
      const stats = await userProgressService.getUserStats(req.params.userId);
      res.json({ result: stats });
    } catch (error: any) {
      console.error('[Flashcards] Get stats error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get FSRS scheduling preview - shows what each rating would do
  router.get('/progress/:userId/schedule/:flashcardId', async (req, res) => {
    try {
      const preview = await userProgressService.getSchedulingPreview(
        req.params.userId,
        req.params.flashcardId
      );
      res.json({ result: preview });
    } catch (error: any) {
      console.error('[Flashcards] Get schedule preview error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get retrievability (probability of recall) for a card
  router.get('/progress/:userId/retrievability/:flashcardId', async (req, res) => {
    try {
      const retrievability = await userProgressService.getRetrievability(
        req.params.userId,
        req.params.flashcardId
      );
      res.json({ result: { retrievability, percentage: Math.round(retrievability * 100) } });
    } catch (error: any) {
      console.error('[Flashcards] Get retrievability error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Migrate a card from SM-2 to FSRS
  router.post('/progress/:userId/migrate/:flashcardId', async (req, res) => {
    try {
      const progress = await userProgressService.migrateToFSRS(
        req.params.userId,
        req.params.flashcardId
      );
      res.json({ result: progress, message: 'Card migrated to FSRS' });
    } catch (error: any) {
      console.error('[Flashcards] Migrate to FSRS error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Suspend a card
  router.post('/progress/:userId/suspend/:flashcardId', async (req, res) => {
    try {
      const progress = await userProgressService.suspendCard(
        req.params.userId,
        req.params.flashcardId
      );
      res.json({ result: progress });
    } catch (error: any) {
      console.error('[Flashcards] Suspend error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Unsuspend a card
  router.post('/progress/:userId/unsuspend/:flashcardId', async (req, res) => {
    try {
      const progress = await userProgressService.unsuspendCard(
        req.params.userId,
        req.params.flashcardId
      );
      res.json({ result: progress });
    } catch (error: any) {
      console.error('[Flashcards] Unsuspend error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Reset a card's progress
  router.post('/progress/:userId/reset/:flashcardId', async (req, res) => {
    try {
      const progress = await userProgressService.resetCard(
        req.params.userId,
        req.params.flashcardId
      );
      res.json({ result: progress });
    } catch (error: any) {
      console.error('[Flashcards] Reset error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== STUDY SESSIONS ====================

  // Get study session
  router.get('/study/:userId', async (req, res) => {
    try {
      const { newLimit, reviewLimit, learningFirst } = req.query;

      const config: any = {};
      if (newLimit) config.newCardsLimit = parseInt(newLimit as string, 10);
      if (reviewLimit) config.reviewCardsLimit = parseInt(reviewLimit as string, 10);
      if (learningFirst !== undefined) config.learningFirst = learningFirst === 'true';

      const session = await studyService.getStudySession(req.params.userId, config);
      res.json({ result: session });
    } catch (error: any) {
      console.error('[Flashcards] Get study session error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Start category study session
  router.post('/study/:userId/category/:categoryId', async (req, res) => {
    try {
      const session = await studyService.startCategorySession(
        req.params.userId,
        req.params.categoryId
      );
      res.json({ result: session });
    } catch (error: any) {
      console.error('[Flashcards] Start category session error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Start question study session
  router.post('/study/:userId/question/:questionId', async (req, res) => {
    try {
      const session = await studyService.startQuestionSession(
        req.params.userId,
        req.params.questionId
      );
      res.json({ result: session });
    } catch (error: any) {
      console.error('[Flashcards] Start question session error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Submit answer - supports both FSRS (rating 1-4) and legacy SM-2 (quality 0-5)
  router.post('/study/:userId/answer/:flashcardId', async (req, res) => {
    try {
      const { rating, quality, responseTimeMs, useLegacyQuality } = req.body;

      // Determine which rating system to use
      let fsrsRating: number;
      let isLegacy = false;

      if (rating !== undefined) {
        // New FSRS rating (1-4)
        if (!FSRSService.isValidRating(rating)) {
          return res.status(400).json({
            error: 'Rating must be 1 (Again), 2 (Hard), 3 (Good), or 4 (Easy)'
          });
        }
        fsrsRating = rating;
      } else if (quality !== undefined) {
        // Legacy SM-2 quality (0-5) - convert to FSRS
        if (quality < 0 || quality > 5) {
          return res.status(400).json({
            error: 'Quality must be a number between 0 and 5'
          });
        }
        fsrsRating = quality;  // Will be converted by service
        isLegacy = true;
      } else {
        return res.status(400).json({
          error: 'Either rating (1-4) or quality (0-5) must be provided'
        });
      }

      const result = await studyService.submitAnswer(
        req.params.userId,
        req.params.flashcardId,
        fsrsRating,
        responseTimeMs,
        isLegacy || useLegacyQuality
      );
      res.json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Submit answer error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get daily forecast
  router.get('/study/:userId/forecast', async (req, res) => {
    try {
      const days = parseInt(req.query.days as string || '7', 10);
      const forecast = await studyService.getDailyForecast(req.params.userId, days);
      res.json({ result: forecast });
    } catch (error: any) {
      console.error('[Flashcards] Get forecast error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
