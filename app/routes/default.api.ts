import { DbService } from '../services/db.service';

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
      const flashcard = await flashcardService.create(req.body);
      res.status(201).json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Create error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Create multiple flashcards
  router.post('/flashcards/batch', async (req, res) => {
    try {
      const flashcards = await flashcardService.createMany(req.body.flashcards);
      res.status(201).json({ result: flashcards, count: flashcards.length });
    } catch (error: any) {
      console.error('[Flashcards] Batch create error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get all flashcards with filtering
  router.get('/flashcards', async (req, res) => {
    try {
      const { category, categoryId, tag, userId, limit, skip, sort } = req.query;

      const filters: any = {};
      if (category) filters.category = category;
      if (categoryId) filters.categoryId = categoryId;
      if (tag) filters.tags = tag;
      if (userId) filters.createdBy = userId;

      const options: any = {};
      if (limit) options.limit = parseInt(limit as string, 10);
      if (skip) options.skip = parseInt(skip as string, 10);
      if (sort) options.sort = JSON.parse(sort as string);

      const flashcards = await flashcardService.getAll(filters, options);
      const total = await flashcardService.count(filters);

      res.json({ result: flashcards, total });
    } catch (error: any) {
      console.error('[Flashcards] Get all error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Search flashcards - must be before /:id route
  router.get('/flashcards/search/:query', async (req, res) => {
    try {
      const { limit, skip } = req.query;
      const options: any = {};
      if (limit) options.limit = parseInt(limit as string, 10);
      if (skip) options.skip = parseInt(skip as string, 10);

      const flashcards = await flashcardService.search(req.params.query, options);
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

  // Submit answer
  router.post('/study/:userId/answer/:flashcardId', async (req, res) => {
    try {
      const { quality, responseTimeMs } = req.body;

      if (quality === undefined || quality < 0 || quality > 5) {
        return res.status(400).json({
          error: 'Quality must be a number between 0 and 5'
        });
      }

      const result = await studyService.submitAnswer(
        req.params.userId,
        req.params.flashcardId,
        quality,
        responseTimeMs
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
