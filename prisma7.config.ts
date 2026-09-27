import { defineConfig } from 'prisma/config';
import { loadRuntimeConfig } from './packages/backend/src/config.js';
import { migrationConnectionUrl } from './packages/backend/src/database-connection.js';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: migrationConnectionUrl(loadRuntimeConfig()) }
});
