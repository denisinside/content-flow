export const webOrigin = `http://localhost:${Number(process.env['E2E_WEB_PORT'] ?? '4173')}`;
export const apiOrigin = `http://127.0.0.1:${Number(process.env['E2E_API_PORT'] ?? '3000')}`;
export const workerOrigin = `http://127.0.0.1:${Number(process.env['E2E_WORKER_PORT'] ?? '3001')}`;
