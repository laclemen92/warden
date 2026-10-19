import { createDatabase, migrate } from '@wardenhq/pg-adapter';

// Standalone migration runner, for deployments that set WARDEN_MIGRATE=false and migrate as a
// privileged role while the server itself runs as a restricted one.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, close } = createDatabase({ connectionString });
try {
  const applied = await migrate(db);
  console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'already up to date');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await close();
}
