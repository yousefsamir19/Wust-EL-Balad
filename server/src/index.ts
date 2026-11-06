import 'dotenv/config';
import { createApp } from './app.js';
import { openWorld } from './db/index.js';
import { SimulationClock } from './simulation/clock.js';
import { attachRealtime } from './realtime/index.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const db = openWorld();
const clock = new SimulationClock(db, { onError: (error) => { console.error(error.message); shutdown(1); } });
const server = createApp(undefined, db).listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`Wust El Balad listening on port ${port}`);
  clock.start();
});
const realtime = attachRealtime(server, db, clock);
let closing = false;
function shutdown(code: number) {
  if (closing) return;
  closing = true;
  clock.stop();
  realtime.close();
  server.close(() => { db.close(); process.exit(code); });
  server.closeIdleConnections();
  setTimeout(() => { if (db.open) db.close(); process.exit(code); }, 5000).unref();
}
server.on('error', (error) => { console.error(error.message); shutdown(1); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown(0));
}
