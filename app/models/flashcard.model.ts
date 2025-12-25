import * as mongoose from 'mongoose';
const Schema = mongoose.Schema;

/**
 * Flashcard Schema
 * Represents a single flashcard with front/back content
 * Many-to-many relationship with questions via questionIds array
 */
const FlashcardSchema = new Schema({
    // Front of the flashcard (the question/prompt)
    front: {
        type: String,
        required: true
    },

    // Back of the flashcard (the answer)
    back: {
        type: String,
        required: true
    },

    // Optional hint to help the user
    hint: {
        type: String
    },

    // Full category ancestry chain (from root to most specific)
    // Enables hierarchical filtering: query any level to get all cards beneath it
    // Example: [{ _id: "chess", name: "Chess" }, { _id: "openings", name: "Openings" }, { _id: "italian", name: "Italian Game" }]
    // Note: _id uses Mixed type to support both ObjectId and UUID/String formats (categories use Mixed _id)
    categories: [{
        _id: { type: Schema.Types.Mixed },
        name: { type: String }
    }],

    // Array of category IDs for efficient querying (denormalized from categories array)
    // Query: { categoryIds: "chess-id" } returns ALL cards under Chess
    // Note: Uses Mixed type to support both ObjectId and UUID/String formats
    categoryIds: [{
        type: Schema.Types.Mixed,
        index: true
    }],

    // The most specific (deepest) category - used for display and evaluation
    // Note: _id uses Mixed type to support both ObjectId and UUID/String formats
    primaryCategory: {
        _id: { type: Schema.Types.Mixed },
        name: { type: String }
    },

    // Legacy field for backward compatibility
    category: {
        type: String,
        index: true
    },

    // Legacy reference to category document
    // Note: Uses Mixed type to support both ObjectId and UUID/String formats
    categoryId: {
        type: Schema.Types.Mixed,
        index: true
    },

    // Tags for filtering and grouping
    tags: [{
        type: String
    }],

    // Many-to-many: References to question documents
    questionIds: [{
        type: Schema.Types.ObjectId,
        ref: 'Question',
        index: true
    }],

    // Primary linked question (1:1 relationship for promoted flashcards)
    linkedQuestionId: {
        type: Schema.Types.ObjectId,
        ref: 'Question',
        index: true
    },

    // Whether this flashcard can be used in quizzes/exams
    canBeQuizzed: {
        type: Boolean,
        default: false
    },

    // Difficulty level (1-5, used for initial scheduling)
    difficulty: {
        type: Number,
        default: 3,
        min: 1,
        max: 5
    },

    // Chess-specific fields
    fen: {
        type: String  // Chess position FEN if applicable
    },

    pgn: {
        type: String  // PGN moves if applicable
    },

    openingName: {
        type: String
    },

    // Media attachments
    frontImage: {
        type: String  // URL to image for front
    },

    backImage: {
        type: String  // URL to image for back
    },

    // Source information
    sourceType: {
        type: String,
        enum: ['manual', 'ai-generated', 'imported', 'video-transcript'],
        default: 'manual'
    },

    sourceId: {
        type: String  // Video ID, import ID, etc.
    },

    // Creator/owner (email or user identifier from JWT)
    createdBy: {
        type: String,
        index: true
    },

    // Whether this is a public flashcard
    isPublic: {
        type: Boolean,
        default: false
    },

    // Soft delete
    isActive: {
        type: Boolean,
        default: true
    },

    // Environment where flashcard was created (e.g., 'LOCAL', 'PROD')
    environment: {
        type: String,
        default: 'PROD'
    }
}, {
    timestamps: true,
    collection: 'flashcards'
});

// Indexes for common queries
FlashcardSchema.index({ category: 1, isActive: 1 });
FlashcardSchema.index({ categoryIds: 1, isActive: 1 });  // Main index for hierarchical queries
FlashcardSchema.index({ 'primaryCategory._id': 1, isActive: 1 });
FlashcardSchema.index({ tags: 1 });
FlashcardSchema.index({ createdBy: 1, isActive: 1 });
FlashcardSchema.index({ questionIds: 1 });
FlashcardSchema.index({ linkedQuestionId: 1 });
FlashcardSchema.index({ canBeQuizzed: 1, isActive: 1 });

export const Flashcard = mongoose.model('Flashcard', FlashcardSchema);
export { FlashcardSchema };
