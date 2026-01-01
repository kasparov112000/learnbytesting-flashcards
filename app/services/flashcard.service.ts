import { Flashcard } from '../models';
import * as mongoose from 'mongoose';

export class FlashcardService {
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
        const processedData = this.ensureCategoryIds(data);
        const flashcard = new Flashcard(processedData);
        return await flashcard.save();
    }

    /**
     * Create multiple flashcards at once
     */
    async createMany(flashcards: any[]) {
        const processedFlashcards = flashcards.map(fc => this.ensureCategoryIds(fc));
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

            // Build match stage for filtering
            const matchStage: any = { isActive: true };
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

                if (gridRequest?.filterCategoryName) {
                    const nameRegex = new RegExp(`^${gridRequest.filterCategoryName}$`, 'i');
                    categoryConditions.push(
                        { 'primaryCategory.name': nameRegex },
                        { 'categories.name': nameRegex }
                    );

                    // Also match composite categoryIds that end with "::CategoryName"
                    // Escape special regex characters in the name
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
