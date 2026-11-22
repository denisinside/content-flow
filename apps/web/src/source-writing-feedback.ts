export interface SourceWritingStarter {
  topic: string
  excerpts: { label: string; text: string; truncated: boolean }[]
}

export interface SourceWritingStatus {
  id: string
  stage: string
  errorCategory: string | null
  sourceStarter?: SourceWritingStarter | null
}

export function sourceWritingFailure(category: string | null) {
  switch (category) {
    case 'STALE_INPUT':
      return 'Джерела або бриф змінилися під час підготовки. Запропонуйте текст з актуальних даних.'
    case 'NO_RELEVANT_SOURCE_EVIDENCE':
    case 'INSUFFICIENT_EVIDENCE':
      return 'У джерелах бракує уривків, які підтверджують тему. Додайте матеріал про цю тему й спробуйте знову.'
    case 'WRITING_DRAFT_INVALID':
    case 'NEEDS_HUMAN':
      return 'Генерація повернула текст, який не пройшов перевірку. Можете повторити генерацію або продовжити редагування.'
    default:
      return 'Не вдалося завершити генерацію. Можете повторити її або продовжити редагування.'
  }
}
