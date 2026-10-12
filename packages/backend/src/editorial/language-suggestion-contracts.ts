import { z } from 'zod';

const counter = z.number().int().nonnegative();
export const languageSuggestionTargetType = z.enum(['ARTICLE', 'ADAPTATION']);
export const languageSuggestionLocator = z.enum(['TITLE', 'BODY', 'COVER_TEXT']);

export const reviewLanguageSuggestionsInput = z.object({
  targetType: languageSuggestionTargetType,
  sourceRevisionId: z.uuid(),
  expectedRevision: counter,
}).strict();

export const listLanguageSuggestionsInput = z.object({
  targetType: languageSuggestionTargetType,
  sourceRevisionId: z.uuid(),
}).strict();

export const acceptLanguageSuggestionsInput = z.object({
  targetType: languageSuggestionTargetType,
  sourceRevisionId: z.uuid(),
  expectedRevision: counter,
  suggestionIds: z.array(z.uuid()).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
}).strict();

export const rejectLanguageSuggestionInput = z.object({ expectedRevision: counter }).strict();

export type ReviewLanguageSuggestionsInput = z.infer<typeof reviewLanguageSuggestionsInput>;
export type ListLanguageSuggestionsInput = z.infer<typeof listLanguageSuggestionsInput>;
export type AcceptLanguageSuggestionsInput = z.infer<typeof acceptLanguageSuggestionsInput>;
