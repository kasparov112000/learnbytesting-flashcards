import { Flashcard } from '../models';
import * as mongoose from 'mongoose';

export class FlashcardService {
    /**
     * Create a new flashcard
     */
    async create(data: any) {
        const flashcard = new Flashcard(data);
        return await flashcard.save();
    }

    /**
     * Create multiple flashcards at once
     */
    async createMany(flashcards: any[]) {
        return await Flashcard.insertMany(flashcards);
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
     */
    async getByCategory(categoryId: string, options: { limit?: number; skip?: number } = {}) {
        return await this.getAll({ categoryId: new mongoose.Types.ObjectId(categoryId) }, options);
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
    async search(searchText: string, options: { limit?: number; skip?: number } = {}) {
        const regex = new RegExp(searchText, 'i');
        return await this.getAll({
            $or: [
                { front: regex },
                { back: regex },
                { hint: regex },
                { tags: regex }
            ]
        }, options);
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
            type: flashcard.fen ? 'chess' : 'flashcard',
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
}
