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

    // Optional display name (e.g., user-created variant name)
    name: {
        type: String,
        default: null
    },

    // Explicit card type for type-aware rendering, filtering, and per-type UI
    cardType: {
        type: String,
        enum: ['text', 'multipleChoice', 'trueFalse', 'chessPuzzle', 'chessOpening', 'chessGame', 'match', 'openingLine', 'openingLesson', 'interactiveGame', 'code', 'fillInBlanks', 'insight', 'order'],
        default: 'text',
        index: true
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

    // Array of course IDs this flashcard belongs to (denormalized from Course → Lesson → Section → flashcardIds chain)
    // Enables course-scoped filtering: { courseIds: "course-id" } returns only cards in that course
    // Populated via backfill endpoint POST /flashcards/stamp-course-ids
    courseIds: [{
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
        validationError: { type: String },
        // Reference to famous_games collection document
        gameId: { type: String },
        // Per-move commentary for instructional mode (index 0 = move 1, etc.)
        commentary: [{ type: String }],
        // Variant lines branching from the main sequence
        variants: [{
            name: { type: String },
            branchAtMove: { type: Number },
            moves: [{ type: String }],
            commentary: [{ type: String }]
        }],
        // Position-linked insights for richer per-move commentary (multiple entries per position)
        // Each entry holds multiple insight texts at a specific FEN/moveIndex
        positionInsights: [{
            // FEN of the position where insights are displayed
            fen: { type: String, required: true },
            // 0-based index in the moves array (for ordering)
            moveIndex: { type: Number },
            // Array of insight entries for this position
            insights: [{
                // Unique identifier (auto-generated UUID)
                id: { type: String },
                // Insight/commentary text
                text: { type: String }
            }]
        }],
        // Position-linked Q/A for concept review at specific positions
        // Each entry ties questions to a FEN/moveIndex, enabling self-evaluation mode
        positionQuestions: [{
            // FEN of the position where questions are asked
            fen: { type: String, required: true },
            // 0-based index in the moves array (for ordering)
            moveIndex: { type: Number },
            // Array of Q/A pairs for this position
            questions: [{
                // Unique identifier (auto-generated UUID)
                id: { type: String },
                // Question text (e.g., "What is White's strategic plan here?")
                question: { type: String },
                // Answer text (e.g., "Control the center with d4...")
                answer: { type: String },
                // When true, this question displays BEFORE the move is played (default: after)
                askBefore: { type: Boolean, default: false }
            }]
        }]
    },

    // Famous game metadata (embedded on game-type flashcards)
    // Each game = 1 flashcard for FSRS; the whole game's accuracy determines the rating
    famousGame: {
        title: { type: String },
        whitePlayer: { type: String },
        blackPlayer: { type: String },
        year: { type: Number },
        event: { type: String },
        eco: { type: String },
        openingName: { type: String },
        pgn: { type: String },
        moveCount: { type: Number },
        description: { type: String },
        themes: [{ type: String }],
        difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced'] },
        order: { type: Number, default: 0 }
    },

    // Opening line metadata (embedded on opening-type flashcards)
    // Each opening = 1 flashcard for browsing/FSRS; analogous to famousGame for games
    openingLine: {
        eco: { type: String },
        openingName: { type: String },
        variationName: { type: String },
        pgn: { type: String },
        moveCount: { type: Number },
        difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced'] },
        order: { type: Number, default: 0 },
        description: { type: String },
        isVariation: { type: Boolean, default: false },
        mainOpeningName: { type: String }
    },

    // Opening lesson metadata (difficulty-tiered guided practice)
    openingLesson: {
        eco: { type: String },
        openingName: { type: String },
        variationName: { type: String },
        difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced'] },
        title: { type: String },
        description: { type: String },
        pgn: { type: String },
        moveCount: { type: Number },
        order: { type: Number, default: 0 }
    },

    // Code exercise data (for code-type flashcards)
    codeData: {
        language: { type: String, default: 'typescript' },
        mode: { type: String, enum: ['fillBlank', 'editor'], default: 'fillBlank' },
        starterCode: { type: String },
        solutionCode: { type: String },
        blanks: [{
            id: { type: String },
            answer: { type: String },
            acceptedAnswers: [{ type: String }]
        }],
        explanation: { type: String }
    },

    // Fill-in-the-blanks data (for fillInBlanks-type flashcards)
    // Text contains {{n}} placeholders that map to blanks[n]
    fillInBlanksData: {
        text: { type: String },          // e.g. "It is classified as a {{0}}, like the {{1}} and {{2}}"
        blanks: [{
            id: { type: String },
            answer: { type: String },     // correct answer text
            options: [{ type: String }]   // dropdown choices (includes correct answer)
        }],
        explanation: { type: String }
    },

    // Order/sequence data (for order-type flashcards)
    // User arranges items in the correct sequence
    orderData: {
        prompt: { type: String },
        items: [{
            id: { type: String },
            content: { type: String }
        }],
        correctOrder: [{ type: String }],
        explanation: { type: String },
        // Namespaced provenance for variation move-order drills.
        // Used as dedup key by createFromVariationOrder() so re-runs UPDATE
        // existing cards instead of spawning duplicates. Safe to leave unset
        // on non-variation order cards (e.g. Angular lifecycle ordering).
        openingName: { type: String },
        variationName: { type: String }
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

    // Match pairs for match-type flashcards
    matchPairs: [{
        leftItem: {
            id: { type: String },
            content: { type: String },
            imageUrl: { type: String },
            type: { type: String, enum: ['text', 'image', 'both'], default: 'text' }
        },
        rightItem: {
            id: { type: String },
            content: { type: String },
            imageUrl: { type: String },
            type: { type: String, enum: ['text', 'image', 'both'], default: 'text' }
        },
        feedback: { type: String }
    }],

    // Original multiple choice options (for future quiz generation)
    options: [{
        type: String
    }],

    // The correct answer for multipleChoice cards (must match one of the options)
    correctAnswer: {
        type: String
    },

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
    },

    // Multi-language translations
    // Key: ISO language code ('es', 'fr', 'de', etc.)
    // Value: object with any subset of translatable fields — missing ones fall back to English
    translations: {
        type: Map,
        of: Schema.Types.Mixed,
        default: undefined
    },

    // Language of top-level fields (default 'en')
    defaultLanguage: {
        type: String,
        default: 'en'
    },

    // ============ View Tracking ============
    // Incremented each time a user views this card (before submitting a review)
    viewCount: {
        type: Number,
        default: 0
    },
    // Last time the card was viewed
    lastViewedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true,
    collection: 'flashcards'
});

// Indexes for common queries
FlashcardSchema.index({ cardType: 1, isActive: 1 });
FlashcardSchema.index({ category: 1, isActive: 1 });
FlashcardSchema.index({ categoryIds: 1, isActive: 1 });  // Main index for hierarchical queries
FlashcardSchema.index({ courseIds: 1, isActive: 1 });   // Course-scoped flashcard queries
FlashcardSchema.index({ 'primaryCategory._id': 1, isActive: 1 });
FlashcardSchema.index({ tags: 1 });
FlashcardSchema.index({ createdBy: 1, isActive: 1 });
FlashcardSchema.index({ questionIds: 1 });
FlashcardSchema.index({ linkedQuestionId: 1 });
FlashcardSchema.index({ canBeQuizzed: 1, isActive: 1 });
FlashcardSchema.index({ users: 1, isActive: 1 });  // Query flashcards by user
FlashcardSchema.index({ userEmail: 1, isActive: 1 });  // Query flashcards by email
FlashcardSchema.index({ 'famousGame.title': 1, isActive: 1 });  // Famous game lookup
FlashcardSchema.index({ 'openingLine.eco': 1, isActive: 1 });  // Opening line lookup by ECO
FlashcardSchema.index({ 'openingLine.openingName': 1, isActive: 1 });  // Opening line lookup by name
FlashcardSchema.index({ 'openingLesson.eco': 1, 'openingLesson.difficulty': 1, isActive: 1 });  // Opening lesson lookup

// Weakness tag indexes for analytics
FlashcardSchema.index({ weaknessTags: 1 });
FlashcardSchema.index({ 'weaknessTagData.type': 1 });
FlashcardSchema.index({ 'weaknessTagData.fullTag': 1 });
FlashcardSchema.index({ createdBy: 1, weaknessTags: 1, isActive: 1 });  // User weakness queries

export const Flashcard = mongoose.model('Flashcard', FlashcardSchema);
export { FlashcardSchema };
