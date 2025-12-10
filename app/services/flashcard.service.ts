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
}
