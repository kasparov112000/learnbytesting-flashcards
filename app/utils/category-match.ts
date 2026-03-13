/**
 * Shared category matching logic for flashcard queries.
 * Builds MongoDB $match conditions for hierarchical category filtering,
 * user visibility, and base flashcard filters.
 */

interface CategoryMatchOptions {
  filterCategoryId?: string;
  filterCategoryName?: string;
  userId?: string;
  /** If true, excludes openingLine cardType (default: true) */
  excludeOpeningLines?: boolean;
}

/**
 * Build a MongoDB match stage for category-scoped flashcard queries.
 * Handles:
 * - Hierarchical categoryId matching (categoryIds, primaryCategory._id, categories._id, legacy categoryId)
 * - Category name fallback matching (regex + composite path)
 * - User visibility (createdBy OR isPublic)
 * - Base filters (isActive, exclude openingLine)
 */
export function buildCategoryMatchStage(options: CategoryMatchOptions = {}): any {
  const {
    filterCategoryId,
    filterCategoryName,
    userId,
    excludeOpeningLines = true,
  } = options;

  const matchStage: any = { isActive: true };
  if (excludeOpeningLines) {
    matchStage.cardType = { $nin: ['openingLine'] };
  }

  const andConditions: any[] = [];

  // Hierarchical category filtering
  if (filterCategoryId) {
    let categoryIdVariants: any[] = [filterCategoryId];

    const mongoose = require('mongoose');
    if (mongoose.Types.ObjectId.isValid(filterCategoryId)) {
      try {
        categoryIdVariants.push(new mongoose.Types.ObjectId(filterCategoryId));
      } catch (_e) {
        // Keep just the string version
      }
    }

    const categoryConditions: any[] = [
      { categoryIds: { $in: categoryIdVariants } },
      { 'primaryCategory._id': { $in: categoryIdVariants } },
      { 'categories._id': { $in: categoryIdVariants } },
      { categoryId: { $in: categoryIdVariants } },
    ];

    // When filterCategoryId is provided, only use ID-based matching.
    // Name-based fallback is only used when no ID is available (see else branch below).
    // Adding name conditions here causes cross-category pollution when different
    // categories share the same name (e.g., multiple "Traps" subcategories).

    andConditions.push({ $or: categoryConditions });
  } else if (filterCategoryName) {
    const nameRegex = new RegExp(`^${filterCategoryName}$`, 'i');
    const escapedName = filterCategoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const compositePathRegex = new RegExp(`::${escapedName}$`, 'i');

    andConditions.push({
      $or: [
        { 'primaryCategory.name': nameRegex },
        { 'categories.name': nameRegex },
        { categoryIds: compositePathRegex },
      ],
    });
  }

  // User visibility filter
  if (userId) {
    andConditions.push({
      $or: [
        { createdBy: userId },
        { isPublic: true },
      ],
    });
  }

  if (andConditions.length > 0) {
    matchStage.$and = andConditions;
  }

  return matchStage;
}
