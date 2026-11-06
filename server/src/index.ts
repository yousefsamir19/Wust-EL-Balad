import 'dotenv/config';
import { createApp } from './app.js';
import { openWorld } from './db/index.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const db = openWorld();
const server = createApp(undefined, db).listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`Wust El Balad listening on port ${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
