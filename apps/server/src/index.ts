import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const webDir =
  process.env.WARDEN_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

const app = await buildApp({ webDir, logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port, host });
