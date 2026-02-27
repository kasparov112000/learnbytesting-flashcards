import * as mongoose from 'mongoose';
const Schema = mongoose.Schema;

const DeckSchema = new Schema({
    title: { type: String, required: true },
    description: { type: String },
    deckType: {
        type: String,
        enum: ['opening', 'puzzle', 'general', 'custom'],
        default: 'general'
    },
    flashcardIds: [{
        type: Schema.Types.ObjectId,
        ref: 'Flashcard'
    }],
    createdBy: { type: String, index: true },
    isPublic: { type: Boolean, default: false },
    tags: [{ type: String }],
    difficulty: { type: Number, min: 1, max: 5, default: 3 },
    source: {
        type: String,
        enum: ['repertoire', 'curated', 'user', 'ai-generated'],
        default: 'user'
    },
    // Chess-specific (populated for deckType=opening)
    eco: { type: String },
    openingName: { type: String },
    color: { type: String, enum: ['white', 'black'] },
    pgn: { type: String },
    isActive: { type: Boolean, default: true }
}, {
    timestamps: true,
    collection: 'decks'
});

DeckSchema.index({ createdBy: 1, deckType: 1 });
DeckSchema.index({ openingName: 1, createdBy: 1 });
DeckSchema.index({ title: 'text', openingName: 'text', tags: 'text' });

export const Deck = mongoose.model('Deck', DeckSchema);
export { DeckSchema };
