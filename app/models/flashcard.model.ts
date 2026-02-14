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

    // Hierarchical weakness tags for learning analytics
    // Format: "weakness:type:specific" (e.g., "weakness:endgame:rook-technique")
    weaknessTags: [{
        type: String,
        index: true
    }],

    // Parsed weakness tag structure (denormalized for efficient querying)
    // Allows filtering at any level: by type, or type+specific
    weaknessTagData: [{
        fullTag: { type: String },           // "weakness:endgame:rook-technique"
        type: { type: String, index: true }, // "endgame"
        specific: { type: String },          // "rook-technique"
        source: {
            type: String,
            enum: ['notebooklm', 'llm-generated', 'manual', 'imported'],
            default: 'llm-generated'
        },
        confidence: { type: Number, min: 0, max: 1 }, // LLM confidence score
        addedAt: { type: Date, default: Date.now }
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

    // Chess-specific fields - NEW STRUCTURED FORMAT (preferred)
    chessData: {
        // Starting position FEN (defaults to initial position if not provided)
        startingFen: { type: String },
        // Array of moves in SAN notation (e.g., ["e4", "e5", "Nf3"])
        moves: [{ type: String }],
        // Final position FEN (auto-computed by server for validation)
        targetFen: { type: String },
        // Board orientation for display
        orientation: { type: String, enum: ['white', 'black'] },
        // Which move index to start practice from (0-based)
        practiceFromMove: { type: Number, default: 0 },
        // Opening/variation name
        openingName: { type: String },
        // Validation status (set by server)
        isValid: { type: Boolean },
        // Validation error if invalid
        validationError: { type: String }
    },

    // Chess-specific fields - LEGACY (for backward compatibility)
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

    // Original multiple choice options (for future quiz generation)
    options: [{
        type: String
    }],

    // Wrong answers only (for quick quiz generation without re-parsing)
    wrongAnswers: [{
        type: String
    }],

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

    // Users who have access to this flashcard (supports multi-user sharing)
    // Array of user MongoDB _ids
    users: [{
        type: Schema.Types.Mixed,  // Supports both ObjectId and String formats
        index: true
    }],

    // User's email (for quick lookup without joining)
    userEmail: {
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
FlashcardSchema.index({ users: 1, isActive: 1 });  // Query flashcards by user
FlashcardSchema.index({ userEmail: 1, isActive: 1 });  // Query flashcards by email

// Weakness tag indexes for analytics
FlashcardSchema.index({ weaknessTags: 1 });
FlashcardSchema.index({ 'weaknessTagData.type': 1 });
FlashcardSchema.index({ 'weaknessTagData.fullTag': 1 });
FlashcardSchema.index({ createdBy: 1, weaknessTags: 1, isActive: 1 });  // User weakness queries

export const Flashcard = mongoose.model('Flashcard', FlashcardSchema);
export { FlashcardSchema };
