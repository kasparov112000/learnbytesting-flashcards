# Flashcard-Question Linking Documentation

## Overview

Flashcards can be linked to questions to enable quiz functionality. This document describes the architecture, API endpoints, and workflows for flashcard-question linking.

## Architecture

### Data Model

**Flashcard Schema Fields:**
```javascript
{
    // ... other fields ...

    // Many-to-many: References to question documents
    questionIds: [{ type: ObjectId, ref: 'Question' }],

    // Primary linked question (1:1 relationship for promoted flashcards)
    linkedQuestionId: { type: ObjectId, ref: 'Question', index: true },

    // Whether this flashcard can be used in quizzes/exams
    canBeQuizzed: { type: Boolean, default: false }
}
```

**Question Schema Fields (for flashcard-sourced questions):**
```javascript
{
    // ... standard question fields ...

    sourceType: 'flashcard',
    sourceFlashcardId: String  // Reference back to the flashcard
}
```

### Relationship Types

1. **Many-to-Many (`questionIds`)**: A flashcard can reference multiple questions, and questions can be referenced by multiple flashcards. Used for general associations.

2. **One-to-One (`linkedQuestionId`)**: Primary link for promoted flashcards. When a flashcard is "promoted", a question is created and linked here.

## API Endpoints

### Auto-Promotion Endpoints (Orchestrator)

These endpoints handle cross-service coordination between flashcards and questions.

#### Create Flashcard with Auto-Promoted Question

```
POST /flashcards/with-question
```

Creates a flashcard AND automatically creates a linked question. The flashcard is immediately quiz-ready.

**Request Body:** Standard flashcard data
```json
{
    "front": "What is the London System?",
    "back": "A chess opening starting with 1.d4 and 2.Bf4",
    "category": "Chess Openings",
    "tags": ["openings", "d4"]
}
```

**Response:**
```json
{
    "result": {
        "flashcard": { "_id": "fc123", "linkedQuestionId": "q456", "canBeQuizzed": true, ... },
        "question": { "_id": "q456", "sourceFlashcardId": "fc123", ... },
        "linked": true
    }
}
```

#### Promote Existing Flashcard

```
POST /flashcards/:id/promote-to-question
```

Promotes an existing flashcard by creating a linked question.

**Response:**
```json
{
    "result": {
        "flashcard": { ... },
        "question": { ... },
        "promoted": true
    }
}
```

**Error Cases:**
- `404`: Flashcard not found
- `400`: Flashcard already promoted (has linkedQuestionId)

#### Demote Flashcard

```
POST /flashcards/:id/demote
```

Removes the linked question and disables quiz mode.

**Request Body:**
```json
{
    "deleteQuestion": true  // default: true - soft-deletes the linked question
}
```

**Response:**
```json
{
    "result": {
        "flashcard": { "linkedQuestionId": null, "canBeQuizzed": false, ... },
        "demoted": true,
        "questionDeleted": true
    }
}
```

#### Batch Create with Questions

```
POST /flashcards/batch/with-questions
```

Creates multiple flashcards with auto-promoted questions.

**Request Body:**
```json
{
    "flashcards": [
        { "front": "...", "back": "...", ... },
        { "front": "...", "back": "...", ... }
    ]
}
```

**Response:**
```json
{
    "result": [
        { "flashcard": {...}, "question": {...}, "linked": true },
        { "flashcard": {...}, "question": {...}, "linked": true }
    ],
    "summary": {
        "total": 2,
        "success": 2,
        "failed": 0
    }
}
```

### Quiz Mode Endpoints (Flashcards Service)

#### Enable Quiz Mode

```
POST /flashcards/:id/quiz/enable
```

**Request Body:**
```json
{
    "linkedQuestionId": "optional-question-id"
}
```

Sets `canBeQuizzed: true` and optionally links to an existing question.

#### Disable Quiz Mode

```
POST /flashcards/:id/quiz/disable
```

**Request Body:**
```json
{
    "unlinkQuestion": true  // optional - also removes linkedQuestionId
}
```

#### Get Quizzable Flashcards

```
GET /flashcards/quizzable?category=Chess&limit=10
```

Returns flashcards with `canBeQuizzed: true`.

### Linking Endpoints

#### Link to Question

```
POST /flashcards/:id/link/:questionId
```

Links flashcard to a question (1:1 relationship).

#### Unlink from Question

```
DELETE /flashcards/:id/link
```

Removes the `linkedQuestionId`.

#### Get by Linked Question

```
GET /flashcards/linked-question/:questionId
```

Finds the flashcard linked to a specific question.

### Bulk Operations

#### Bulk Enable Quiz Mode

```
POST /flashcards/bulk/quiz/enable
```

**Request Body:**
```json
{
    "flashcardIds": ["id1", "id2", "id3"]
}
```

#### Bulk Link to Questions

```
POST /flashcards/bulk/link
```

**Request Body:**
```json
{
    "mappings": [
        { "flashcardId": "fc1", "questionId": "q1" },
        { "flashcardId": "fc2", "questionId": "q2" }
    ]
}
```

## Workflows

### 1. Creating Quiz-Ready Flashcards (Recommended)

Use `POST /flashcards/with-question` to create flashcards that are immediately available for quizzes:

```
1. Client sends flashcard data
2. Orchestrator creates flashcard
3. Orchestrator creates question from flashcard data
4. Orchestrator links them together
5. Returns both documents
```

### 2. Promoting Existing Flashcards

For flashcards created without promotion:

```
1. User reviews flashcard
2. User clicks "Add to Quizzes"
3. Client calls POST /flashcards/:id/promote-to-question
4. Question is created and linked
5. Flashcard appears in quiz pools
```

### 3. Demoting Flashcards

To remove a flashcard from quizzes:

```
1. User clicks "Remove from Quizzes"
2. Client calls POST /flashcards/:id/demote
3. Linked question is deleted (optional)
4. Flashcard is unlinked and canBeQuizzed set to false
5. Flashcard remains for study but won't appear in exams
```

## Data Conversion

When creating a question from a flashcard, the following mapping is used:

| Flashcard Field | Question Field |
|-----------------|----------------|
| front | question |
| back | answer |
| hint | explanation |
| difficulty | difficulty |
| category | category |
| categoryId | categoryId |
| tags | tags |
| fen | fen |
| pgn | pgn |
| openingName | openingName |
| frontImage | questionImage |
| backImage | answerImage |
| createdBy | createdBy |
| isPublic | isPublic |
| _id | sourceFlashcardId |
| - | sourceType: 'flashcard' |
| - | type: 'chess' or 'flashcard' |

## Best Practices

1. **Use `with-question` for new flashcards**: If you know a flashcard should be quizzable, create it with the auto-promotion endpoint.

2. **Use `promote-to-question` for legacy flashcards**: For existing flashcards that need to be added to quizzes.

3. **Use `demote` carefully**: Demoting deletes the question by default. Use `deleteQuestion: false` if you want to keep the question.

4. **Batch operations**: Use batch endpoints when processing multiple flashcards to reduce API calls.

5. **Check promotion status**: Before promoting, check if `linkedQuestionId` already exists to avoid errors.

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| "Flashcard already promoted" | Trying to promote a flashcard that has `linkedQuestionId` | Check status first or use demote then promote |
| "Flashcard is not promoted" | Trying to demote a flashcard without `linkedQuestionId` | No action needed |
| "Failed to create question" | Questions service error | Check questions service logs |

## Database Indexes

The flashcards schema includes indexes for efficient queries:

```javascript
FlashcardSchema.index({ linkedQuestionId: 1 });
FlashcardSchema.index({ canBeQuizzed: 1, isActive: 1 });
FlashcardSchema.index({ questionIds: 1 });
```

## Related Files

- `flashcards/app/models/flashcard.model.ts` - Schema definition
- `flashcards/app/services/flashcard.service.ts` - Service methods
- `flashcards/app/routes/default.api.ts` - Microservice routes
- `orchestrator/src/routes/flashcards.api.ts` - Orchestrator routes
- `orchestrator/src/services/flashcards.service.ts` - Orchestrator service
