import { DbService } from '../services/db.service';
import { Flashcard } from '../models';
import { DailyActivity } from '../models/daily-activity.model';
import { FSRSService } from '../services/fsrs.service';
import { AnalyticsService } from '../services/analytics.service';
import { CodeRunnerService } from '../services/code-runner.service';
import { buildCategoryMatchStage } from '../utils/category-match';
import { resolveLanguage, resolveLanguageMany } from '../utils/resolve-language.util';
import axios from 'axios';

// Get current environment for flashcard creation
const ENV_NAME = process.env.ENV_NAME || 'LOCAL';

/** Extract requested language from query string (defaults to 'en') */
function getLang(req: any): string {
  return (req.query?.lang as string) || 'en';
}

export default function (app, express, services) {
  let router = express.Router();
  const status = require('http-status');

  const { flashcardService, userProgressService, studyService, deckService } = services;
  const analyticsService = new AnalyticsService();
  // Code runner for executable card-editor flashcards (issue #185)
  const codeRunnerService = new CodeRunnerService();

  // ==================== HEALTH CHECK ====================

  router.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'flashcards' });
  });

  // ==================== DECKS ====================

  router.get('/decks/health', (req, res) => {
    res.json({ status: 'ok', service: 'flashcards-decks' });
  });

  router.get('/decks', async (req, res) => {
    try {
      const { userId, deckType, search } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const decks = await deckService.listByUser(userId, { deckType, search });
      res.json({ result: decks });
    } catch (err) {
      console.error('[Decks] GET /decks error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/decks/by-flashcard/:flashcardId', async (req, res) => {
    try {
      const decks = await deckService.findByFlashcardId(req.params.flashcardId);
      res.json({ result: decks });
    } catch (err) {
      console.error('[Decks] GET /decks/by-flashcard/:flashcardId error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  // Bulk lookup — returns active decks that contain ANY of the given
  // flashcardIds. Body uses POST (not GET) because the id list can exceed
  // URL length limits for large courses. Used by guided-lessons to derive
  // a course's deck list from its flashcard graph (Phase 2 of course
  // centralization).
  router.post('/decks/by-flashcards', async (req, res) => {
    try {
      const { flashcardIds } = req.body || {};
      if (!Array.isArray(flashcardIds)) {
        return res.status(400).json({ error: 'Body must include { flashcardIds: string[] }' });
      }
      const decks = await deckService.findByFlashcardIds(flashcardIds);
      res.json({ result: decks });
    } catch (err) {
      console.error('[Decks] POST /decks/by-flashcards error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/decks/:id', async (req, res) => {
    try {
      const deck = await deckService.getById(req.params.id);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });
      res.json({ result: deck });
    } catch (err) {
      console.error('[Decks] GET /decks/:id error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.post('/decks', async (req, res) => {
    try {
      const deck = await deckService.create(req.body);
      res.status(201).json({ result: deck });
    } catch (err) {
      console.error('[Decks] POST /decks error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.put('/decks/:id', async (req, res) => {
    try {
      const deck = await deckService.update(req.params.id, req.body);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });
      res.json({ result: deck });
    } catch (err) {
      console.error('[Decks] PUT /decks/:id error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.delete('/decks/:id', async (req, res) => {
    try {
      const deck = await deckService.delete(req.params.id);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });
      res.json({ result: deck });
    } catch (err) {
      console.error('[Decks] DELETE /decks/:id error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/decks/:id/progress/:userId', async (req, res) => {
    try {
      const progress = await deckService.getDeckProgress(req.params.id, req.params.userId);
      if (!progress) return res.status(404).json({ error: 'Deck not found' });
      res.json({ result: progress });
    } catch (err) {
      console.error('[Decks] GET /decks/:id/progress error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/decks/:id/cards/:userId', async (req, res) => {
    try {
      const mode = (req.query.mode as string) || 'all';
      const cards = await deckService.getDeckStudyCards(req.params.id, req.params.userId, mode);
      res.json({ result: cards });
    } catch (err) {
      console.error('[Decks] GET /decks/:id/cards error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.post('/decks/:id/cards', async (req, res) => {
    try {
      const { flashcardIds, position } = req.body;
      const deck = await deckService.addCards(req.params.id, flashcardIds, position);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });
      res.json({ result: deck });
    } catch (err) {
      console.error('[Decks] POST /decks/:id/cards error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.delete('/decks/:id/cards', async (req, res) => {
    try {
      const { flashcardIds } = req.body;
      const deck = await deckService.removeCards(req.params.id, flashcardIds);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });
      res.json({ result: deck });
    } catch (err) {
      console.error('[Decks] DELETE /decks/:id/cards error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.put('/decks/:id/reorder', async (req, res) => {
    try {
      const { flashcardIds } = req.body;
      const deck = await deckService.reorderCards(req.params.id, flashcardIds);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });
      res.json({ result: deck });
    } catch (err) {
      console.error('[Decks] PUT /decks/:id/reorder error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.post('/decks/from-repertoire', async (req, res) => {
    try {
      const deck = await deckService.createFromRepertoire(req.body);
      res.status(201).json({ result: deck });
    } catch (err) {
      console.error('[Decks] POST /decks/from-repertoire error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  // ==================== OPENING LINES (openingLine-type flashcards) ====================

  router.get('/flashcards/openings/categories', async (req, res) => {
    try {
      const categories = await flashcardService.getOpeningCategories();
      res.json({ categories });
    } catch (err) {
      console.error('[Openings] GET /flashcards/openings/categories error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/openings/letter/:letter', async (req, res) => {
    try {
      const { page, pageSize } = req.query;
      const result = await flashcardService.getOpeningsByLetter(
        req.params.letter,
        page ? parseInt(page as string) : 1,
        pageSize ? parseInt(pageSize as string) : 50
      );
      res.json(result);
    } catch (err) {
      console.error('[Openings] GET /flashcards/openings/letter/:letter error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/openings/search', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      if (!q.trim()) return res.status(400).json({ error: 'Query parameter q is required' });
      const openings = await flashcardService.searchOpenings(q);
      // Map to response shape matching current categories API (supports both openingLine and openingLesson)
      const mapped = openings.map((fc: any) => {
        const olLine = fc.openingLine?.openingName ? fc.openingLine : null;
        const ol = olLine || fc.openingLesson;
        return {
          _id: fc._id,
          eco: ol?.eco,
          name: ol?.openingName,
          variationName: ol?.variationName,
          pgn: ol?.pgn,
          isVariation: ol?.isVariation || false,
          mainOpeningName: ol?.mainOpeningName,
          moveCount: ol?.moveCount,
          difficulty: ol?.difficulty
        };
      });
      res.json({ openings: mapped });
    } catch (err) {
      console.error('[Openings] GET /flashcards/openings/search error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/openings/:id', async (req, res) => {
    try {
      const opening = await flashcardService.getOpeningById(req.params.id);
      if (!opening) return res.status(404).json({ error: 'Opening not found' });
      res.json({ result: opening });
    } catch (err) {
      console.error('[Openings] GET /flashcards/openings/:id error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.post('/flashcards/openings', async (req, res) => {
    try {
      const opening = await flashcardService.createOpening(req.body);
      res.status(201).json({ result: opening });
    } catch (err) {
      console.error('[Openings] POST /flashcards/openings error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.post('/flashcards/openings/bulk', async (req, res) => {
    try {
      const openings = req.body.openings || req.body;
      if (!Array.isArray(openings)) return res.status(400).json({ error: 'Expected array of openings' });
      const result = await flashcardService.bulkCreateOpenings(openings);
      res.status(201).json({ result, count: result.length });
    } catch (err) {
      console.error('[Openings] POST /flashcards/openings/bulk error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  // ==================== OPENING LESSONS (openingLesson-type flashcards) ====================

  router.get('/flashcards/opening-lessons/search', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      if (!q.trim()) return res.status(400).json({ error: 'Query parameter q is required' });
      const lessons = await flashcardService.searchOpeningLessons(q);
      res.json({ result: lessons });
    } catch (err) {
      console.error('[OpeningLessons] GET /flashcards/opening-lessons/search error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/opening-lessons/eco/:eco/difficulty/:difficulty', async (req, res) => {
    try {
      const lessons = await flashcardService.getOpeningLessonsByEcoAndDifficulty(req.params.eco, req.params.difficulty);
      res.json({ result: lessons });
    } catch (err) {
      console.error('[OpeningLessons] GET /flashcards/opening-lessons/eco/:eco/difficulty/:difficulty error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/opening-lessons/eco/:eco', async (req, res) => {
    try {
      const lessons = await flashcardService.getOpeningLessonsByEco(req.params.eco);
      res.json({ result: lessons });
    } catch (err) {
      console.error('[OpeningLessons] GET /flashcards/opening-lessons/eco/:eco error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/opening-lessons/:id', async (req, res) => {
    try {
      const lesson = await Flashcard.findOne({ _id: req.params.id, isActive: true, cardType: 'openingLesson' }).lean();
      if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
      res.json({ result: resolveLanguage(lesson, getLang(req)) });
    } catch (err) {
      console.error('[OpeningLessons] GET /flashcards/opening-lessons/:id error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/opening-lessons', async (req, res) => {
    try {
      const { eco, difficulty } = req.query;
      const lessons = await flashcardService.getOpeningLessons({
        eco: eco as string,
        difficulty: difficulty as string
      });
      res.json({ result: resolveLanguageMany(lessons, getLang(req)) });
    } catch (err) {
      console.error('[OpeningLessons] GET /flashcards/opening-lessons error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.post('/flashcards/opening-lessons', async (req, res) => {
    try {
      const lesson = await flashcardService.createOpeningLesson(req.body);
      res.status(201).json({ result: lesson });
    } catch (err) {
      console.error('[OpeningLessons] POST /flashcards/opening-lessons error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.post('/flashcards/opening-lessons/bulk', async (req, res) => {
    try {
      const lessons = req.body.lessons || req.body;
      if (!Array.isArray(lessons)) return res.status(400).json({ error: 'Expected array of lessons' });
      const result = await flashcardService.bulkCreateOpeningLessons(lessons);
      res.status(201).json({ result, count: result.length });
    } catch (err) {
      console.error('[OpeningLessons] POST /flashcards/opening-lessons/bulk error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.put('/flashcards/opening-lessons/:id', async (req, res) => {
    try {
      const lesson = await Flashcard.findOneAndUpdate(
        { _id: req.params.id, isActive: true, cardType: 'openingLesson' },
        { $set: { openingLesson: req.body.openingLesson || req.body, ...(req.body.front ? { front: req.body.front } : {}), ...(req.body.back ? { back: req.body.back } : {}) } },
        { new: true }
      );
      if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
      res.json({ result: lesson });
    } catch (err) {
      console.error('[OpeningLessons] PUT /flashcards/opening-lessons/:id error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.delete('/flashcards/opening-lessons/:id', async (req, res) => {
    try {
      const lesson = await Flashcard.findOneAndUpdate(
        { _id: req.params.id, cardType: 'openingLesson' },
        { $set: { isActive: false } },
        { new: true }
      );
      if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
      res.json({ result: lesson });
    } catch (err) {
      console.error('[OpeningLessons] DELETE /flashcards/opening-lessons/:id error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  // ==================== FAMOUS GAMES (game-type flashcards) ====================

  router.get('/flashcards/games/search', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      if (!q.trim()) return res.status(400).json({ error: 'Query parameter q is required' });
      const games = await flashcardService.searchGames(q);
      res.json({ result: games });
    } catch (err) {
      console.error('[Games] GET /flashcards/games/search error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/games/:id', async (req, res) => {
    try {
      const game = await flashcardService.getGameById(req.params.id);
      if (!game) return res.status(404).json({ error: 'Game not found' });
      res.json({ result: resolveLanguage(game, getLang(req)) });
    } catch (err) {
      console.error('[Games] GET /flashcards/games/:id error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/flashcards/games', async (req, res) => {
    try {
      const { difficulty, eco } = req.query;
      const games = await flashcardService.getGames({
        difficulty: difficulty as string,
        eco: eco as string
      });
      res.json({ result: resolveLanguageMany(games, getLang(req)) });
    } catch (err) {
      console.error('[Games] GET /flashcards/games error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.post('/flashcards/games', async (req, res) => {
    try {
      const game = await flashcardService.createGame(req.body);
      res.status(201).json({ result: game });
    } catch (err) {
      console.error('[Games] POST /flashcards/games error:', err);
      res.status(500).json({ error: (err as any).message });
    }
  });

  router.get('/pingflashcards', (req, res) => {
    console.log('info', 'GET Ping Flashcards', {
      timestamp: Date.now(),
      txnId: req.id
    });
    res.status(status.OK).json({ message: 'pong from flashcards' });
  });

  // ==================== FLASHCARD FROM QUESTION ====================

  // Create flashcard from a question answer + record FSRS review
  router.post('/flashcards/from-question', async (req, res) => {
    try {
      const { userId, userEmail, isCorrect, question, chessContext, questionType, categoryId, categoryName } = req.body;

      if (!userId || !question || !chessContext?.fen) {
        return res.status(400).json({ error: 'Missing required fields: userId, question, chessContext.fen' });
      }

      const result = await flashcardService.createFromQuestion(
        { userId, userEmail, isCorrect, question, chessContext, questionType, categoryId, categoryName },
        userProgressService
      );

      res.status(result.isNew ? 201 : 200).json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Create from question error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== FLASHCARD FROM OPENING LINE ====================

  // Create flashcards from an opening line (repertoire import)
  router.post('/flashcards/from-opening-line', async (req, res) => {
    try {
      const { userId, userEmail, positions, eco, openingName, color, categoryId, categoryName, categories, cardType, gameId, name, tags } = req.body;

      if (!userId || !positions?.length || !openingName) {
        return res.status(400).json({ error: 'Missing required fields: userId, positions, openingName' });
      }

      const result = await flashcardService.createFromOpeningLine(
        { userId, userEmail, positions, eco, openingName, color: color || 'white', categoryId, categoryName, categories, cardType, gameId, name, tags },
        userProgressService
      );

      res.status(200).json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Create from opening line error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== FROM GAME ANALYSIS ====================

  // Generates user-owned flashcards from a finished game's deep AI analysis.
  // Creates one chessPosition card per mistake + strategic-insight text cards
  // from the prose AI review. Returns the generated flashcard IDs so the caller
  // can register them in the user's customLessons[] structure.
  router.post('/flashcards/from-game-analysis', async (req, res) => {
    try {
      const { userId, userEmail, gameId, openingName, openingEco, playerColor, mistakes, aiReview } = req.body;

      if (!userId || !openingName) {
        return res.status(400).json({ error: 'Missing required fields: userId, openingName' });
      }

      const result = await flashcardService.createFromGameAnalysis(
        { userId, userEmail, gameId, openingName, openingEco, playerColor, mistakes, aiReview },
        userProgressService
      );

      res.status(201).json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Create from game analysis error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Bulk-delete flashcards by IDs — used by users microservice to cascade-remove
  // custom-from-analysis cards when a user is deleted. Protected only by the
  // orchestrator's auth layer; direct access not exposed to browsers.
  router.delete('/flashcards/bulk', async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids[] is required' });
      }
      const result = await flashcardService.bulkDeleteByIds(ids);
      res.status(200).json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Bulk delete by IDs error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== VARIATION ORDER CARD ====================

  // Create (or update) an Order-type flashcard that tests the correct move sequence
  // of a single course variation. Idempotent per {userId, openingName, variationName}
  // so re-calls with edited moves simply update the existing card — FSRS history preserved.
  router.post('/flashcards/from-variation-order', async (req, res) => {
    try {
      const { userId, userEmail, openingName, variationName, moves, eco, color, categoryId, categoryName, categories, tags, difficulty } = req.body;

      // Minimum viable input: need userId, the two naming fields, and a non-empty moves array
      if (!userId || !openingName || !variationName || !Array.isArray(moves) || moves.length === 0) {
        return res.status(400).json({ error: 'Missing required fields: userId, openingName, variationName, moves[]' });
      }

      const result = await flashcardService.createFromVariationOrder(
        { userId, userEmail, openingName, variationName, moves, eco, color, categoryId, categoryName, categories, tags, difficulty },
        userProgressService
      );

      // 201 when a brand-new card was created; 200 when an existing card was updated
      res.status(result.isNew ? 201 : 200).json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Create from variation order error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== FLASHCARD CRUD ====================

  // Create flashcard
  // Fetch multiple flashcards by their IDs (preserves input order)
  router.post('/flashcards/by-ids', async (req, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.json({ result: [] });
      }
      const cards = await flashcardService.getAll({ _id: { $in: ids } }, { limit: ids.length });
      const resolved = resolveLanguageMany(cards, getLang(req));
      // Preserve the order of the input ids array
      const cardMap = new Map(resolved.map((c: any) => [c._id?.toString(), c]));
      const ordered = ids.map((id: string) => cardMap.get(id)).filter(Boolean);
      res.json({ result: ordered });
    } catch (error: any) {
      console.error('[Flashcards] by-ids error:', error);
      res.status(500).json({ error: error.message });
    }
  });

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

      // If any flashcards have weakness tags, sync the weakness profile to the user
      const hasWeaknessTags = flashcards.some(fc => fc.weaknessTags && fc.weaknessTags.length > 0);
      if (hasWeaknessTags && flashcards.length > 0) {
        const userId = flashcards[0].users?.[0] || flashcards[0].createdBy;
        if (userId) {
          console.log('[Flashcards] Weakness tags detected, triggering analytics sync for user:', userId);
          // Run async - don't block the response
          analyticsService.recalculateAnalytics(userId.toString()).catch(err => {
            console.error('[Flashcards] Failed to sync weakness profile:', err.message);
          });
        }
      }

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
      const lang = getLang(req);
      if (result?.rows) {
        result.rows = resolveLanguageMany(result.rows, lang);
      }
      res.json(result);
    } catch (error: any) {
      console.error('[Flashcards] Grid error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get distinct categories with counts from flashcard data
  router.get('/flashcards/categories', async (req, res) => {
    try {
      const { filterCategoryId, filterCategoryIds: filterCategoryIdsRaw, filterCategoryName, filterCourseId } = req.query;
      const parsedFilterCategoryIds = filterCategoryIdsRaw
        ? (filterCategoryIdsRaw as string).split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const matchStage = buildCategoryMatchStage({
        filterCategoryId: filterCategoryId as string,
        filterCategoryIds: parsedFilterCategoryIds,
        filterCategoryName: filterCategoryName as string,
        filterCourseId: filterCourseId as string,
      });

      // Unwind the categories array and group by _id + name
      const pipeline = [
        { $match: matchStage },
        { $match: { categories: { $exists: true, $ne: [] } } },
        { $unwind: '$categories' },
        { $group: { _id: { id: '$categories._id', name: '$categories.name' }, count: { $sum: 1 } } },
        { $sort: { count: -1 as const } },
        { $project: { _id: '$_id.id', name: '$_id.name', count: 1 } }
      ];
      const categories = await Flashcard.aggregate(pipeline);
      res.json({ result: categories });
    } catch (error: any) {
      console.error('[Flashcards] GET /flashcards/categories error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Batch count of active flashcards per category ID (single DB call)
  router.post('/flashcards/counts-by-category-ids', async (req, res) => {
    try {
      const { categoryIds } = req.body;
      if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
        return res.json({ result: {} });
      }

      const mongoose = require('mongoose');
      // Build variants: keep string form + ObjectId form for each ID
      const idVariants: any[] = [];
      for (const id of categoryIds) {
        idVariants.push(id);
        if (mongoose.Types.ObjectId.isValid(id)) {
          try { idVariants.push(new mongoose.Types.ObjectId(id)); } catch (_) { /* keep string */ }
        }
      }

      const pipeline = [
        { $match: { isActive: true, categoryIds: { $in: idVariants } } },
        { $unwind: '$categoryIds' },
        { $match: { categoryIds: { $in: idVariants } } },
        { $group: { _id: '$categoryIds', count: { $sum: 1 } } }
      ];
      const rows = await Flashcard.aggregate(pipeline);

      // Collapse ObjectId and string forms into the original string keys
      const counts: Record<string, number> = {};
      for (const id of categoryIds) {
        counts[id] = 0;
      }
      for (const row of rows) {
        const key = String(row._id);
        // Match back to original categoryIds (string comparison)
        if (counts.hasOwnProperty(key)) {
          counts[key] += row.count;
        } else {
          // ObjectId may serialize differently — try matching all original IDs
          for (const id of categoryIds) {
            if (String(row._id) === String(id) || (mongoose.Types.ObjectId.isValid(id) && String(row._id) === String(new mongoose.Types.ObjectId(id)))) {
              counts[id] += row.count;
              break;
            }
          }
        }
      }

      res.json({ result: counts });
    } catch (error: any) {
      console.error('[Flashcards] POST /flashcards/counts-by-category-ids error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get cardType counts scoped to a category (and optionally a course)
  router.get('/flashcards/card-type-counts', async (req, res) => {
    try {
      const { filterCategoryId, filterCategoryIds: filterCategoryIdsRaw, filterCategoryName, filterCourseId } = req.query;
      const parsedFilterCategoryIds = filterCategoryIdsRaw
        ? (filterCategoryIdsRaw as string).split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const matchStage = buildCategoryMatchStage({
        filterCategoryId: filterCategoryId as string,
        filterCategoryIds: parsedFilterCategoryIds,
        filterCategoryName: filterCategoryName as string,
        filterCourseId: filterCourseId as string,
      });

      const pipeline = [
        { $match: matchStage },
        { $group: { _id: '$cardType', count: { $sum: 1 } } },
        { $sort: { count: -1 as const } },
        { $project: { _id: 0, cardType: '$_id', count: 1 } }
      ];
      const result = await Flashcard.aggregate(pipeline);
      res.json({ result });
    } catch (error: any) {
      console.error('[Flashcards] GET /flashcards/card-type-counts error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get distinct tags with counts, scoped to category and/or course
  router.get('/flashcards/tags', async (req, res) => {
    try {
      const { filterCategoryId, filterCategoryIds: filterCategoryIdsRaw, filterCategoryName, filterCourseId } = req.query;
      const parsedFilterCategoryIds = filterCategoryIdsRaw
        ? (filterCategoryIdsRaw as string).split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const matchStage = buildCategoryMatchStage({
        filterCategoryId: filterCategoryId as string,
        filterCategoryIds: parsedFilterCategoryIds,
        filterCategoryName: filterCategoryName as string,
        filterCourseId: filterCourseId as string,
      });
      // Tags endpoint additionally requires tags to exist
      matchStage.tags = { $exists: true, $ne: [] };

      const pipeline = [
        { $match: matchStage },
        { $unwind: '$tags' },
        { $group: { _id: '$tags', count: { $sum: 1 } } },
        { $sort: { count: -1 as const } },
        { $project: { _id: 0, tag: '$_id', count: 1 } }
      ];
      const tags = await Flashcard.aggregate(pipeline);
      res.json({ result: tags });
    } catch (error: any) {
      console.error('[Flashcards] GET /flashcards/tags error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Stamp courseIds onto flashcards (idempotent backfill endpoint)
  // Accepts { courseId, flashcardIds } and uses $addToSet to avoid duplicates
  router.post('/flashcards/stamp-course-ids', async (req, res) => {
    try {
      const { courseId, flashcardIds } = req.body;
      if (!courseId || !Array.isArray(flashcardIds) || flashcardIds.length === 0) {
        return res.status(400).json({ error: 'courseId and flashcardIds[] are required' });
      }

      // Convert flashcard IDs to ObjectIds where valid
      const mongoose = require('mongoose');
      const objectIds = flashcardIds.map((id: string) => {
        if (mongoose.Types.ObjectId.isValid(id)) {
          try { return new mongoose.Types.ObjectId(id); } catch (_e) { /* fall through */ }
        }
        return id;
      });

      // $addToSet ensures courseId is only added once per flashcard (idempotent)
      const result = await Flashcard.updateMany(
        { _id: { $in: objectIds } },
        { $addToSet: { courseIds: courseId } }
      );

      console.log(`[Flashcards] stamp-course-ids: courseId=${courseId}, matched=${result.matchedCount}, modified=${result.modifiedCount}`);
      res.json({ result: { matched: result.matchedCount, modified: result.modifiedCount } });
    } catch (error: any) {
      console.error('[Flashcards] POST /flashcards/stamp-course-ids error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get all flashcards with filtering and search (using aggregate pipeline)
  router.get('/flashcards', async (req, res) => {
    try {
      const { category, categoryId, filterCategoryId, filterCategoryIds: filterCategoryIdsRaw, filterCategoryName, exactCategoryId, filterCourseId, tag, userId, limit, skip, sort, search, page, pageSize } = req.query;

      // Parse filterCategoryIds (comma-separated string → array)
      const filterCategoryIds = filterCategoryIdsRaw
        ? (filterCategoryIdsRaw as string).split(',').map(s => s.trim()).filter(Boolean)
        : undefined;

      // Build match stage using shared category-match helper
      const matchStage = buildCategoryMatchStage({
        filterCategoryId: filterCategoryId as string,
        filterCategoryIds,
        filterCategoryName: filterCategoryName as string,
        exactCategoryId: exactCategoryId as string,
        filterCourseId: filterCourseId as string,
        userId: userId as string,
      });

      // Legacy exact-match category field (when no hierarchical filter is provided)
      if (category) matchStage.category = category;
      if (!filterCategoryId && !filterCategoryName && categoryId) {
        matchStage.categoryId = categoryId;
      }
      if (tag) matchStage.tags = tag;
      if (req.query.cardType) matchStage.cardType = req.query.cardType;

      // Search filter (GET /flashcards specific)
      if (search && (search as string).trim()) {
        const searchText = (search as string).trim();
        const searchRegex = new RegExp(searchText, 'i');
        if (!matchStage.$and) matchStage.$and = [];
        matchStage.$and.push({
          $or: [
            { front: searchRegex },
            { back: searchRegex },
            { hint: searchRegex },
            { tags: searchRegex },
            { 'category.name': searchRegex },
            { 'primaryCategory.name': searchRegex },
            { 'categories.name': searchRegex }
          ]
        });
      }

      console.log('[Flashcards] Query params:', { filterCategoryId, filterCategoryName, search, userId, page, pageSize });

      // Calculate pagination
      const pageNum = page ? parseInt(page as string, 10) : 1;
      const size = pageSize ? parseInt(pageSize as string, 10) : (limit ? parseInt(limit as string, 10) : 12);
      const skipCount = skip ? parseInt(skip as string, 10) : (pageNum - 1) * size;

      // Build sort stage
      let sortStage: any = { createdAt: -1 };
      const isFsrsSort = sort === 'fsrs' && userId;
      if (sort && sort !== 'fsrs') {
        try {
          sortStage = JSON.parse(sort as string);
        } catch (e) {
          // Keep default sort
        }
      }

      // Build aggregate pipeline
      let pipeline: any[];

      if (isFsrsSort) {
        // FSRS-aware sort: join with UserProgress to order by spaced repetition priority
        // Priority: 1) overdue (most overdue first), 2) learning/relearning, 3) new, 4) future due
        const now = new Date();
        pipeline = [
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
                        { $eq: ['$flashcardId', '$$cardId'] }
                      ]
                    }
                  }
                },
                { $limit: 1 }
              ],
              as: '_progress'
            }
          },
          // Flatten the progress array to a single object (or null)
          {
            $addFields: {
              _prog: { $ifNull: [{ $arrayElemAt: ['$_progress', 0] }, null] },
            }
          },
          // Compute sort keys
          {
            $addFields: {
              _sortBucket: {
                $switch: {
                  branches: [
                    // Bucket 0: overdue cards (nextReviewDate <= now)
                    {
                      case: {
                        $and: [
                          { $ne: ['$_prog', null] },
                          { $ne: ['$_prog.nextReviewDate', null] },
                          { $lte: ['$_prog.nextReviewDate', now] }
                        ]
                      },
                      then: 0
                    },
                    // Bucket 1: learning/relearning cards
                    {
                      case: {
                        $and: [
                          { $ne: ['$_prog', null] },
                          { $in: ['$_prog.fsrsState', [1, 3]] }
                        ]
                      },
                      then: 1
                    },
                    // Bucket 2: new cards (no progress or state=new)
                    {
                      case: {
                        $or: [
                          { $eq: ['$_prog', null] },
                          { $eq: ['$_prog.fsrsState', 0] }
                        ]
                      },
                      then: 2
                    }
                  ],
                  // Bucket 3: future due (not yet due)
                  default: 3
                }
              },
              _sortDate: {
                $ifNull: ['$_prog.nextReviewDate', new Date('2099-01-01')]
              }
            }
          },
          // Sort by bucket first, then by nextReviewDate within each bucket
          { $sort: { _sortBucket: 1, _sortDate: 1 } },
          // Project FSRS progress fields onto the flashcard, then clean up internals
          {
            $addFields: {
              fsrsStatus: {
                $switch: {
                  branches: [
                    { case: { $eq: ['$_prog', null] }, then: 'new' },
                    { case: { $eq: ['$_prog.fsrsState', 0] }, then: 'new' },
                    {
                      case: {
                        $and: [
                          { $in: ['$_prog.fsrsState', [1, 3]] }
                        ]
                      },
                      then: {
                        $cond: [{ $eq: ['$_prog.fsrsState', 3] }, 'relearning', 'learning']
                      }
                    },
                    {
                      case: {
                        $and: [
                          { $ne: ['$_prog.nextReviewDate', null] },
                          { $lte: ['$_prog.nextReviewDate', now] }
                        ]
                      },
                      then: 'due'
                    }
                  ],
                  default: 'review'
                }
              },
              fsrsNextReview: '$_prog.nextReviewDate',
              fsrsStability: '$_prog.stability',
              fsrsTotalReviews: '$_prog.totalReviews',
              fsrsLastReview: '$_prog.lastReviewDate'
            }
          },
          // Clean up temporary fields
          {
            $project: {
              _progress: 0,
              _prog: 0,
              _sortBucket: 0,
              _sortDate: 0
            }
          },
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
      } else {
        // Standard sort (default: createdAt descending)
        pipeline = [
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
      }

      const result = await Flashcard.aggregate(pipeline).exec();

      const flashcards = result[0]?.rows || [];
      const total = result[0]?.totalCount[0]?.count || 0;

      res.json({ result: resolveLanguageMany(flashcards, getLang(req)), count: total, total });
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

  // Get available card types (enum values for dropdowns/filters)
  router.get('/flashcards/card-types', (_req, res) => {
    res.json({
      result: [
        { value: 'text', label: 'Text', icon: 'description' },
        { value: 'multipleChoice', label: 'Multiple Choice', icon: 'checklist' },
        { value: 'trueFalse', label: 'True / False', icon: 'toggle_on' },
        { value: 'chessPuzzle', label: 'Chess Puzzle', icon: 'extension' },
        { value: 'chessOpening', label: 'Chess Opening', icon: 'menu_book' },
        { value: 'chessGame', label: 'Chess Game', icon: 'sports_esports' },
        { value: 'match', label: 'Match', icon: 'compare_arrows' }
      ]
    });
  });

  // Get chessOpening flashcards for a given opening + user (for lesson practice)
  router.get('/flashcards/by-opening', async (req, res) => {
    try {
      const openingName = req.query.openingName as string;
      const userId = req.query.userId as string;
      const cardType = req.query.cardType as string | undefined;

      if (!openingName || !userId) {
        return res.status(400).json({ error: 'Missing required query params: openingName, userId' });
      }

      const flashcards = await flashcardService.getByOpening(openingName, userId, cardType);
      res.json({ result: flashcards });
    } catch (error: any) {
      console.error('[Flashcards] getByOpening error:', error);
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
      res.json({ result: resolveLanguage(flashcard, getLang(req)) });
    } catch (error: any) {
      console.error('[Flashcards] Get by ID error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== TRANSLATION CRUD ====================

  // Get full card with translations (admin/scripts)
  router.get('/flashcards/:id/translations', async (req, res) => {
    try {
      const card = await Flashcard.findById(req.params.id).lean();
      if (!card) return res.status(404).json({ error: 'Flashcard not found' });
      res.json({ result: card });
    } catch (error: any) {
      console.error('[Translations] GET error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Set translations for a language
  router.put('/flashcards/:id/translations/:lang', async (req, res) => {
    try {
      const { id, lang } = req.params;
      const card = await Flashcard.findByIdAndUpdate(
        id,
        { $set: { [`translations.${lang}`]: req.body } },
        { new: true }
      ).lean();
      if (!card) return res.status(404).json({ error: 'Flashcard not found' });
      res.json({ result: card });
    } catch (error: any) {
      console.error('[Translations] PUT error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Remove translations for a language
  router.delete('/flashcards/:id/translations/:lang', async (req, res) => {
    try {
      const { id, lang } = req.params;
      const card = await Flashcard.findByIdAndUpdate(
        id,
        { $unset: { [`translations.${lang}`]: 1 } },
        { new: true }
      ).lean();
      if (!card) return res.status(404).json({ error: 'Flashcard not found' });
      res.json({ result: card });
    } catch (error: any) {
      console.error('[Translations] DELETE error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Bulk set translations (for scripts)
  // Body: { translations: [{ flashcardId, lang, fields: { front, back, ... } }] }
  router.post('/flashcards/translations/bulk', async (req, res) => {
    try {
      const { translations } = req.body;
      if (!Array.isArray(translations)) return res.status(400).json({ error: 'Expected translations array' });

      const ops = translations.map((t: any) => ({
        updateOne: {
          filter: { _id: t.flashcardId },
          update: { $set: { [`translations.${t.lang}`]: t.fields } }
        }
      }));
      const result = await Flashcard.bulkWrite(ops);
      res.json({ result: { modified: result.modifiedCount, matched: result.matchedCount } });
    } catch (error: any) {
      console.error('[Translations] Bulk error:', error);
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

  // Update difficulty (user override)
  router.patch('/flashcards/:id/difficulty', async (req, res) => {
    try {
      const { difficulty } = req.body;
      if (!difficulty || difficulty < 1 || difficulty > 5) {
        return res.status(400).json({ error: 'difficulty must be between 1 and 5' });
      }
      const flashcard = await flashcardService.updateDifficulty(req.params.id, difficulty, userProgressService);
      res.json({ result: flashcard });
    } catch (error: any) {
      console.error('[Flashcards] Update difficulty error:', error);
      res.status(error.message === 'Flashcard not found' ? 404 : 500).json({ error: error.message });
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

  // ==================== CODE-EDITOR EXECUTION (issue #185) ====================

  // Run a learner's submitted code against the card's testCases in a sandboxed
  // python subprocess. Card MUST be cardType 'code-editor' with codeData.testCases.
  // Returns per-test pass/fail + aggregate. Hidden tests have their stdout +
  // expected/actual stripped so learners can't reverse-engineer them by probing.
  router.post('/flashcards/:id/run-code', async (req, res) => {
    try {
      // Body: { submittedCode: string, code?: string }
      // 'code' alias accepted for client convenience.
      const submittedCode = req.body?.submittedCode ?? req.body?.code;
      if (typeof submittedCode !== 'string' || submittedCode.length === 0) {
        return res.status(400).json({ error: 'submittedCode (string) is required in request body' });
      }
      // Cap submission size — prevents megabyte payloads from clogging the runner
      if (submittedCode.length > 100_000) {
        return res.status(413).json({ error: 'submittedCode exceeds 100KB limit' });
      }

      // Look up the card to retrieve its testCases / language / strategy
      const card: any = await flashcardService.getById(req.params.id);
      if (!card) return res.status(404).json({ error: 'Flashcard not found' });
      if (card.cardType !== 'code-editor') {
        return res.status(400).json({ error: `Card is not a code-editor (cardType='${card.cardType}')` });
      }
      const cd = card.codeData || {};
      if (!Array.isArray(cd.testCases) || cd.testCases.length === 0) {
        return res.status(400).json({ error: 'Card has no testCases configured' });
      }

      // Execute submission against test cases
      const result = await codeRunnerService.run({
        code: submittedCode,
        testCases: cd.testCases,
        language: cd.language || 'python',
        checkStrategy: cd.checkStrategy || 'output-match',
        timeoutMs: cd.timeoutMs || 5000
      });

      res.json({ result });
    } catch (error: any) {
      console.error('[Flashcards] run-code error:', error);
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

  // Batch progress — get FSRS progress for multiple flashcard IDs at once
  router.post('/progress/batch', async (req, res) => {
    try {
      const { userId, flashcardIds } = req.body;
      if (!userId || !Array.isArray(flashcardIds)) {
        return res.status(400).json({ error: 'userId and flashcardIds[] required' });
      }
      const UserProgress = require('mongoose').model('UserProgress');
      const progress = await UserProgress.find({
        userId,
        flashcardId: { $in: flashcardIds },
        isSuspended: { $ne: true }
      }).lean();
      res.json({ result: progress });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

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

  // Get user's progress for a specific flashcard
  router.get('/progress/:userId/:flashcardId', async (req, res) => {
    try {
      const progress = await userProgressService.getProgress(
        req.params.userId,
        req.params.flashcardId
      );
      res.json({ result: progress });
    } catch (error: any) {
      console.error('[Flashcards] Get card progress error:', error);
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

  // ============ Card View Tracking ============

  // Increment view count when a card is displayed (before review)
  router.post('/:id/viewed', async (req, res) => {
    try {
      const result = await Flashcard.findByIdAndUpdate(
        req.params.id,
        { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date() } },
        { new: true, select: 'viewCount lastViewedAt' }
      );
      if (!result) return res.status(404).json({ error: 'Card not found' });
      res.json({ result: { viewCount: result.viewCount, lastViewedAt: result.lastViewedAt } });
    } catch (error: any) {
      console.error('[Flashcards] View tracking error:', error);
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

  // Submit FSRS review (called by frontend flashcard service)
  router.post('/progress/:userId/submit/:flashcardId', async (req, res) => {
    try {
      const { rating, responseTimeMs, userEmail } = req.body;

      // Validate rating (FSRS uses 1-4)
      if (!rating || rating < 1 || rating > 4) {
        return res.status(400).json({
          error: 'Rating must be 1 (Again), 2 (Hard), 3 (Good), or 4 (Easy)'
        });
      }

      console.log('[Flashcards] Processing FSRS review:', {
        userId: req.params.userId,
        flashcardId: req.params.flashcardId,
        rating,
        responseTimeMs,
        userEmail
      });

      const progress = await userProgressService.processReview(
        req.params.userId,
        req.params.flashcardId,
        rating,
        responseTimeMs
      );

      // Update DailyActivity so the review counts toward "today" stats
      try {
        // Fetch the flashcard to get its cardType for per-type tracking
        const reviewedCard = await Flashcard.findById(req.params.flashcardId).select('cardType categories').lean();
        const cardType = (reviewedCard as any)?.cardType || 'unknown';
        const primaryCategory = (reviewedCard as any)?.categories?.[0];

        const dailyActivity = await (DailyActivity as any).getOrCreateToday(req.params.userId);
        dailyActivity.recordReview(
          rating,
          responseTimeMs || 0,
          primaryCategory?._id?.toString(),
          primaryCategory?.name,
          undefined, // isNewCard
          undefined, // weaknessTagData
          cardType   // per-type tracking
        );
        await dailyActivity.save();
      } catch (err: any) {
        console.warn('[Flashcards] DailyActivity update failed (non-blocking):', err.message);
      }

      // Notify stats service to invalidate cache (fire-and-forget)
      const STATS_URL = process.env.STATS_URL || 'http://localhost:3038';
      axios.post(`${STATS_URL}/events/flashcard-review`, {
        user_id: req.params.userId,
        flashcard_id: req.params.flashcardId,
        quality: rating,
        response_time_ms: responseTimeMs || 0
      }, { timeout: 3000 }).catch(() => {});

      // Send to Qdrant for RAG analytics (async, non-blocking)
      if (userEmail) {
        const QDRANT_WEBHOOK_URL = process.env.QDRANT_WEBHOOK_URL || 'https://n8n.learnbytesting.ai/webhook/save-practice-qdrant';
        const flashcard = await Flashcard.findById(req.params.flashcardId).populate('categoryId');
        const payload = {
          user_email: userEmail,
          flashcard_id: req.params.flashcardId,
          rating: rating,
          response_time_ms: responseTimeMs || 0,
          flashcard_front: (flashcard as any)?.front || '',
          flashcard_back: (flashcard as any)?.back || '',
          weakness_tags: (flashcard as any)?.weaknessTags || [],
          difficulty: (flashcard as any)?.difficulty || 3,
          category_name: (flashcard as any)?.categoryId?.name || (flashcard as any)?.category || 'Unknown',
          stability: (progress as any)?.stability || 0,
          new_stability: (progress as any)?.stability || 0,
          repetitions: (progress as any)?.repetitions || (progress as any)?.totalReviews || 0
        };

        axios.post(QDRANT_WEBHOOK_URL, payload, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000
        }).then(() => {
          console.log(`[Flashcards] Practice evaluation saved to Qdrant for user ${userEmail}`);
        }).catch((err) => {
          console.error(`[Flashcards] Failed to save to Qdrant: ${err.message}`);
        });
      }

      res.json({
        result: progress,
        message: 'Review processed successfully'
      });
    } catch (error: any) {
      console.error('[Flashcards] Submit FSRS review error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== STUDY SESSIONS ====================

  // Get next card (per-card fetch model)
  router.post('/study/:userId/next', async (req, res) => {
    try {
      const result = await studyService.getNextCard(req.params.userId, req.body);
      const lang = getLang(req);
      if (result?.card) {
        result.card = resolveLanguage(result.card, lang);
      }
      res.json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Get next card error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get due counts per category
  router.get('/study/:userId/due-counts', async (req, res) => {
    try {
      const categoryIds = req.query.categoryIds
        ? (Array.isArray(req.query.categoryIds)
          ? req.query.categoryIds as string[]
          : (req.query.categoryIds as string).split(','))
        : [];
      const result = await studyService.getDueCounts(req.params.userId, categoryIds);
      res.json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Get due counts error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get study suggestions
  router.get('/study/:userId/suggestions', async (req, res) => {
    try {
      const result = await studyService.getStudySuggestions(req.params.userId);
      res.json({ result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get study session
  router.get('/study/:userId', async (req, res) => {
    try {
      const { newLimit, reviewLimit, learningFirst, categoryId, categoryName } = req.query;

      const config: any = {};
      if (newLimit !== undefined && newLimit !== '') config.newCardsLimit = parseInt(newLimit as string, 10);
      if (reviewLimit !== undefined && reviewLimit !== '') config.reviewCardsLimit = parseInt(reviewLimit as string, 10);
      if (learningFirst !== undefined) config.learningFirst = learningFirst === 'true';
      if (categoryId) config.categoryId = categoryId;
      if (categoryName) config.categoryName = categoryName;

      const session = await studyService.getStudySession(req.params.userId, config);
      const lang = getLang(req);
      if (session?.cards) {
        session.cards = resolveLanguageMany(session.cards, lang);
      }
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
      const { rating, quality, responseTimeMs, useLegacyQuality, userEmail } = req.body;

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
        isLegacy || useLegacyQuality,
        userEmail  // Pass userEmail for Qdrant analytics
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

  // ==================== ANALYTICS ====================

  // Get analytics dashboard summary
  // Optional query params: categoryId (single) or categoryIds (comma-separated) - filter analytics to specific categories
  router.get('/analytics/:userId/summary', async (req, res) => {
    try {
      const categoryIds = req.query.categoryIds as string | undefined;
      const categoryId = req.query.categoryId as string | undefined;
      // Support both: comma-separated categoryIds or single categoryId
      const ids = categoryIds ? categoryIds.split(',').map(s => s.trim()).filter(Boolean) : (categoryId ? [categoryId] : undefined);
      const summary = await analyticsService.getSummary(req.params.userId, ids);
      res.json({ result: summary });
    } catch (error: any) {
      console.error('[Flashcards] Get analytics summary error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get mastery trend over time
  // Optional query params: days, categoryId
  router.get('/analytics/:userId/mastery-trend', async (req, res) => {
    try {
      const days = parseInt(req.query.days as string || '30', 10);
      const categoryId = req.query.categoryId as string | undefined;
      const trend = await analyticsService.getMasteryTrend(req.params.userId, days, categoryId);
      res.json({ result: trend });
    } catch (error: any) {
      console.error('[Flashcards] Get mastery trend error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get category statistics
  // Optional query param: categoryId - show stats for subcategories of this category
  router.get('/analytics/:userId/category-stats', async (req, res) => {
    try {
      const categoryId = req.query.categoryId as string | undefined;
      const stats = await analyticsService.getCategoryStats(req.params.userId, categoryId);
      res.json({ result: stats });
    } catch (error: any) {
      console.error('[Flashcards] Get category stats error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get streak information
  router.get('/analytics/:userId/streak', async (req, res) => {
    try {
      const streak = await analyticsService.getStreak(req.params.userId);
      res.json({ result: streak });
    } catch (error: any) {
      console.error('[Flashcards] Get streak error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get heatmap data
  // Optional query params: months, categoryId
  router.get('/analytics/:userId/heatmap', async (req, res) => {
    try {
      const months = parseInt(req.query.months as string || '12', 10);
      const categoryId = req.query.categoryId as string | undefined;
      const heatmap = await analyticsService.getHeatmapData(req.params.userId, months, categoryId);
      res.json({ result: heatmap });
    } catch (error: any) {
      console.error('[Flashcards] Get heatmap error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get weekly summary
  router.get('/analytics/:userId/weekly', async (req, res) => {
    try {
      const weeks = parseInt(req.query.weeks as string || '12', 10);
      const weekly = await analyticsService.getWeeklySummary(req.params.userId, weeks);
      res.json({ result: weekly });
    } catch (error: any) {
      console.error('[Flashcards] Get weekly summary error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get upcoming review forecast
  // Optional query params: days, categoryId
  router.get('/analytics/:userId/forecast', async (req, res) => {
    try {
      const days = parseInt(req.query.days as string || '7', 10);
      const categoryId = req.query.categoryId as string | undefined;
      const forecast = await analyticsService.getForecast(req.params.userId, days, categoryId);
      res.json({ result: forecast });
    } catch (error: any) {
      console.error('[Flashcards] Get analytics forecast error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get session history
  router.get('/analytics/:userId/sessions', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string || '10', 10);
      const sessions = await analyticsService.getSessionHistory(req.params.userId, limit);
      res.json({ result: sessions });
    } catch (error: any) {
      console.error('[Flashcards] Get session history error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Set daily goal
  router.post('/analytics/:userId/daily-goal', async (req, res) => {
    try {
      const { goal } = req.body;
      if (typeof goal !== 'number' || goal < 0) {
        return res.status(400).json({ error: 'Goal must be a positive number' });
      }
      const result = await analyticsService.setDailyGoal(req.params.userId, goal);
      res.json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Set daily goal error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Recalculate analytics (admin/maintenance)
  router.post('/analytics/:userId/recalculate', async (req, res) => {
    try {
      const analytics = await analyticsService.recalculateAnalytics(req.params.userId);
      res.json({ result: analytics, message: 'Analytics recalculated' });
    } catch (error: any) {
      console.error('[Flashcards] Recalculate analytics error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== WEAKNESS TAG ANALYTICS ====================

  // Get weakness tag statistics
  // Optional query param: tagType - filter by weakness type (e.g., 'endgame', 'tactics')
  router.get('/analytics/:userId/weakness-tags', async (req, res) => {
    try {
      const tagType = req.query.tagType as string | undefined;
      const stats = await analyticsService.getWeaknessTagStats(req.params.userId, tagType);
      res.json({ result: stats });
    } catch (error: any) {
      console.error('[Flashcards] Get weakness tag stats error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get aggregated weakness statistics by type
  router.get('/analytics/:userId/weakness-types', async (req, res) => {
    try {
      const stats = await analyticsService.getWeaknessTypeStats(req.params.userId);
      res.json({ result: stats });
    } catch (error: any) {
      console.error('[Flashcards] Get weakness type stats error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get mastery trend for a specific weakness tag
  // Query params: days (optional, default 30)
  router.get('/analytics/:userId/weakness-trend/:tagId', async (req, res) => {
    try {
      const days = parseInt(req.query.days as string || '30', 10);
      // Decode the tagId (it may be URL encoded due to colons)
      const tagId = decodeURIComponent(req.params.tagId);
      const trend = await analyticsService.getWeaknessTagTrend(req.params.userId, tagId, days);
      res.json({ result: trend });
    } catch (error: any) {
      console.error('[Flashcards] Get weakness tag trend error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get flashcards by weakness tag
  // Optional query params: userId (to filter by user), limit
  router.get('/flashcards/weakness/:tagId', async (req, res) => {
    try {
      const tagId = decodeURIComponent(req.params.tagId);
      const userId = req.query.userId as string | undefined;
      const limit = parseInt(req.query.limit as string || '50', 10);
      const flashcards = await analyticsService.getFlashcardsByWeaknessTag(tagId, userId, limit);
      res.json({ result: flashcards, count: flashcards.length });
    } catch (error: any) {
      console.error('[Flashcards] Get flashcards by weakness tag error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Start a weakness-targeted study session
  router.post('/study/:userId/weakness/:tagId', async (req, res) => {
    try {
      const tagId = decodeURIComponent(req.params.tagId);
      const userId = req.params.userId;

      // Get flashcards for this weakness tag
      const flashcards = await analyticsService.getFlashcardsByWeaknessTag(tagId, userId, 50);

      if (flashcards.length === 0) {
        return res.json({
          result: {
            cards: [],
            totalCount: 0,
            message: 'No flashcards found for this weakness tag'
          }
        });
      }

      // Get study cards from flashcard IDs
      const flashcardIds = flashcards.map((f: any) => f._id);
      const session = await studyService.getStudySessionByFlashcardIds(userId, flashcardIds);

      res.json({
        result: {
          ...session,
          weaknessTag: tagId,
          message: `Study session for weakness: ${tagId}`
        }
      });
    } catch (error: any) {
      console.error('[Flashcards] Start weakness session error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== STUDY SESSIONS (ANALYTICS) ====================

  // Start a tracked study session
  router.post('/session/:userId/start', async (req, res) => {
    try {
      const { sessionType, targetCategoryId } = req.body;
      const session = await analyticsService.startSession(
        req.params.userId,
        sessionType || 'all',
        targetCategoryId
      );
      res.json({ result: session });
    } catch (error: any) {
      console.error('[Flashcards] Start session error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // End a tracked study session
  router.post('/session/:sessionId/end', async (req, res) => {
    try {
      const stats = await analyticsService.endSession(req.params.sessionId);
      res.json({ result: stats });
    } catch (error: any) {
      console.error('[Flashcards] End session error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Record a review within a session
  router.post('/session/:sessionId/review', async (req, res) => {
    try {
      const { quality, responseTimeMs, categoryId, categoryName, isNewCard, weaknessTagData } = req.body;
      const result = await analyticsService.recordReview(
        req.params.sessionId,
        quality,
        responseTimeMs,
        categoryId,
        categoryName,
        isNewCard,
        weaknessTagData  // Array of { tagId, tagType, tagSpecific }
      );

      // Fire-and-forget webhook to stats service (via orchestrator)
      const orchestratorUrl = ENV_NAME === 'LOCAL'
        ? 'http://localhost:8080'
        : 'http://orchestrator-helm.default.svc.cluster.local:8080';
      axios.post(`${orchestratorUrl}/api/stats/events/flashcard-review`, {
        user_id: result?.userId || req.body.userId,
        session_id: req.params.sessionId,
        quality,
        response_time_ms: responseTimeMs,
        category_id: categoryId,
        category_name: categoryName,
        is_new_card: isNewCard,
        weakness_tags: (weaknessTagData || []).map((t: any) => t.tagId || t.tag),
        timestamp: new Date().toISOString(),
      }).catch(() => {});

      res.json({ result });
    } catch (error: any) {
      console.error('[Flashcards] Record review error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
