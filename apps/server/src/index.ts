import { fileURLToPath } from 'node:url';
import { ConfigError } from '@wardenhq/config';
import { createWarden } from './warden.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const webDir =
  process.env.WARDEN_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

const app = await createWarden({ webDir, logger: true }).catch((err: unknown) => {
  // Config errors are already formatted for humans; anything else gets a stack trace.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port, host });
