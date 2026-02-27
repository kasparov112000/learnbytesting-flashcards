import { Deck } from '../models/deck.model';
import { Flashcard } from '../models/flashcard.model';
import { UserProgress } from '../models/user-progress.model';
import * as mongoose from 'mongoose';

export class DeckService {
    private flashcardService: any;
    private userProgressService: any;

    constructor(flashcardService?: any, userProgressService?: any) {
        this.flashcardService = flashcardService;
        this.userProgressService = userProgressService;
    }

    async create(data: any) {
        const deck = new Deck(data);
        return await deck.save();
    }

    async getById(id: string) {
        return await Deck.findById(id).populate('flashcardIds');
    }

    async update(id: string, data: any) {
        return await Deck.findByIdAndUpdate(id, data, { new: true });
    }

    async delete(id: string) {
        return await Deck.findByIdAndUpdate(id, { isActive: false }, { new: true });
    }

    async listByUser(userId: string, filters?: { deckType?: string; search?: string }) {
        const query: any = { createdBy: userId, isActive: true };
        if (filters?.deckType) query.deckType = filters.deckType;

        let q = Deck.find(query).sort({ updatedAt: -1 });

        if (filters?.search) {
            query.$text = { $search: filters.search };
            q = Deck.find(query).sort({ score: { $meta: 'textScore' }, updatedAt: -1 });
        }

        return await q.exec();
    }

    async search(query: string, filters?: { deckType?: string }) {
        const match: any = { isActive: true, $text: { $search: query } };
        if (filters?.deckType) match.deckType = filters.deckType;
        return await Deck.find(match).sort({ score: { $meta: 'textScore' } });
    }

    /**
     * Computed deck progress from FSRS UserProgress records.
     * No parallel tracking — FSRS is the single source of truth.
     */
    async getDeckProgress(deckId: string, userId: string) {
        const deck = await Deck.findById(deckId);
        if (!deck) return null;

        const flashcardIds = (deck as any).flashcardIds || [];
        if (flashcardIds.length === 0) {
            return {
                totalCards: 0, mastered: 0, learning: 0, review: 0, new: 0,
                avgAccuracy: 0, avgStability: 0, nextDueDate: null, masteryPercent: 0
            };
        }

        const objectIds = flashcardIds.map((id: any) =>
            typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
        );

        const progressRecords = await UserProgress.find({
            userId,
            flashcardId: { $in: objectIds }
        });

        const progressByCard = new Map<string, any>();
        for (const p of progressRecords) {
            progressByCard.set((p as any).flashcardId.toString(), p);
        }

        let mastered = 0, learning = 0, review = 0, newCount = 0;
        let totalAccuracy = 0, totalStability = 0, accuracyCount = 0;
        let earliestDue: Date | null = null;

        for (const cardId of objectIds) {
            const progress = progressByCard.get(cardId.toString());
            if (!progress) {
                newCount++;
                continue;
            }

            const state = progress.fsrsState ?? 0;
            switch (state) {
                case 0: newCount++; break;
                case 1: learning++; break;
                case 2: review++; break;
                case 3: learning++; break; // relearning counts as learning
            }

            // Mastered heuristic: stability > 30 days and in Review state
            if (state === 2 && progress.stability > 30) {
                mastered++;
            }

            if (progress.totalReviews > 0) {
                const acc = progress.correctCount / progress.totalReviews;
                totalAccuracy += acc;
                accuracyCount++;
            }
            totalStability += progress.stability || 0;

            if (progress.nextReviewDate) {
                const due = new Date(progress.nextReviewDate);
                if (!earliestDue || due < earliestDue) earliestDue = due;
            }
        }

        const totalCards = objectIds.length;
        return {
            totalCards,
            mastered,
            learning,
            review: review - mastered, // review minus the mastered subset
            new: newCount,
            avgAccuracy: accuracyCount > 0 ? Math.round((totalAccuracy / accuracyCount) * 100) : 0,
            avgStability: totalCards > 0 ? Math.round(totalStability / totalCards) : 0,
            nextDueDate: earliestDue?.toISOString() || null,
            masteryPercent: totalCards > 0 ? Math.round((mastered / totalCards) * 100) : 0
        };
    }

    /**
     * Get deck's cards with their UserProgress, filtered by study mode.
     */
    async getDeckStudyCards(deckId: string, userId: string, mode: string = 'all') {
        const deck = await Deck.findById(deckId).populate('flashcardIds');
        if (!deck) return [];

        const flashcards = (deck as any).flashcardIds || [];
        if (flashcards.length === 0) return [];

        const cardIds = flashcards.map((c: any) => c._id || c);
        const progressRecords = await UserProgress.find({
            userId,
            flashcardId: { $in: cardIds }
        });

        const progressByCard = new Map<string, any>();
        for (const p of progressRecords) {
            progressByCard.set((p as any).flashcardId.toString(), p);
        }

        const now = new Date();
        const results: any[] = [];

        for (const card of flashcards) {
            const cardId = (card._id || card).toString();
            const progress = progressByCard.get(cardId) || null;

            if (mode === 'due') {
                if (!progress || !progress.nextReviewDate || new Date(progress.nextReviewDate) > now) continue;
            } else if (mode === 'new') {
                if (progress && progress.fsrsState !== 0) continue;
            }

            results.push({ flashcard: card, progress });
        }

        return results;
    }

    async addCards(deckId: string, flashcardIds: string[], position?: number) {
        const deck = await Deck.findById(deckId);
        if (!deck) return null;

        const ids = flashcardIds.map(id => new mongoose.Types.ObjectId(id));
        const existing = (deck as any).flashcardIds as any[];

        if (position !== undefined && position >= 0 && position < existing.length) {
            existing.splice(position, 0, ...ids);
        } else {
            existing.push(...ids);
        }

        (deck as any).flashcardIds = existing;
        return await deck.save();
    }

    async removeCards(deckId: string, flashcardIds: string[]) {
        const removeSet = new Set(flashcardIds);
        return await Deck.findByIdAndUpdate(deckId, {
            $pull: { flashcardIds: { $in: flashcardIds.map(id => new mongoose.Types.ObjectId(id)) } }
        }, { new: true });
    }

    async reorderCards(deckId: string, flashcardIds: string[]) {
        const ids = flashcardIds.map(id => new mongoose.Types.ObjectId(id));
        return await Deck.findByIdAndUpdate(deckId, { flashcardIds: ids }, { new: true });
    }

    /**
     * Create a deck from a repertoire opening line.
     * Uses FlashcardService.createFromOpeningLine to create/dedup chessOpening flashcards,
     * then wraps them in a Deck.
     */
    async createFromRepertoire(data: {
        userId: string;
        userEmail?: string;
        openingName: string;
        eco?: string;
        pgn?: string;
        color?: 'white' | 'black';
        positions?: Array<{ fen: string; moveHistory: string[]; chosenMove: string; moveNumber: number }>;
    }) {
        const { userId, userEmail, openingName, eco, pgn, color, positions } = data;

        // If positions are provided, create flashcards from them
        let flashcardIds: string[] = [];
        if (positions && positions.length > 0 && this.flashcardService && this.userProgressService) {
            const result = await this.flashcardService.createFromOpeningLine({
                userId,
                userEmail: userEmail || userId,
                positions,
                eco: eco || '',
                openingName,
                color: color || 'white',
            }, this.userProgressService);
            flashcardIds = result.flashcardIds;
        } else if (this.flashcardService) {
            // Try to find existing flashcards for this opening
            const existing = await Flashcard.find({
                'chessData.openingName': openingName,
                createdBy: userId,
                cardType: 'chessOpening',
                isActive: true
            }).sort({ 'chessData.moves': 1 });
            flashcardIds = existing.map(c => c._id.toString());
        }

        // Check for existing deck with same opening for this user
        const existingDeck = await Deck.findOne({
            openingName,
            createdBy: userId,
            deckType: 'opening',
            isActive: true
        });

        if (existingDeck) {
            // Update existing deck with any new flashcard IDs
            const existingIds = new Set((existingDeck as any).flashcardIds.map((id: any) => id.toString()));
            const newIds = flashcardIds.filter(id => !existingIds.has(id));
            if (newIds.length > 0) {
                await Deck.findByIdAndUpdate(existingDeck._id, {
                    $push: { flashcardIds: { $each: newIds.map(id => new mongoose.Types.ObjectId(id)) } }
                });
            }
            return await Deck.findById(existingDeck._id).populate('flashcardIds');
        }

        // Create new deck
        const deck = new Deck({
            title: openingName,
            description: eco ? `${eco} — ${openingName}` : openingName,
            deckType: 'opening',
            flashcardIds: flashcardIds.map(id => new mongoose.Types.ObjectId(id)),
            createdBy: userId,
            source: 'repertoire',
            eco: eco || '',
            openingName,
            color: color || 'white',
            pgn: pgn || '',
            tags: ['opening', eco?.toLowerCase(), `${color || 'white'}-opening`].filter(Boolean)
        });

        await deck.save();
        return await Deck.findById(deck._id).populate('flashcardIds');
    }
}
