import { Flashcard } from '../models';
import * as mongoose from 'mongoose';
import { processChessData, convertLegacyToChessData, ChessData } from '../utils/chess-validation.util';
import { difficultyRegistry } from './difficulty-classifier';

export class FlashcardService {
    /**
     * Infer the cardType from flashcard data if not explicitly set.
     * Priority:
     * 1. If cardType is already set, keep it
     * 2. Chess data → chessPuzzle (or chessOpening if openingName is set)
     * 3. Options/wrongAnswers → multipleChoice (or trueFalse if exactly ["True","False"])
     * 4. Default → text
     */
    private inferCardType(data: any): any {
        if (data.cardType) {
            return data;
        }

        let cardType = 'text';

        // Check for match content
        if (data.matchPairs && data.matchPairs.length > 0) {
            return { ...data, cardType: 'match' };
        }

        // Check for code content
        if (data.codeData && (data.codeData.starterCode || data.codeData.solutionCode)) {
            return { ...data, cardType: 'code' };
        }

        // Check for chess content
        const hasChessData = (data.chessData?.moves && data.chessData.moves.length > 0) || data.pgn || data.fen;
        if (hasChessData) {
            const openingName = data.chessData?.openingName || data.openingName;
            cardType = openingName ? 'chessOpening' : 'chessPuzzle';
        }
        // Check for multiple choice / true-false content
        else if ((data.options && data.options.length > 0) || (data.wrongAnswers && data.wrongAnswers.length > 0)) {
            // True/False detection: exactly 2 options that are "True" and "False"
            if (data.options && data.options.length === 2) {
                const sorted = data.options.map((o: string) => o.toLowerCase()).sort();
                if (sorted[0] === 'false' && sorted[1] === 'true') {
                    cardType = 'trueFalse';
                } else {
                    cardType = 'multipleChoice';
                }
            } else {
                cardType = 'multipleChoice';
            }
        }

        return { ...data, cardType };
    }

    /**
     * Process chess data in a flashcard
     * - If chessData is provided, validate and compute targetFen
     * - If legacy fen/pgn is provided, convert to chessData format
     */
    private processChessFields(data: any): any {
        // If new chessData format is provided, validate it
        if (data.chessData && data.chessData.moves && data.chessData.moves.length > 0) {
            const validatedChessData = processChessData(data.chessData);
            return { ...data, chessData: validatedChessData };
        }

        // If legacy format is provided, convert to new format
        if (data.fen || data.pgn) {
            const chessData = convertLegacyToChessData(
                data.fen,
                data.pgn,
                data.openingName,
                data.startingFen
            );

            if (chessData) {
                return { ...data, chessData };
            }
        }

        return data;
    }

    /**
     * Ensure categoryIds array is populated from categories
     * This denormalized field enables efficient hierarchical queries
     */
    private ensureCategoryIds(data: any): any {
        // If categoryIds is already provided, use it
        if (data.categoryIds && Array.isArray(data.categoryIds) && data.categoryIds.length > 0) {
            return data;
        }

        // Extract categoryIds from categories array if present
        if (data.categories && Array.isArray(data.categories) && data.categories.length > 0) {
            const categoryIds = data.categories
                .map(cat => cat._id || cat.id)
                .filter(id => id != null);

            return { ...data, categoryIds };
        }

        return data;
    }

    /**
     * Create a new flashcard
     */
    async create(data: any) {
        let processedData = this.ensureCategoryIds(data);
        processedData = this.processChessFields(processedData);
        processedData = this.inferCardType(processedData);
        // Auto-classify difficulty if not explicitly provided
        if (!processedData.difficulty) {
            processedData.difficulty = difficultyRegistry.classify(processedData);
        }
        const flashcard = new Flashcard(processedData);
        return await flashcard.save();
    }

    /**
     * Create multiple flashcards at once
     */
    async createMany(flashcards: any[]) {
        const processedFlashcards = flashcards.map(fc => {
            let processed = this.ensureCategoryIds(fc);
            processed = this.processChessFields(processed);
            processed = this.inferCardType(processed);
            return processed;
        });
        return await Flashcard.insertMany(processedFlashcards);
    }

    /**
     * Get flashcard by ID
     */
    async getById(id: string) {
        return await Flashcard.findById(id).where({ isActive: true });
    }

    /**
     * Get all flashcards with optional filters
     */
    async getAll(filters: any = {}, options: { limit?: number; skip?: number; sort?: any } = {}) {
        const query: any = { isActive: true, ...filters };

        let cursor = Flashcard.find(query);

        if (options.sort) {
            cursor = cursor.sort(options.sort);
        }
        if (options.skip) {
            cursor = cursor.skip(options.skip);
        }
        if (options.limit) {
            cursor = cursor.limit(options.limit);
        }

        return await cursor.exec();
    }

    /**
     * Get flashcards by category
     * Supports both MongoDB ObjectId and string/UUID category IDs
     */
    async getByCategory(categoryId: string, options: { limit?: number; skip?: number } = {}) {
        // Use categoryIds array for hierarchical lookup (supports Mixed type)
        return await this.getAll({ categoryIds: categoryId }, options);
    }

    /**
     * Get flashcards by root/main category (for filtering all cards in a domain)
     * Uses categoryIds array which contains all ancestor IDs
     */
    async getByRootCategory(rootCategoryId: string, options: { limit?: number; skip?: number } = {}) {
        return await this.getAll({ categoryIds: rootCategoryId }, options);
    }

    /**
     * Get flashcards by child/sub category (for specific topic evaluation)
     * Uses primaryCategory._id for exact match on deepest category
     */
    async getByChildCategory(childCategoryId: string, options: { limit?: number; skip?: number } = {}) {
        return await this.getAll({ 'primaryCategory._id': childCategoryId }, options);
    }

    /**
     * Get flashcards by question ID (many-to-many lookup)
     */
    async getByQuestionId(questionId: string) {
        return await Flashcard.find({
            questionIds: new mongoose.Types.ObjectId(questionId),
            isActive: true
        });
    }

    /**
     * Get flashcards by tag
     */
    async getByTag(tag: string, options: { limit?: number; skip?: number } = {}) {
        return await this.getAll({ tags: tag }, options);
    }

    /**
     * Get flashcards created by a user
     */
    async getByUser(userId: string, options: { limit?: number; skip?: number } = {}) {
        return await this.getAll({ createdBy: new mongoose.Types.ObjectId(userId) }, options);
    }

    /**
     * Update a flashcard
     */
    async update(id: string, data: any) {
        return await Flashcard.findByIdAndUpdate(
            id,
            { $set: data },
            { new: true, runValidators: true }
        );
    }

    /**
     * Add question reference to flashcard
     */
    async addQuestionReference(flashcardId: string, questionId: string) {
        return await Flashcard.findByIdAndUpdate(
            flashcardId,
            { $addToSet: { questionIds: new mongoose.Types.ObjectId(questionId) } },
            { new: true }
        );
    }

    /**
     * Remove question reference from flashcard
     */
    async removeQuestionReference(flashcardId: string, questionId: string) {
        return await Flashcard.findByIdAndUpdate(
            flashcardId,
            { $pull: { questionIds: new mongoose.Types.ObjectId(questionId) } },
            { new: true }
        );
    }

    /**
     * Soft delete a flashcard
     */
    async delete(id: string) {
        return await Flashcard.findByIdAndUpdate(
            id,
            { $set: { isActive: false } },
            { new: true }
        );
    }

    /**
     * Hard delete a flashcard (use with caution)
     */
    async hardDelete(id: string) {
        return await Flashcard.findByIdAndDelete(id);
    }

    /**
     * Count flashcards matching filters
     */
    async count(filters: any = {}) {
        return await Flashcard.countDocuments({ isActive: true, ...filters });
    }

    /**
     * Search flashcards by text
     */
    async search(searchText: string, filters: any = {}, options: { limit?: number; skip?: number } = {}) {
        const regex = new RegExp(searchText, 'i');
        const searchConditions = [
            { front: regex },
            { back: regex },
            { hint: regex },
            { tags: regex }
        ];

        // Handle combining visibility $or with search $or using $and
        let searchFilters: any;
        if (filters.$or) {
            // If there's already a visibility $or filter, wrap both in $and
            const visibilityCondition = { $or: filters.$or };
            const { $or: _, ...otherFilters } = filters;
            searchFilters = {
                ...otherFilters,
                $and: [
                    visibilityCondition,
                    { $or: searchConditions }
                ]
            };
        } else {
            searchFilters = {
                ...filters,
                $or: searchConditions
            };
        }
        return await this.getAll(searchFilters, options);
    }

    // ============================================
    // Quiz Mode & Question Linking Methods
    // ============================================

    /**
     * Enable quiz mode for a flashcard (makes it available for exams)
     * Optionally link to an existing question
     */
    async enableQuizMode(flashcardId: string, linkedQuestionId?: string) {
        const updateData: any = { canBeQuizzed: true };
        if (linkedQuestionId) {
            updateData.linkedQuestionId = new mongoose.Types.ObjectId(linkedQuestionId);
        }
        return await Flashcard.findByIdAndUpdate(
            flashcardId,
            { $set: updateData },
            { new: true }
        );
    }

    /**
     * Disable quiz mode for a flashcard
     * Optionally unlink from question
     */
    async disableQuizMode(flashcardId: string, unlinkQuestion: boolean = false) {
        const updateData: any = { canBeQuizzed: false };
        if (unlinkQuestion) {
            return await Flashcard.findByIdAndUpdate(
                flashcardId,
                { $set: { canBeQuizzed: false }, $unset: { linkedQuestionId: 1 } },
                { new: true }
            );
        }
        return await Flashcard.findByIdAndUpdate(
            flashcardId,
            { $set: updateData },
            { new: true }
        );
    }

    /**
     * Link flashcard to a primary question (1:1 relationship)
     */
    async linkToQuestion(flashcardId: string, questionId: string) {
        return await Flashcard.findByIdAndUpdate(
            flashcardId,
            { $set: { linkedQuestionId: new mongoose.Types.ObjectId(questionId) } },
            { new: true }
        );
    }

    /**
     * Unlink flashcard from its primary question
     */
    async unlinkFromQuestion(flashcardId: string) {
        return await Flashcard.findByIdAndUpdate(
            flashcardId,
            { $unset: { linkedQuestionId: 1 } },
            { new: true }
        );
    }

    /**
     * Get all quizzable flashcards (can be included in exams)
     */
    async getQuizzableFlashcards(filters: any = {}, options: { limit?: number; skip?: number; sort?: any } = {}) {
        return await this.getAll({ canBeQuizzed: true, ...filters }, options);
    }

    /**
     * Get flashcard by its linked question ID
     */
    async getByLinkedQuestionId(questionId: string) {
        return await Flashcard.findOne({
            linkedQuestionId: new mongoose.Types.ObjectId(questionId),
            isActive: true
        });
    }

    /**
     * Bulk enable quiz mode for multiple flashcards
     */
    async bulkEnableQuizMode(flashcardIds: string[]) {
        const objectIds = flashcardIds.map(id => new mongoose.Types.ObjectId(id));
        return await Flashcard.updateMany(
            { _id: { $in: objectIds } },
            { $set: { canBeQuizzed: true } }
        );
    }

    /**
     * Bulk link flashcards to questions
     * @param mappings Array of { flashcardId, questionId } objects
     */
    async bulkLinkToQuestions(mappings: Array<{ flashcardId: string; questionId: string }>) {
        const bulkOps = mappings.map(mapping => ({
            updateOne: {
                filter: { _id: new mongoose.Types.ObjectId(mapping.flashcardId) },
                update: {
                    $set: {
                        linkedQuestionId: new mongoose.Types.ObjectId(mapping.questionId),
                        canBeQuizzed: true
                    }
                }
            }
        }));
        return await Flashcard.bulkWrite(bulkOps);
    }

    /**
     * Convert flashcard data to question format for promotion
     * This is used when creating a question from a flashcard
     */
    flashcardToQuestionData(flashcard: any) {
        return {
            question: flashcard.front,
            answer: flashcard.back,
            explanation: flashcard.hint || '',
            type: flashcard.cardType || (flashcard.fen ? 'chess' : 'flashcard'),
            difficulty: flashcard.difficulty || 3,
            category: flashcard.category,
            categoryId: flashcard.categoryId,
            tags: flashcard.tags || [],
            sourceType: 'flashcard',
            sourceId: flashcard._id?.toString(),
            // Chess-specific fields
            fen: flashcard.fen,
            pgn: flashcard.pgn,
            openingName: flashcard.openingName,
            // Media
            questionImage: flashcard.frontImage,
            answerImage: flashcard.backImage,
            // Metadata
            createdBy: flashcard.createdBy,
            isPublic: flashcard.isPublic
        };
    }


    /**
     * Create a flashcard from a question answer and record an FSRS review.
     * - Finds existing flashcard by FEN + front text to avoid duplicates
     * - Creates new flashcard if not found, assigns to user
     * - Submits FSRS review: correct → rating 3 (Good), incorrect → rating 1 (Again)
     * Returns { flashcard, progress, isNew }
     */
    async createFromQuestion(data: {
        userId: string;
        userEmail: string;
        isCorrect: boolean;
        question: {
            question: string;
            options: string[];
            correctAnswer: string;
            explanation: string;
            suggestedMove?: string;
        };
        chessContext: {
            fen: string;
            moveHistory?: string[];
            openingName?: string;
            playerColor?: string;
        };
        questionType?: string;
        categoryId?: string;
        categoryName?: string;
    }, userProgressService: any) {
        const { userId, userEmail, isCorrect, question, chessContext, questionType, categoryId, categoryName } = data;

        // 1. Check for existing flashcard (same FEN + same question text)
        let flashcard = await Flashcard.findOne({
            'chessData.startingFen': chessContext.fen,
            front: question.question,
            isActive: true
        });

        let isNew = false;

        if (!flashcard) {
            // Extract correct answer text (strip letter prefix like "a) " or "A) ")
            const correctOption = question.options.find(o => o.charAt(0).toLowerCase() === question.correctAnswer.toLowerCase()) || question.correctAnswer;
            const correctAnswerText = correctOption.replace(/^[a-dA-D]\)\s*/, '').trim();

            // Build back content: clean correct answer + explanation
            const backContent = `${correctAnswerText}\n\n${question.explanation}`;
            const hint = question.explanation ? question.explanation.split('.')[0] + '.' : undefined;

            // Separate wrong answers for future multiple choice quiz generation
            const wrongAnswers = question.options
                .filter(o => o.charAt(0).toLowerCase() !== question.correctAnswer.toLowerCase())
                .map(o => o.replace(/^[a-dA-D]\)\s*/, '').trim());

            const flashcardData: any = {
                front: question.question,
                back: backContent,
                hint,
                options: question.options,
                wrongAnswers,
                chessData: {
                    startingFen: chessContext.fen,
                    moves: chessContext.moveHistory || [],
                    openingName: chessContext.openingName,
                    orientation: chessContext.playerColor || 'white',
                },
                fen: chessContext.fen,
                openingName: chessContext.openingName,
                tags: ['chess', 'interactive-play', questionType].filter(Boolean),
                categoryIds: categoryId ? [categoryId] : [],
                categories: categoryId ? [{ _id: categoryId, name: categoryName || 'Chess' }] : [],
                sourceType: 'ai-generated',
                canBeQuizzed: true,
                createdBy: userId,
                userEmail,
                users: [userId],
                environment: process.env.ENV_NAME || 'LOCAL',
            };

            let processed = this.ensureCategoryIds(flashcardData);
            processed = this.processChessFields(processed);
            processed = this.inferCardType(processed);
            processed.difficulty = difficultyRegistry.classify(processed);
            flashcard = await new Flashcard(processed).save();
            isNew = true;
        } else {
            // Ensure user is in the users array
            const userExists = flashcard.users?.some(u => u?.toString() === userId);
            if (!userExists) {
                await Flashcard.findByIdAndUpdate(flashcard._id, { $addToSet: { users: userId } });
            }
        }

        // 2. Submit FSRS review: correct → 3 (Good), incorrect → 1 (Again)
        const rating = isCorrect ? 3 : 1;
        const progress = await userProgressService.processReview(userId, flashcard._id.toString(), rating);

        return { flashcard, progress, isNew };
    }

    /**
     * Create flashcards from an opening line (repertoire import).
     * One flashcard per position where the user has a move to play.
     * Deduplicates by startingFen + userId + cardType.
     * Initializes FSRS progress for each new card.
     */
    async createFromOpeningLine(data: {
        userId: string;
        userEmail: string;
        positions: Array<{
            fen: string;
            moveHistory: string[];
            chosenMove: string;
            moveNumber: number;
        }>;
        eco: string;
        openingName: string;
        color: 'white' | 'black';
        categoryId?: string;
        categoryName?: string;
        categories?: Array<{ _id: string; name: string }>;
        cardType?: string;
        gameId?: string;
        name?: string;
        tags?: string[];
    }, userProgressService: any) {
        const { userId, userEmail, positions, eco, openingName, color, categoryId, categoryName } = data;
        const resolvedCardType = data.cardType || 'chessOpening';
        // Prefer full categories array (with correct _ids); fall back to single categoryId/categoryName
        let resolvedCategories: Array<{ _id: string; name: string }> = data.categories?.length
            ? data.categories
            : categoryId ? [{ _id: categoryId, name: categoryName || 'Chess Openings' }] : [];

        // Fallback: if no categories provided, copy from an existing card for this user
        if (resolvedCategories.length === 0) {
            const existingCard = await Flashcard.findOne({
                createdBy: userId,
                cardType: resolvedCardType,
                isActive: true,
                'categories.0': { $exists: true }
            }).select('categories categoryIds primaryCategory').lean();
            if (existingCard?.categories?.length) {
                resolvedCategories = existingCard.categories.map((c: any) => ({ _id: c._id?.toString?.() || c._id, name: c.name }));
                console.log(`[createFromOpeningLine] Copied categories from existing card: ${JSON.stringify(resolvedCategories)}`);
            }
        }

        const resolvedCategoryIds = resolvedCategories.map(c => c._id);

        let created = 0;
        let updated = 0;
        const flashcardIds: string[] = [];

        for (const pos of positions) {
            // Dedup: same FEN, same user, same cardType, same opening
            // Must include openingName because the correct move from the same position
            // differs between openings (e.g., starting position → e4 vs c4 vs d4)
            const existing = await Flashcard.findOne({
                'chessData.startingFen': pos.fen,
                'chessData.openingName': openingName,
                createdBy: userId,
                cardType: resolvedCardType,
                isActive: true
            });

            if (existing) {
                // Ensure user is in the users array + backfill category data if missing
                const updateOps: any = { $addToSet: { users: userId } };
                if (resolvedCategories.length > 0) {
                    const hasCategoryIds = existing.categoryIds?.length > 0;
                    const hasCategories = existing.categories?.length > 0;
                    if (!hasCategoryIds) {
                        updateOps.$addToSet = { ...updateOps.$addToSet, categoryIds: { $each: resolvedCategoryIds } };
                    }
                    if (!hasCategories) {
                        updateOps.$set = { categories: resolvedCategories };
                    }
                }
                await Flashcard.findByIdAndUpdate(existing._id, updateOps);
                flashcardIds.push(existing._id.toString());
                updated++;
                continue;
            }

            const flashcardData: any = {
                front: `What is the correct move in the ${openingName}?`,
                back: pos.chosenMove,
                chessData: {
                    startingFen: pos.fen,
                    moves: pos.moveHistory,
                    openingName,
                    orientation: color,
                    ...(data.gameId ? { gameId: data.gameId } : {}),
                },
                cardType: resolvedCardType,
                moveNumber: pos.moveNumber, // passed to classifier
                tags: data.tags?.length ? data.tags : ['opening', eco.toLowerCase(), `${color}-opening`].filter(Boolean),
                difficulty: difficultyRegistry.classify({ cardType: 'chessOpening', moveNumber: pos.moveNumber, chessData: { moves: pos.moveHistory } }),
                canBeQuizzed: true,
                sourceType: 'imported',
                createdBy: userId,
                userEmail,
                users: [userId],
                categoryIds: resolvedCategoryIds,
                categories: resolvedCategories,
                ...(resolvedCategories.length > 0 ? { primaryCategory: resolvedCategories[resolvedCategories.length - 1] } : {}),
                environment: process.env.ENV_NAME || 'LOCAL',
                ...(data.name ? { name: data.name } : {}),
            };

            let processed = this.ensureCategoryIds(flashcardData);
            processed = this.processChessFields(processed);
            const flashcard = await new Flashcard(processed).save();
            flashcardIds.push(flashcard._id.toString());

            // Init FSRS progress
            try {
                await userProgressService.getOrCreate(userId, flashcard._id.toString());
            } catch (err) {
                console.warn(`[createFromOpeningLine] FSRS init failed for card ${flashcard._id}:`, (err as any).message);
            }

            created++;
        }

        console.log(`[createFromOpeningLine] ${openingName} (${eco}): created=${created}, updated=${updated}, total=${flashcardIds.length}`);
        return { created, updated, flashcardIds };
    }

    /**
     * Create or update a single Order-type flashcard that quizzes the user on the
     * correct move order of one variation (e.g. "The Byrne Variation — 4.Bg5").
     *
     * The Order card type already has a full drag-and-drop renderer in both the
     * webapp (card-order.component.ts) and lbt-mobile (section-study.page.ts).
     * This method feeds that renderer with variation moves so the user can
     * memorize the exact sequence.
     *
     * Dedup: one Order card per {userId, openingName, variationName, cardType=order}
     * so repeated calls for the same variation UPDATE the existing card rather
     * than spawning duplicates — letting admins edit a variation and have the
     * card auto-sync.
     */
    async createFromVariationOrder(data: {
        userId: string;
        userEmail: string;
        openingName: string;          // parent course title (e.g. "Playing the Pirc Defense")
        variationName: string;        // section title (e.g. "The Byrne Variation — 4.Bg5")
        moves: string[];              // canonical move sequence, one ply per entry OR one full move per entry
        eco?: string;
        color?: 'white' | 'black';
        categoryId?: string;
        categoryName?: string;
        categories?: Array<{ _id: string; name: string }>;
        tags?: string[];
        difficulty?: number;
    }, userProgressService: any) {
        const { userId, userEmail, openingName, variationName, moves, eco, color } = data;
        if (!moves?.length) throw new Error('moves array is required and must be non-empty');

        // Resolve categories the same way createFromOpeningLine does
        let resolvedCategories: Array<{ _id: string; name: string }> = data.categories?.length
            ? data.categories
            : data.categoryId ? [{ _id: data.categoryId, name: data.categoryName || 'Chess Openings' }] : [];
        const resolvedCategoryIds = resolvedCategories.map(c => c._id);

        // Build orderData.items: one item per move in the sequence. The id must be
        // stable across rebuilds so existing cards get their items updated cleanly.
        // Using the 1-based position as id keeps this deterministic.
        const items = moves.map((move, i) => ({ id: String(i + 1), content: move }));
        const correctOrder = items.map(it => it.id);

        // Dedup key: same user + same opening + same variation + Order cardType.
        // This prevents dupes when the admin edits a variation and re-runs the build.
        const existing = await Flashcard.findOne({
            createdBy: userId,
            cardType: 'order',
            'orderData.variationName': variationName,
            'orderData.openingName': openingName,
            isActive: true,
        });

        const flashcardData: any = {
            // Front = the prompt the user sees. Using a consistent template so any
            // frontend can render it without needing to parse variationName out of orderData.
            front: `Put the moves of "${variationName}" in the correct order`,
            back: moves.join(' '),  // human-readable answer for reference
            cardType: 'order',
            orderData: {
                items,
                correctOrder,
                // Namespaced fields so the card's provenance is queryable without
                // polluting the generic orderData.items/correctOrder contract.
                openingName,
                variationName,
            },
            tags: data.tags?.length ? data.tags : ['opening', 'order', eco?.toLowerCase() || 'pirc', `${color || 'black'}-opening`].filter(Boolean),
            difficulty: data.difficulty ?? 2,    // default to "medium" for move-order drills
            canBeQuizzed: true,
            sourceType: 'imported',
            createdBy: userId,
            userEmail,
            users: [userId],
            categoryIds: resolvedCategoryIds,
            categories: resolvedCategories,
            ...(resolvedCategories.length > 0 ? { primaryCategory: resolvedCategories[resolvedCategories.length - 1] } : {}),
            environment: process.env.ENV_NAME || 'LOCAL',
        };

        if (existing) {
            // Update items + correctOrder in place (admin edited the variation).
            // Leave FSRS progress untouched — the user's review history for this
            // variation is still valid even if one move was swapped.
            await Flashcard.findByIdAndUpdate(existing._id, {
                $set: {
                    orderData: flashcardData.orderData,
                    front: flashcardData.front,
                    back: flashcardData.back,
                    tags: flashcardData.tags,
                    categoryIds: resolvedCategoryIds,
                    categories: resolvedCategories,
                },
                $addToSet: { users: userId },
            });
            console.log(`[createFromVariationOrder] Updated existing card for "${variationName}"`);
            return { created: 0, updated: 1, flashcardId: existing._id.toString(), isNew: false };
        }

        // Create a fresh Order card and seed FSRS progress so it enters the review queue
        const processed = this.ensureCategoryIds(flashcardData);
        const flashcard = await new Flashcard(processed).save();
        try {
            await userProgressService.getOrCreate(userId, flashcard._id.toString());
        } catch (err) {
            console.warn(`[createFromVariationOrder] FSRS init failed for card ${flashcard._id}:`, (err as any).message);
        }
        console.log(`[createFromVariationOrder] Created Order card for "${variationName}" (${moves.length} moves)`);
        return { created: 1, updated: 0, flashcardId: flashcard._id.toString(), isNew: true };
    }

    /**
     * Update a card's difficulty. If the user has no reviews yet, reseed FSRS.
     */
    async updateDifficulty(flashcardId: string, difficulty: number, userProgressService: any) {
        if (difficulty < 1 || difficulty > 5) {
            throw new Error('Difficulty must be between 1 and 5');
        }

        const flashcard = await Flashcard.findByIdAndUpdate(
            flashcardId,
            { difficulty },
            { new: true }
        );

        if (!flashcard) {
            throw new Error('Flashcard not found');
        }

        // Reseed FSRS if the user hasn't reviewed this card yet
        const userId = flashcard.createdBy;
        if (userId) {
            const progress = await userProgressService.getProgress(userId, flashcardId);
            if (progress && (progress.totalReviews || 0) === 0) {
                progress.fsrsDifficulty = difficulty * 2;
                await progress.save();
            }
        }

        return flashcard;
    }

    /**
     * Get chessOpening flashcards for a given opening and user.
     * Returns cards sorted by move history length (position order).
     */
    async getByOpening(openingName: string, userId: string, cardType?: string) {
        const flashcards = await Flashcard.find({
            'chessData.openingName': openingName,
            createdBy: userId,
            cardType: cardType || 'chessOpening',
            isActive: true
        }).lean();

        // Sort by move history length so index matches move position
        flashcards.sort((a: any, b: any) => {
            const aLen = a.chessData?.moves?.length || 0;
            const bLen = b.chessData?.moves?.length || 0;
            return aLen - bLen;
        });

        return flashcards;
    }

    // ============================================
    // Famous Games (game-type flashcards)
    // ============================================

    /**
     * Get all game-type flashcards (public catalog).
     * Returns cards with cardType='chessGame' that have famousGame metadata.
     */
    async getGames(filters?: { difficulty?: string; eco?: string }): Promise<any[]> {
        const query: any = {
            isActive: true,
            cardType: 'chessGame',
            'famousGame.title': { $exists: true }
        };
        if (filters?.difficulty) {
            query['famousGame.difficulty'] = filters.difficulty;
        }
        if (filters?.eco) {
            query['famousGame.eco'] = filters.eco;
        }
        return await Flashcard.find(query).sort({ 'famousGame.order': 1, 'famousGame.year': 1 }).lean();
    }

    /**
     * Get a single game flashcard by ID
     */
    async getGameById(id: string): Promise<any> {
        return await Flashcard.findOne({
            _id: id,
            isActive: true,
            cardType: 'chessGame',
            'famousGame.title': { $exists: true }
        }).lean();
    }

    /**
     * Search games by title, player name, or opening
     */
    async searchGames(query: string): Promise<any[]> {
        const regex = new RegExp(query, 'i');
        return await Flashcard.find({
            isActive: true,
            cardType: 'chessGame',
            'famousGame.title': { $exists: true },
            $or: [
                { 'famousGame.title': regex },
                { 'famousGame.whitePlayer': regex },
                { 'famousGame.blackPlayer': regex },
                { 'famousGame.openingName': regex }
            ]
        }).sort({ 'famousGame.order': 1 }).lean();
    }

    /**
     * Create a game flashcard (admin/migration).
     * Sets cardType='chessGame', isPublic=true, and embeds famousGame metadata.
     */
    async createGame(gameData: any): Promise<any> {
        const flashcardData = {
            front: `${gameData.title} (${gameData.year})`,
            back: `${gameData.whitePlayer} vs ${gameData.blackPlayer}`,
            cardType: 'chessGame',
            isPublic: true,
            famousGame: {
                title: gameData.title,
                whitePlayer: gameData.whitePlayer,
                blackPlayer: gameData.blackPlayer,
                year: gameData.year,
                event: gameData.event,
                eco: gameData.eco,
                openingName: gameData.openingName,
                pgn: gameData.pgn,
                moveCount: gameData.moveCount,
                description: gameData.description,
                themes: gameData.themes || [],
                difficulty: gameData.difficulty || 'intermediate',
                order: gameData.order || 0
            },
            tags: ['famous-game', gameData.eco?.toLowerCase(), gameData.difficulty].filter(Boolean),
            categories: gameData.categories || [],
            categoryIds: gameData.categoryIds || [],
            sourceType: 'imported',
            environment: process.env.ENV_NAME || 'LOCAL'
        };

        let processed = this.ensureCategoryIds(flashcardData);
        processed = this.inferCardType(processed);
        const flashcard = new Flashcard(processed);
        return await flashcard.save();
    }

    // ============================================
    // Opening Lines & Lessons (unified opening queries)
    // ============================================

    /**
     * Helper: extract opening metadata from either openingLine or openingLesson embedded field
     */
    private extractOpeningData(fc: any): any {
        const ol = fc.openingLine || fc.openingLesson;
        if (!ol) return null;
        return {
            _id: fc._id,
            eco: ol.eco,
            name: ol.openingName,
            variationName: ol.variationName,
            pgn: ol.pgn,
            moveCount: ol.moveCount,
            difficulty: ol.difficulty,
            order: ol.order,
            isVariation: ol.isVariation || false,
            mainOpeningName: ol.mainOpeningName,
            description: ol.description,
            title: ol.title
        };
    }

    /**
     * Opening card type filter: matches both openingLine and openingLesson
     */
    private get openingCardTypes() {
        return { $in: ['openingLine', 'openingLesson'] };
    }

    /**
     * Get all opening flashcards (public catalog).
     */
    async getOpenings(filters?: { difficulty?: string; eco?: string; letter?: string }): Promise<any[]> {
        const query: any = {
            isActive: true,
            cardType: this.openingCardTypes,
            $or: [{ 'openingLine.eco': { $exists: true } }, { 'openingLesson.eco': { $exists: true } }]
        };
        if (filters?.difficulty) {
            query.$or = [{ 'openingLine.difficulty': filters.difficulty }, { 'openingLesson.difficulty': filters.difficulty }];
        }
        if (filters?.eco) {
            query.$or = [{ 'openingLine.eco': filters.eco }, { 'openingLesson.eco': filters.eco }];
        }
        if (filters?.letter) {
            const letterRegex = new RegExp(`^${filters.letter}`, 'i');
            query.$or = [{ 'openingLine.eco': letterRegex }, { 'openingLesson.eco': letterRegex }];
        }
        return await Flashcard.find(query).sort({ 'openingLine.eco': 1, 'openingLesson.eco': 1 }).lean();
    }

    /**
     * Get a single opening flashcard by ID
     */
    async getOpeningById(id: string): Promise<any> {
        return await Flashcard.findOne({
            _id: id,
            isActive: true,
            cardType: this.openingCardTypes
        }).lean();
    }

    /**
     * Search openings by name, ECO code, or variation name
     */
    async searchOpenings(query: string): Promise<any[]> {
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        return await Flashcard.find({
            isActive: true,
            cardType: this.openingCardTypes,
            $or: [
                { 'openingLine.openingName': regex },
                { 'openingLine.eco': regex },
                { 'openingLine.variationName': regex },
                { 'openingLesson.openingName': regex },
                { 'openingLesson.eco': regex },
                { 'openingLesson.variationName': regex }
            ]
        }).sort({ 'openingLine.eco': 1, 'openingLesson.eco': 1 }).lean();
    }

    /**
     * Get opening categories aggregated by first letter of ECO code.
     * Returns { letter, name, count }[] matching current categories API shape.
     */
    async getOpeningCategories(): Promise<any[]> {
        const result = await Flashcard.aggregate([
            { $match: { isActive: true, cardType: this.openingCardTypes } },
            { $addFields: { _eco: { $ifNull: ['$openingLine.eco', '$openingLesson.eco'] } } },
            { $match: { _eco: { $exists: true, $ne: null } } },
            { $group: {
                _id: { $substrCP: ['$_eco', 0, 1] },
                count: { $sum: 1 }
            }},
            { $sort: { _id: 1 } }
        ]);

        const letterNames: Record<string, string> = {
            'A': 'Flank Openings',
            'B': 'Semi-Open Games',
            'C': 'Open Games & French',
            'D': 'Closed & Semi-Closed Games',
            'E': 'Indian Defenses'
        };

        return result.map(r => ({
            letter: r._id,
            name: letterNames[r._id] || r._id,
            count: r.count
        }));
    }

    /**
     * Get openings by letter (first char of ECO), grouped with variations.
     * Returns { openings: [...] } matching current categories API shape.
     */
    async getOpeningsByLetter(letter: string, page = 1, pageSize = 50): Promise<{ openings: any[]; total: number; hasMore: boolean }> {
        const letterRegex = new RegExp(`^${letter.toUpperCase()}`);
        const all = await Flashcard.find({
            isActive: true,
            cardType: this.openingCardTypes,
            $or: [{ 'openingLine.eco': letterRegex }, { 'openingLesson.eco': letterRegex }]
        }).sort({ 'openingLine.eco': 1, 'openingLesson.eco': 1 }).lean();

        // Group main openings with their variations
        const mainOpenings: any[] = [];
        const variationMap = new Map<string, any[]>();

        for (const fc of all) {
            const ol = this.extractOpeningData(fc);
            if (!ol) continue;
            if (ol.isVariation && ol.mainOpeningName) {
                const existing = variationMap.get(ol.mainOpeningName) || [];
                existing.push({
                    eco: ol.eco,
                    name: ol.variationName || ol.name,
                    pgn: ol.pgn,
                    isVariation: true,
                    mainOpeningName: ol.mainOpeningName
                });
                variationMap.set(ol.mainOpeningName, existing);
            } else {
                mainOpenings.push({
                    _id: ol._id,
                    eco: ol.eco,
                    name: ol.name,
                    pgn: ol.pgn,
                    isVariation: false,
                    variations: []
                });
            }
        }

        // Attach variations to main openings
        for (const op of mainOpenings) {
            op.variations = variationMap.get(op.name) || [];
        }

        const total = mainOpenings.length;
        const start = (page - 1) * pageSize;
        const paged = mainOpenings.slice(start, start + pageSize);

        return { openings: paged, total, hasMore: start + pageSize < total };
    }

    /**
     * Create an opening-line flashcard (admin/migration).
     */
    async createOpening(data: any): Promise<any> {
        const flashcardData = {
            front: `${data.openingName || data.name} (${data.eco})`,
            back: data.pgn || '',
            cardType: 'openingLine',
            isPublic: true,
            openingLine: {
                eco: data.eco,
                openingName: data.openingName || data.name,
                variationName: data.variationName,
                pgn: data.pgn,
                moveCount: data.moveCount || (data.pgn ? data.pgn.split(/\s+/).filter((t: string) => !t.match(/^\d+\.$/)).length : 0),
                difficulty: data.difficulty || 'intermediate',
                order: data.order || 0,
                description: data.description,
                isVariation: data.isVariation || false,
                mainOpeningName: data.mainOpeningName
            },
            tags: ['opening', data.eco?.toLowerCase(), data.eco?.[0]?.toLowerCase()].filter(Boolean),
            categories: data.categories || [],
            categoryIds: data.categoryIds || [],
            sourceType: 'imported',
            environment: process.env.ENV_NAME || 'LOCAL'
        };

        let processed = this.ensureCategoryIds(flashcardData);
        processed = this.inferCardType(processed);
        const flashcard = new Flashcard(processed);
        return await flashcard.save();
    }

    /**
     * Bulk create opening-line flashcards (for migration).
     */
    async bulkCreateOpenings(openings: any[]): Promise<any[]> {
        const docs = openings.map(data => ({
            front: `${data.openingName || data.name} (${data.eco})`,
            back: data.pgn || '',
            cardType: 'openingLine',
            isPublic: true,
            openingLine: {
                eco: data.eco,
                openingName: data.openingName || data.name,
                variationName: data.variationName,
                pgn: data.pgn,
                moveCount: data.moveCount || 0,
                difficulty: data.difficulty || 'intermediate',
                order: data.order || 0,
                description: data.description,
                isVariation: data.isVariation || false,
                mainOpeningName: data.mainOpeningName
            },
            tags: ['opening', data.eco?.toLowerCase(), data.eco?.[0]?.toLowerCase()].filter(Boolean),
            categories: data.categories || [],
            categoryIds: data.categoryIds || [],
            sourceType: 'imported',
            isActive: true,
            environment: process.env.ENV_NAME || 'LOCAL'
        }));
        return await Flashcard.insertMany(docs);
    }

    // ============================================
    // Opening Lessons (openingLesson-type flashcards)
    // ============================================

    /**
     * Get opening lessons with optional filters.
     */
    async getOpeningLessons(filters?: { eco?: string; difficulty?: string }): Promise<any[]> {
        const query: any = {
            isActive: true,
            cardType: 'openingLesson',
            'openingLesson.eco': { $exists: true }
        };
        if (filters?.eco) {
            query['openingLesson.eco'] = filters.eco;
        }
        if (filters?.difficulty) {
            query['openingLesson.difficulty'] = filters.difficulty;
        }
        return await Flashcard.find(query).sort({ 'openingLesson.eco': 1, 'openingLesson.difficulty': 1, 'openingLesson.order': 1 }).lean();
    }

    /**
     * Get opening lessons by ECO code.
     */
    async getOpeningLessonsByEco(eco: string): Promise<any[]> {
        return await Flashcard.find({
            isActive: true,
            cardType: 'openingLesson',
            'openingLesson.eco': eco
        }).sort({ 'openingLesson.difficulty': 1, 'openingLesson.order': 1 }).lean();
    }

    /**
     * Get opening lessons by ECO code and difficulty.
     */
    async getOpeningLessonsByEcoAndDifficulty(eco: string, difficulty: string): Promise<any[]> {
        return await Flashcard.find({
            isActive: true,
            cardType: 'openingLesson',
            'openingLesson.eco': eco,
            'openingLesson.difficulty': difficulty
        }).sort({ 'openingLesson.order': 1 }).lean();
    }

    /**
     * Search opening lessons by name, eco, title, or variation.
     */
    async searchOpeningLessons(query: string): Promise<any[]> {
        const regex = new RegExp(query, 'i');
        return await Flashcard.find({
            isActive: true,
            cardType: 'openingLesson',
            $or: [
                { 'openingLesson.openingName': regex },
                { 'openingLesson.eco': regex },
                { 'openingLesson.title': regex },
                { 'openingLesson.variationName': regex }
            ]
        }).sort({ 'openingLesson.eco': 1 }).lean();
    }

    /**
     * Create an opening lesson flashcard.
     */
    async createOpeningLesson(data: any): Promise<any> {
        const moveCount = data.moveCount || (data.pgn ? data.pgn.split(/\s+/).filter((t: string) => !t.match(/^\d+\.$/)).length : 0);
        const flashcardData = {
            front: data.title || `${data.openingName} - ${data.difficulty}`,
            back: data.pgn || '',
            cardType: 'openingLesson',
            isPublic: true,
            openingLesson: {
                eco: data.eco,
                openingName: data.openingName,
                variationName: data.variationName,
                difficulty: data.difficulty || 'beginner',
                title: data.title,
                description: data.description,
                pgn: data.pgn,
                moveCount,
                order: data.order || 0
            },
            tags: ['opening-lesson', data.eco?.toLowerCase(), data.difficulty].filter(Boolean),
            sourceType: 'imported',
            isActive: true,
            environment: process.env.ENV_NAME || 'LOCAL'
        };

        const flashcard = new Flashcard(flashcardData);
        return await flashcard.save();
    }

    /**
     * Bulk create opening lesson flashcards (for migration).
     */
    async bulkCreateOpeningLessons(lessons: any[]): Promise<any[]> {
        const docs = lessons.map(data => {
            const moveCount = data.moveCount || (data.pgn ? data.pgn.split(/\s+/).filter((t: string) => !t.match(/^\d+\.$/)).length : 0);
            return {
                front: data.title || `${data.openingName} - ${data.difficulty}`,
                back: data.pgn || '',
                cardType: 'openingLesson',
                isPublic: true,
                openingLesson: {
                    eco: data.eco,
                    openingName: data.openingName,
                    variationName: data.variationName,
                    difficulty: data.difficulty || 'beginner',
                    title: data.title,
                    description: data.description,
                    pgn: data.pgn,
                    moveCount,
                    order: data.order || 0
                },
                tags: ['opening-lesson', data.eco?.toLowerCase(), data.difficulty].filter(Boolean),
                sourceType: 'imported',
                isActive: true,
                environment: process.env.ENV_NAME || 'LOCAL'
            };
        });
        return await Flashcard.insertMany(docs);
    }

    /**
     * Get flashcards for ag-grid with server-side pagination using aggregate pipeline
     * Similar to auditlogs getGrid implementation
     */
    async getGrid(gridRequest: any): Promise<{ rows: any[]; lastRow: number; total?: number }> {
        try {
            const startRow = gridRequest?.startRow || 0;
            const endRow = gridRequest?.endRow || 50;
            const limit = endRow - startRow;

            console.log('[FLASHCARD-GRID] Request:', { startRow, endRow, limit });

            // Build match stage for filtering (exclude catalog card types from grid)
            const matchStage: any = { isActive: true, cardType: { $nin: ['openingLine'] } };
            const andConditions: any[] = [];

            // Apply category filter (hierarchical) with comprehensive ID/name matching
            if (gridRequest?.filterCategoryId || gridRequest?.filterCategoryName) {
                const categoryConditions: any[] = [];

                if (gridRequest?.filterCategoryId) {
                    // Try to convert to ObjectId if it looks like one, otherwise use as string
                    let categoryIdVariants: any[] = [gridRequest.filterCategoryId];
                    if (mongoose.Types.ObjectId.isValid(gridRequest.filterCategoryId)) {
                        try {
                            categoryIdVariants.push(new mongoose.Types.ObjectId(gridRequest.filterCategoryId));
                        } catch (e) {
                            // Keep just the string version
                        }
                    }

                    categoryConditions.push(
                        { categoryIds: { $in: categoryIdVariants } },
                        { 'primaryCategory._id': { $in: categoryIdVariants } },
                        { 'categories._id': { $in: categoryIdVariants } },
                        { categoryId: { $in: categoryIdVariants } }
                    );
                }

                // Only use name-based matching when no category ID is available.
                // When ID is present, name fallback causes cross-category pollution
                // when different categories share the same name (e.g., multiple "Traps").
                if (gridRequest?.filterCategoryName && !gridRequest?.filterCategoryId) {
                    const nameRegex = new RegExp(`^${gridRequest.filterCategoryName}$`, 'i');
                    categoryConditions.push(
                        { 'primaryCategory.name': nameRegex },
                        { 'categories.name': nameRegex }
                    );

                    const escapedName = gridRequest.filterCategoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const compositePathRegex = new RegExp(`::${escapedName}$`, 'i');
                    categoryConditions.push(
                        { categoryIds: compositePathRegex }
                    );
                }

                if (categoryConditions.length > 0) {
                    andConditions.push({ $or: categoryConditions });
                }
            }

            // Apply user filter (for data isolation)
            // Users can see their own cards OR any public cards
            if (gridRequest?.userId) {
                matchStage.$or = [
                    { createdBy: gridRequest.userId },
                    { isPublic: true }
                ];
            }

            // Apply search filter if present
            const searchText = gridRequest?.search?.search;
            if (searchText && searchText.trim()) {
                const searchRegex = new RegExp(searchText.trim(), 'i');
                const searchConditions = [
                    { front: searchRegex },
                    { back: searchRegex },
                    { hint: searchRegex },
                    { tags: searchRegex },
                    { 'category.name': searchRegex }
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

            // Apply column filters from ag-grid filterModel
            if (gridRequest?.filterModel) {
                Object.entries(gridRequest.filterModel).forEach(([field, filter]: [string, any]) => {
                    if (filter.filterType === 'text') {
                        if (filter.type === 'contains') {
                            matchStage[field] = new RegExp(filter.filter, 'i');
                        } else if (filter.type === 'equals') {
                            matchStage[field] = filter.filter;
                        } else if (filter.type === 'startsWith') {
                            matchStage[field] = new RegExp(`^${filter.filter}`, 'i');
                        }
                    } else if (filter.filterType === 'set' && filter.values) {
                        matchStage[field] = { $in: filter.values };
                    } else if (filter.filterType === 'date') {
                        const dateFilter: any = {};
                        if (filter.dateFrom) {
                            dateFilter.$gte = new Date(filter.dateFrom);
                        }
                        if (filter.dateTo) {
                            dateFilter.$lte = new Date(filter.dateTo);
                        }
                        if (Object.keys(dateFilter).length > 0) {
                            matchStage[field] = dateFilter;
                        }
                    }
                });
            }

            // Add category and other $and conditions to matchStage
            if (andConditions.length > 0) {
                if (matchStage.$and) {
                    matchStage.$and = matchStage.$and.concat(andConditions);
                } else {
                    matchStage.$and = andConditions;
                }
            }

            console.log('[FLASHCARD-GRID] Final matchStage:', JSON.stringify(matchStage, null, 2));

            // Build sort stage
            let sortStage: any = { createdDate: -1 }; // Default sort
            if (gridRequest?.sortModel && gridRequest.sortModel.length > 0) {
                sortStage = {};
                gridRequest.sortModel.forEach(sort => {
                    sortStage[sort.colId] = sort.sort === 'asc' ? 1 : -1;
                });
            }

            // Build aggregate pipeline
            const pipeline: any[] = [];

            // Match stage (always has at least isActive: true)
            pipeline.push({ $match: matchStage });

            // Sort stage
            pipeline.push({ $sort: sortStage });

            // Use $facet for efficient pagination with total count
            pipeline.push({
                $facet: {
                    rows: [
                        { $skip: startRow },
                        { $limit: limit }
                    ],
                    totalCount: [
                        { $count: 'count' }
                    ]
                }
            });

            console.log('[FLASHCARD-GRID] Pipeline:', JSON.stringify(pipeline, null, 2));

            // Execute aggregate pipeline
            const result = await Flashcard.aggregate(pipeline).exec();

            const rows = result[0]?.rows || [];
            const totalCount = result[0]?.totalCount[0]?.count || 0;

            // Determine lastRow for ag-grid infinite scroll
            const lastRow = startRow + rows.length >= totalCount ? totalCount : -1;

            console.log('[FLASHCARD-GRID] Result:', {
                rowCount: rows.length,
                totalCount,
                lastRow
            });

            // Log sample row for debugging
            if (rows.length > 0) {
                const sample = rows[0];
                console.log('[FLASHCARD-GRID] Sample row keys:', Object.keys(sample));
                console.log('[FLASHCARD-GRID] Sample row data:', JSON.stringify({
                    _id: sample._id,
                    front: sample.front,
                    back: sample.back,
                    category: sample.category,
                    primaryCategory: sample.primaryCategory,
                    categories: sample.categories
                }, null, 2));
            }

            return {
                rows,
                lastRow,
                total: totalCount
            };

        } catch (error) {
            console.error('[FLASHCARD-GRID] Error:', error);
            throw error;
        }
    }

}
