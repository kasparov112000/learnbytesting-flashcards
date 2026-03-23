/**
 * Shared category matching logic for flashcard queries.
 * Builds MongoDB $match conditions for hierarchical category filtering,
 * user visibility, and base flashcard filters.
 */

interface CategoryMatchOptions {
  filterCategoryId?: string;
  filterCategoryName?: string;
  filterCategoryIds?: string[];
  /** Match only primaryCategory._id (excludes children categories) */
  exactCategoryId?: string;
  filterTags?: string[];
  filterFlashcardIds?: string[];
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
    filterCategoryIds,
    exactCategoryId,
    filterTags,
    filterFlashcardIds,
    userId,
    excludeOpeningLines = true,
  } = options;

  const matchStage: any = { isActive: { $ne: false } };
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

  // Exact category filtering — matches only primaryCategory (no children)
  if (exactCategoryId) {
    let exactIdVariants: any[] = [exactCategoryId];
    const mongoose = require('mongoose');
    if (mongoose.Types.ObjectId.isValid(exactCategoryId)) {
      try {
        exactIdVariants.push(new mongoose.Types.ObjectId(exactCategoryId));
      } catch (_e) { /* keep string only */ }
    }
    andConditions.push({ 'primaryCategory._id': { $in: exactIdVariants } });
  }

  // Multi-category filtering (array of category IDs)
  if (filterCategoryIds && filterCategoryIds.length > 0) {
    const mongoose = require('mongoose');
    const allVariants: any[] = [];
    for (const id of filterCategoryIds) {
      allVariants.push(id);
      if (mongoose.Types.ObjectId.isValid(id)) {
        try {
          allVariants.push(new mongoose.Types.ObjectId(id));
        } catch (_e) { /* keep string only */ }
      }
    }
    andConditions.push({
      $or: [
        { categoryIds: { $in: allVariants } },
        { 'primaryCategory._id': { $in: allVariants } },
        { 'categories._id': { $in: allVariants } },
        { categoryId: { $in: allVariants } },
      ],
    });
  }

  // Tag filtering
  if (filterTags && filterTags.length > 0) {
    andConditions.push({ tags: { $in: filterTags } });
  }

  // Flashcard ID filtering (for lesson-scoped study)
  if (filterFlashcardIds && filterFlashcardIds.length > 0) {
    const mongoose = require('mongoose');
    const objectIds = filterFlashcardIds.map(id => {
      if (mongoose.Types.ObjectId.isValid(id)) {
        try { return new mongoose.Types.ObjectId(id); } catch (_e) { /* fall through */ }
      }
      return id;
    });
    andConditions.push({ _id: { $in: objectIds } });
  }

  // User visibility filter
  // Cards are visible if:
  //   - Created by this user (private cards), OR
  //   - Explicitly public (isPublic: true), OR
  //   - isPublic not set (platform/script-created content — treated as accessible)
  // Only cards with isPublic: false are truly hidden from non-owners.
  if (userId) {
    andConditions.push({
      $or: [
        { createdBy: userId },
        { isPublic: { $ne: false } },
      ],
    });
  }

  if (andConditions.length > 0) {
    matchStage.$and = andConditions;
  }

  return matchStage;
}
