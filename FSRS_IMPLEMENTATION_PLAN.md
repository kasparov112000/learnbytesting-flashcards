# FSRS Implementation Plan

## Overview

Replace the current SM-2 algorithm with FSRS (Free Spaced Repetition Scheduler) for improved learning efficiency and personalization.

**Estimated Scope**: 8 files modified/created across backend and frontend

---

## Phase 1: Backend - Core Infrastructure

### 1.1 Install ts-fsrs Package

**File**: `flashcards/package.json`

```bash
cd flashcards
npm install ts-fsrs
```

### 1.2 Update User Progress Schema

**File**: `flashcards/app/models/user-progress.model.ts`

Add FSRS-specific fields alongside existing SM-2 fields (for backward compatibility):

```typescript
// ===== FSRS Algorithm Fields =====

// Stability - how long until retrievability drops to 90%
stability: {
    type: Number,
    default: 0
},

// Difficulty - inherent content difficulty [1-10]
difficulty: {
    type: Number,
    default: 5,
    min: 1,
    max: 10
},

// Days since last review
elapsed_days: {
    type: Number,
    default: 0
},

// Scheduled interval until next review
scheduled_days: {
    type: Number,
    default: 0
},

// Learning step counter (for learning/relearning phases)
learning_steps: {
    type: Number,
    default: 0
},

// Which algorithm is active for this card
algorithm: {
    type: String,
    enum: ['sm2', 'fsrs'],
    default: 'fsrs'
},

// FSRS state maps to: New(0), Learning(1), Review(2), Relearning(3)
fsrsState: {
    type: Number,
    enum: [0, 1, 2, 3],
    default: 0
}
```

**Migration note**: Keep existing SM-2 fields (`easinessFactor`, `repetitions`, `interval`) for users who haven't migrated.

### 1.3 Create FSRS Service

**File**: `flashcards/app/services/fsrs.service.ts` (NEW)

```typescript
import {
    FSRS,
    createEmptyCard,
    Rating,
    State,
    Card,
    RecordLogItem,
    generatorParameters,
    FSRSParameters
} from 'ts-fsrs';

export class FSRSService {
    private scheduler: FSRS;
    private params: FSRSParameters;

    constructor(options?: { requestRetention?: number; maximumInterval?: number }) {
        this.params = generatorParameters({
            request_retention: options?.requestRetention || 0.9,  // 90% target retention
            maximum_interval: options?.maximumInterval || 365,    // Max 1 year interval
            enable_fuzz: true,                                     // Add randomness
            enable_short_term: true                                // Enable learning steps
        });
        this.scheduler = new FSRS(this.params);
    }

    /**
     * Create a new empty card for FSRS
     */
    createCard(now?: Date): Card {
        return createEmptyCard(now || new Date());
    }

    /**
     * Convert UserProgress document to FSRS Card
     */
    progressToCard(progress: any): Card {
        return {
            due: progress.nextReviewDate || new Date(),
            stability: progress.stability || 0,
            difficulty: progress.difficulty || 5,
            elapsed_days: progress.elapsed_days || 0,
            scheduled_days: progress.scheduled_days || 0,
            learning_steps: progress.learning_steps || 0,
            reps: progress.totalReviews || 0,
            lapses: progress.lapses || 0,
            state: progress.fsrsState ?? State.New,
            last_review: progress.lastReviewDate
        };
    }

    /**
     * Convert FSRS Card back to UserProgress fields
     */
    cardToProgressFields(card: Card): any {
        return {
            nextReviewDate: card.due,
            stability: card.stability,
            difficulty: card.difficulty,
            elapsed_days: card.elapsed_days,
            scheduled_days: card.scheduled_days,
            learning_steps: card.learning_steps,
            totalReviews: card.reps,
            lapses: card.lapses,
            fsrsState: card.state,
            lastReviewDate: card.last_review,
            // Map FSRS state to existing state field for compatibility
            state: this.fsrsStateToLegacyState(card.state)
        };
    }

    /**
     * Map FSRS State enum to legacy state strings
     */
    fsrsStateToLegacyState(fsrsState: State): string {
        switch (fsrsState) {
            case State.New: return 'new';
            case State.Learning: return 'learning';
            case State.Review: return 'review';
            case State.Relearning: return 'relearning';
            default: return 'new';
        }
    }

    /**
     * Process a review and return the updated card
     * @param progress - Current UserProgress document
     * @param rating - FSRS Rating (1=Again, 2=Hard, 3=Good, 4=Easy)
     * @param now - Review timestamp
     */
    processReview(progress: any, rating: Rating, now?: Date): RecordLogItem {
        const card = this.progressToCard(progress);
        const reviewDate = now || new Date();
        return this.scheduler.next(card, reviewDate, rating);
    }

    /**
     * Get all possible scheduling outcomes for a card
     * Useful for showing user what each rating would do
     */
    getSchedulingOptions(progress: any, now?: Date) {
        const card = this.progressToCard(progress);
        const reviewDate = now || new Date();
        const options = this.scheduler.repeat(card, reviewDate);

        return {
            again: {
                interval: options[Rating.Again].card.scheduled_days,
                due: options[Rating.Again].card.due
            },
            hard: {
                interval: options[Rating.Hard].card.scheduled_days,
                due: options[Rating.Hard].card.due
            },
            good: {
                interval: options[Rating.Good].card.scheduled_days,
                due: options[Rating.Good].card.due
            },
            easy: {
                interval: options[Rating.Easy].card.scheduled_days,
                due: options[Rating.Easy].card.due
            }
        };
    }

    /**
     * Convert legacy SM-2 quality (0-5) to FSRS Rating (1-4)
     */
    static qualityToRating(quality: number): Rating {
        if (quality <= 2) return Rating.Again;  // 0, 1, 2 -> Again
        if (quality === 3) return Rating.Hard;   // 3 -> Hard
        if (quality === 4) return Rating.Good;   // 4 -> Good
        return Rating.Easy;                       // 5 -> Easy
    }

    /**
     * Get human-readable interval string
     */
    static formatInterval(days: number): string {
        if (days < 1) {
            const minutes = Math.round(days * 24 * 60);
            if (minutes < 60) return `${minutes}m`;
            return `${Math.round(minutes / 60)}h`;
        }
        if (days < 30) return `${Math.round(days)}d`;
        if (days < 365) return `${Math.round(days / 30)}mo`;
        return `${(days / 365).toFixed(1)}y`;
    }
}
```

### 1.4 Update User Progress Service

**File**: `flashcards/app/services/user-progress.service.ts`

Modify `processReview` method to use FSRS:

```typescript
import { FSRSService } from './fsrs.service';
import { Rating } from 'ts-fsrs';

export class UserProgressService {
    private fsrsService: FSRSService;

    constructor() {
        this.fsrsService = new FSRSService({
            requestRetention: 0.9,
            maximumInterval: 365
        });
    }

    /**
     * Process a review using FSRS algorithm
     * @param rating - FSRS rating 1-4 (Again/Hard/Good/Easy)
     */
    async processReview(
        userId: string,
        flashcardId: string,
        rating: number,  // Now expects 1-4 for FSRS
        responseTimeMs?: number
    ) {
        const progress = await this.getOrCreate(userId, flashcardId);
        const now = new Date();

        // Check which algorithm to use
        if (progress.algorithm === 'fsrs' || !progress.algorithm) {
            return this.processReviewFSRS(progress, rating as Rating, responseTimeMs, now);
        } else {
            // Legacy SM-2 for migrating users
            return this.processReviewSM2(progress, rating, responseTimeMs);
        }
    }

    private async processReviewFSRS(
        progress: any,
        rating: Rating,
        responseTimeMs?: number,
        now?: Date
    ) {
        const reviewDate = now || new Date();
        const result = this.fsrsService.processReview(progress, rating, reviewDate);
        const updatedFields = this.fsrsService.cardToProgressFields(result.card);

        // Store review in history
        progress.reviewHistory.push({
            date: reviewDate,
            quality: rating,  // Store FSRS rating (1-4)
            responseTimeMs,
            intervalBefore: progress.scheduled_days || 0,
            intervalAfter: result.card.scheduled_days,
            algorithm: 'fsrs'
        });

        // Update statistics
        progress.totalReviews = (progress.totalReviews || 0) + 1;
        if (rating >= Rating.Good) {
            progress.correctCount = (progress.correctCount || 0) + 1;
        } else {
            progress.incorrectCount = (progress.incorrectCount || 0) + 1;
        }

        // Update response time average
        if (responseTimeMs) {
            const totalTime = (progress.averageResponseTime || 0) * (progress.totalReviews - 1) + responseTimeMs;
            progress.averageResponseTime = totalTime / progress.totalReviews;
        }

        // Apply FSRS updates
        Object.assign(progress, updatedFields);
        progress.algorithm = 'fsrs';
        progress.lastQuality = rating;

        await progress.save();
        return progress;
    }

    // Keep existing SM-2 method for backward compatibility
    private async processReviewSM2(progress: any, quality: number, responseTimeMs?: number) {
        // ... existing SM-2 code ...
    }
}
```

### 1.5 Register FSRS Service

**File**: `flashcards/app/services/index.ts`

```typescript
export * from './fsrs.service';
```

**File**: `flashcards/server.ts` (or wherever services are initialized)

```typescript
import { FSRSService } from './services/fsrs.service';

const fsrsService = new FSRSService();
// Pass to routes/other services as needed
```

---

## Phase 2: Backend - API Updates

### 2.1 Add Scheduling Preview Endpoint

**File**: `flashcards/app/routes/default.api.ts`

Add endpoint to show users what each rating will do:

```typescript
// Get scheduling preview for a card
router.get('/flashcards/:flashcardId/schedule-preview/:userId', async (req, res) => {
    try {
        const { flashcardId, userId } = req.params;
        const progress = await userProgressService.getOrCreate(userId, flashcardId);
        const preview = fsrsService.getSchedulingOptions(progress);

        res.json({
            result: {
                again: {
                    interval: FSRSService.formatInterval(preview.again.interval),
                    due: preview.again.due
                },
                hard: {
                    interval: FSRSService.formatInterval(preview.hard.interval),
                    due: preview.hard.due
                },
                good: {
                    interval: FSRSService.formatInterval(preview.good.interval),
                    due: preview.good.due
                },
                easy: {
                    interval: FSRSService.formatInterval(preview.easy.interval),
                    due: preview.easy.due
                }
            }
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});
```

### 2.2 Update Answer Submission

**File**: `flashcards/app/routes/default.api.ts`

Modify the submit answer endpoint to accept FSRS ratings:

```typescript
// Submit answer - updated for FSRS
router.post('/study/:userId/answer/:flashcardId', async (req, res) => {
    try {
        const { rating, responseTimeMs, useLegacyQuality } = req.body;

        // Support both new FSRS ratings (1-4) and legacy quality (0-5)
        let fsrsRating: number;
        if (useLegacyQuality) {
            // Convert legacy 0-5 to FSRS 1-4
            fsrsRating = FSRSService.qualityToRating(rating);
        } else {
            // Validate FSRS rating
            if (rating < 1 || rating > 4) {
                return res.status(400).json({
                    error: 'Rating must be 1 (Again), 2 (Hard), 3 (Good), or 4 (Easy)'
                });
            }
            fsrsRating = rating;
        }

        const result = await studyService.submitAnswer(
            req.params.userId,
            req.params.flashcardId,
            fsrsRating,
            responseTimeMs
        );

        res.json({ result });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});
```

---

## Phase 3: Frontend - UI Updates

### 3.1 Create Rating Button Component

**File**: `webapp/src/app/shared/components/fsrs-rating/fsrs-rating.component.ts` (NEW)

```typescript
import { Component, EventEmitter, Input, Output } from '@angular/core';

export interface RatingOption {
    value: number;
    label: string;
    interval: string;
    color: string;
    icon: string;
}

@Component({
    selector: 'app-fsrs-rating',
    templateUrl: './fsrs-rating.component.html',
    styleUrls: ['./fsrs-rating.component.scss']
})
export class FSRSRatingComponent {
    @Input() schedulePreview: any;  // Preview intervals from API
    @Input() disabled: boolean = false;
    @Output() ratingSelected = new EventEmitter<number>();

    ratings: RatingOption[] = [
        { value: 1, label: 'Again', interval: '', color: '#F44336', icon: 'replay' },
        { value: 2, label: 'Hard', interval: '', color: '#FF9800', icon: 'sentiment_dissatisfied' },
        { value: 3, label: 'Good', interval: '', color: '#4CAF50', icon: 'check_circle' },
        { value: 4, label: 'Easy', interval: '', color: '#2196F3', icon: 'star' }
    ];

    ngOnChanges() {
        if (this.schedulePreview) {
            this.ratings[0].interval = this.schedulePreview.again?.interval || '';
            this.ratings[1].interval = this.schedulePreview.hard?.interval || '';
            this.ratings[2].interval = this.schedulePreview.good?.interval || '';
            this.ratings[3].interval = this.schedulePreview.easy?.interval || '';
        }
    }

    selectRating(rating: number) {
        if (!this.disabled) {
            this.ratingSelected.emit(rating);
        }
    }
}
```

### 3.2 Rating Component Template

**File**: `webapp/src/app/shared/components/fsrs-rating/fsrs-rating.component.html` (NEW)

```html
<div class="fsrs-rating-container">
    <button *ngFor="let option of ratings"
            class="rating-button"
            [style.background-color]="option.color"
            [disabled]="disabled"
            (click)="selectRating(option.value)">
        <mat-icon>{{ option.icon }}</mat-icon>
        <span class="label">{{ option.label }}</span>
        <span class="interval" *ngIf="option.interval">{{ option.interval }}</span>
    </button>
</div>
```

### 3.3 Rating Component Styles

**File**: `webapp/src/app/shared/components/fsrs-rating/fsrs-rating.component.scss` (NEW)

```scss
.fsrs-rating-container {
    display: flex;
    gap: 12px;
    justify-content: center;
    padding: 16px;
}

.rating-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 12px 20px;
    border: none;
    border-radius: 8px;
    color: white;
    cursor: pointer;
    min-width: 80px;
    transition: transform 0.2s, box-shadow 0.2s;

    &:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    mat-icon {
        font-size: 28px;
        height: 28px;
        width: 28px;
        margin-bottom: 4px;
    }

    .label {
        font-weight: 600;
        font-size: 14px;
    }

    .interval {
        font-size: 12px;
        opacity: 0.9;
        margin-top: 4px;
    }
}
```

### 3.4 Update Flashcard Quiz Component

**File**: `webapp/src/app/main/quiz/flashcards/quiz-flashcards-container.component.ts`

Update to use FSRS ratings:

```typescript
// Add to component
schedulePreview: any = null;

// Load preview when showing answer
async onShowAnswer() {
    this.showAnswer = true;
    // Fetch schedule preview
    this.schedulePreview = await this.flashcardService
        .getSchedulePreview(this.currentCard._id, this.userId)
        .toPromise();
}

// Handle FSRS rating
async onRatingSelected(rating: number) {
    await this.flashcardService.submitAnswer(
        this.userId,
        this.currentCard._id,
        rating,
        this.responseTimeMs
    );
    this.loadNextCard();
}
```

### 3.5 Update Flashcard Service

**File**: `webapp/src/app/main/services/flashcard/flashcard.service.ts`

Add new methods:

```typescript
// Get schedule preview
getSchedulePreview(flashcardId: string, userId: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/flashcards/${flashcardId}/schedule-preview/${userId}`);
}

// Submit FSRS answer
submitFSRSAnswer(userId: string, flashcardId: string, rating: number, responseTimeMs?: number): Observable<any> {
    return this.http.post(`${this.apiUrl}/study/${userId}/answer/${flashcardId}`, {
        rating,
        responseTimeMs,
        useLegacyQuality: false  // Use FSRS rating directly
    });
}
```

---

## Phase 4: Migration & Compatibility

### 4.1 Migration Script for Existing Users

**File**: `flashcards/scripts/migrate-to-fsrs.ts` (NEW)

```typescript
import { UserProgress } from '../app/models';

/**
 * Migrate existing SM-2 progress to FSRS
 * Run once to convert existing data
 */
async function migrateToFSRS() {
    const cursor = UserProgress.find({ algorithm: { $ne: 'fsrs' } }).cursor();

    let migrated = 0;
    for await (const progress of cursor) {
        // Convert SM-2 easinessFactor to FSRS difficulty
        // EF range: 1.3-2.5 -> D range: 1-10
        const ef = progress.easinessFactor || 2.5;
        const difficulty = Math.round(10 - ((ef - 1.3) / 1.2) * 9);

        // Estimate stability from interval
        const stability = progress.interval || 0;

        // Map state
        const stateMap = {
            'new': 0,
            'learning': 1,
            'review': 2,
            'relearning': 3,
            'mastered': 2
        };

        await UserProgress.updateOne(
            { _id: progress._id },
            {
                $set: {
                    algorithm: 'fsrs',
                    stability,
                    difficulty: Math.max(1, Math.min(10, difficulty)),
                    fsrsState: stateMap[progress.state] || 0,
                    elapsed_days: 0,
                    scheduled_days: progress.interval || 0,
                    learning_steps: 0
                }
            }
        );
        migrated++;

        if (migrated % 1000 === 0) {
            console.log(`Migrated ${migrated} records...`);
        }
    }

    console.log(`Migration complete. ${migrated} records updated.`);
}

migrateToFSRS().catch(console.error);
```

### 4.2 Feature Flag (Optional)

**File**: `flashcards/app/config/features.ts` (NEW)

```typescript
export const FEATURES = {
    USE_FSRS: process.env.USE_FSRS !== 'false',  // Enabled by default
    FSRS_DEFAULT_RETENTION: parseFloat(process.env.FSRS_RETENTION || '0.9'),
    FSRS_MAX_INTERVAL: parseInt(process.env.FSRS_MAX_INTERVAL || '365', 10)
};
```

---

## Phase 5: Testing

### 5.1 Unit Tests for FSRS Service

**File**: `flashcards/app/services/fsrs.service.spec.ts` (NEW)

```typescript
import { FSRSService } from './fsrs.service';
import { Rating, State } from 'ts-fsrs';

describe('FSRSService', () => {
    let service: FSRSService;

    beforeEach(() => {
        service = new FSRSService({ requestRetention: 0.9 });
    });

    describe('createCard', () => {
        it('should create a new card with default values', () => {
            const card = service.createCard();
            expect(card.state).toBe(State.New);
            expect(card.stability).toBe(0);
            expect(card.difficulty).toBe(0);
        });
    });

    describe('processReview', () => {
        it('should increase stability on Good rating', () => {
            const progress = { fsrsState: State.New };
            const result = service.processReview(progress, Rating.Good);
            expect(result.card.stability).toBeGreaterThan(0);
            expect(result.card.state).toBe(State.Learning);
        });

        it('should decrease interval on Again rating', () => {
            const progress = {
                fsrsState: State.Review,
                stability: 10,
                scheduled_days: 30
            };
            const result = service.processReview(progress, Rating.Again);
            expect(result.card.scheduled_days).toBeLessThan(30);
        });
    });

    describe('qualityToRating', () => {
        it('should map SM-2 quality to FSRS rating', () => {
            expect(FSRSService.qualityToRating(0)).toBe(Rating.Again);
            expect(FSRSService.qualityToRating(2)).toBe(Rating.Again);
            expect(FSRSService.qualityToRating(3)).toBe(Rating.Hard);
            expect(FSRSService.qualityToRating(4)).toBe(Rating.Good);
            expect(FSRSService.qualityToRating(5)).toBe(Rating.Easy);
        });
    });
});
```

---

## Implementation Order

| Step | Task | Effort | Dependencies |
|------|------|--------|--------------|
| 1 | Install ts-fsrs package | 5 min | None |
| 2 | Update UserProgress schema | 15 min | Step 1 |
| 3 | Create FSRSService | 30 min | Steps 1-2 |
| 4 | Update UserProgressService | 30 min | Step 3 |
| 5 | Update API routes | 20 min | Step 4 |
| 6 | Create frontend rating component | 30 min | None |
| 7 | Update quiz flashcard component | 20 min | Steps 5-6 |
| 8 | Update flashcard service (frontend) | 10 min | Step 7 |
| 9 | Write migration script | 20 min | Steps 1-4 |
| 10 | Write unit tests | 30 min | Steps 1-4 |
| 11 | Integration testing | 30 min | All |

**Total estimated effort**: ~4 hours

---

## Rollback Plan

If issues arise:

1. Set feature flag: `USE_FSRS=false`
2. Service will fall back to SM-2 for new reviews
3. Existing FSRS data remains valid (both algorithms stored)
4. Run reverse migration if needed (FSRS -> SM-2 field mapping)

---

## Future Enhancements

1. **User-specific parameters**: Allow users to customize retention target (70-97%)
2. **Parameter optimization**: Use ts-fsrs optimizer to tune parameters based on user's review history
3. **Analytics dashboard**: Show retention predictions, workload forecasts
4. **A/B testing**: Compare FSRS vs SM-2 performance for your user base
