import { Module } from '@nestjs/common';
import { ArticleService, ArticleAnnotationService, LanguageSuggestionService, ScriptLanguageService, ScriptService, TelegramService, DependencyHealthService, DurableJobService, EditorialService, FactualBasisService, FoundationModule } from '@contextflow/backend';
import { AuthModule } from '../auth/auth.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { ClaimsModule } from '../claims/claims.module.js';
import { EditorialController } from './editorial.controller.js';
import { ArticleController } from './article.controller.js';
import { ArticleAnnotationController } from './article-annotation.controller.js';
import { LanguageSuggestionController } from './language-suggestion.controller.js';
import { TelegramController } from './telegram.controller.js';
import { ScriptController } from './script.controller.js';
import { ScriptLanguageController } from './script-language.controller.js';

@Module({ imports: [FoundationModule, AuthModule, JobsModule, ClaimsModule], controllers: [EditorialController, ArticleController, ArticleAnnotationController, LanguageSuggestionController, TelegramController, ScriptController, ScriptLanguageController],
  providers: [{ provide: EditorialService, inject: [DependencyHealthService, DurableJobService, FactualBasisService],
    useFactory: (health: DependencyHealthService, jobs: DurableJobService, facts: FactualBasisService) => new EditorialService(health.prisma, jobs, facts) },
    { provide: ArticleService, inject: [DependencyHealthService, DurableJobService, FactualBasisService],
      useFactory: (health: DependencyHealthService, jobs: DurableJobService, facts: FactualBasisService) => new ArticleService(health.prisma, jobs, facts) },
    { provide: ArticleAnnotationService, inject: [DependencyHealthService, ArticleService],
      useFactory: (health: DependencyHealthService, articles: ArticleService) => new ArticleAnnotationService(health.prisma, articles) },
    { provide: LanguageSuggestionService, inject: [DependencyHealthService, ArticleService],
      useFactory: (health: DependencyHealthService, articles: ArticleService) => new LanguageSuggestionService(health.prisma, articles) },
    { provide: TelegramService, inject: [DependencyHealthService, DurableJobService, FactualBasisService, ArticleService],
      useFactory: (health: DependencyHealthService, jobs: DurableJobService, facts: FactualBasisService, articles: ArticleService) => new TelegramService(health.prisma, jobs, facts, articles) },
    { provide: ScriptService, inject: [DependencyHealthService, TelegramService],
      useFactory: (health: DependencyHealthService, channels: TelegramService) => new ScriptService(health.prisma, channels) },
    { provide: ScriptLanguageService, inject: [DependencyHealthService, ScriptService],
      useFactory: (health: DependencyHealthService, scripts: ScriptService) => new ScriptLanguageService(health.prisma, scripts) }], exports: [EditorialService, ArticleService, TelegramService, ScriptService, ScriptLanguageService] })
export class EditorialModule {}
