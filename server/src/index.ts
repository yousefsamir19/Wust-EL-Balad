import 'dotenv/config';
import { createApp } from './app.js';
import { openWorld } from './db/index.js';
import { SimulationClock } from './simulation/clock.js';
import { attachRealtime } from './realtime/index.js';
import { AiScheduler } from './ai/scheduler.js';
import { envBudget,providersFromEnvironment } from './ai/config.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const db = openWorld();
const ai=new AiScheduler(providersFromEnvironment(),{requestBudget:envBudget('AI_REQUEST_BUDGET_PER_MINUTE',20),tokenBudget:envBudget('AI_TOKEN_BUDGET_PER_MINUTE',30000),timeoutMs:envBudget('AI_TIMEOUT_MS',5000)});
const clock = new SimulationClock(db, { onError: (error) => { console.error(error.message); shutdown(1); } });
const server = createApp(undefined, db,ai).listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`Wust El Balad listening on port ${port}`);
  clock.start();
});
const realtime = attachRealtime(server, db, clock);
const unsubscribeAiPresence=clock.subscribe(()=>ai.setActivePlayers(new Set([...realtime.io.sockets.sockets.values()].filter(socket=>socket.data.role==='player').map(socket=>socket.data.playerId)).size));
let closing = false;
function shutdown(code: number) {
  if (closing) return;
  closing = true;
  unsubscribeAiPresence();
  ai.stop();
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
