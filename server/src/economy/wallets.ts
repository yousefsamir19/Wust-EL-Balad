import type { WorldDatabase } from '../db/index.js';
import type { WorldState } from '../simulation/clock.js';
import type { Wallet } from './types.js';

type WalletKind = 'citizen' | 'business' | 'bank' | 'system';
type Parts = { kind: WalletKind; id: string };
type WalletSpec = { select: string; update: string };
type MoneyRow = {
  id: string;
  from_id: string | null;
  to_id: string | null;
  amount: number;
  type: string;
  event_id: number | null;
  from_account: string;
  to_account: string;
};
type BalanceRow = { balance: number };

const walletSpecs: Record<WalletKind, WalletSpec> = {
  citizen: { select: 'SELECT money AS balance FROM citizens WHERE id = ?', update: 'UPDATE citizens SET money = ? WHERE id = ?' },
  business: { select: 'SELECT balance FROM businesses WHERE id = ?', update: 'UPDATE businesses SET balance = ? WHERE id = ?' },
  bank: { select: 'SELECT balance FROM bank_accounts WHERE citizen_id = ?', update: 'UPDATE bank_accounts SET balance = ? WHERE citizen_id = ?' },
  system: { select: 'SELECT balance FROM system_wallets WHERE id = ?', update: 'UPDATE system_wallets SET balance = ? WHERE id = ?' },
};

const eventTypes: Record<string, string> = {
  wage: 'wage_paid', rent: 'rent_paid', purchase: 'purchase', deposit: 'bank_deposit',
  withdrawal: 'bank_withdrawal', loan: 'loan_issued', repayment: 'debt_repaid',
  restock: 'stock_purchase', transfer: 'money_transferred',
};

function validId(value: string, label: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw new Error(`${label} must be nonempty and at most 128 characters`);
}

function parts(wallet: Wallet): Parts {
  if (typeof wallet !== 'string') throw new Error('Unsupported wallet');
  const split = wallet.indexOf(':');
  const kind = wallet.slice(0, split) as WalletKind;
  const id = wallet.slice(split + 1);
  if (!Object.prototype.hasOwnProperty.call(walletSpecs, kind) || split < 1) throw new Error(`Unsupported wallet: ${wallet}`);
  validId(id, 'Wallet id');
  return { kind, id };
}

function readBalance(db: WorldDatabase, wallet: Wallet, parsed = parts(wallet)): number {
  const row = db.prepare(walletSpecs[parsed.kind].select).get(parsed.id) as BalanceRow | undefined;
  if (!row) throw new Error(`Wallet does not exist: ${wallet}`);
  if (!Number.isSafeInteger(row.balance) || row.balance < 0) throw new Error(`Invalid balance for wallet: ${wallet}`);
  return row.balance;
}

function publicDetails(details: Record<string, unknown>): string {
  const allowed: Record<string, unknown> = {};
  for (const key of ['fromAccount', 'toAccount', 'reason', 'kind', 'job', 'employerId', 'debtId'] as const) {
    if (Object.prototype.hasOwnProperty.call(details, key) && details[key] !== undefined) allowed[key] = details[key];
  }
  return JSON.stringify(allowed);
}

function defaultActor(from: Parts, to: Parts): string | null {
  if (from.kind === 'citizen') return from.id;
  if (to.kind === 'citizen') return to.id;
  return null;
}

function defaultTarget(from: Parts, to: Parts): string | null {
  if (to.kind === 'citizen') return to.id;
  if (to.kind === 'business') return to.id;
  if (from.kind === 'business') return from.id;
  return null;
}

function importance(kind: string): number {
  if (kind === 'loan') return 50;
  if (kind === 'repayment') return 20;
  if (kind === 'transfer') return 30;
  if (kind === 'wage') return 10;
  return 0;
}

export function requireTransaction(db: WorldDatabase): void {
  if (!db.inTransaction) throw new Error('Wallet operations require an authoritative transaction');
}

export function balance(db: WorldDatabase, wallet: Wallet): number {
  return readBalance(db, wallet);
}

export function economicEvent(
  db: WorldDatabase,
  world: WorldState,
  type: string,
  actorId: string | null,
  target: string | null,
  amount: number | null,
  eventImportance: number,
  details: Record<string, unknown> = {},
): number {
  requireTransaction(db);
  validId(type, 'Event type');
  if (actorId !== null) validId(actorId, 'Actor id');
  if (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0)) throw new Error('Event amount must be a positive safe integer');
  if (!Number.isSafeInteger(eventImportance) || eventImportance < 0) throw new Error('Event importance must be a nonnegative safe integer');
  const result = db.prepare(`INSERT INTO events
    (world_version, game_time_ms, type, actor_id, target, amount, importance, visibility, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`).run(
    world.version, world.game_time_ms, type, actorId, target, amount, eventImportance, publicDetails(details),
  );
  const eventId = Number(result.lastInsertRowid);
  if (!Number.isSafeInteger(eventId)) throw new Error('Event id is not a safe integer');
  return eventId;
}

export function transferMoney(
  db: WorldDatabase,
  world: WorldState,
  id: string,
  from: Wallet,
  to: Wallet,
  amount: number,
  kind: string,
  actorId?: string,
  target?: string,
): { id: string; amount: number; eventId: number } {
  requireTransaction(db);
  validId(id, 'Transaction id');
  validId(kind, 'Transaction kind');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Transfer amount must be a positive safe integer');
  const fromParts = parts(from);
  const toParts = parts(to);
  if (from === to) throw new Error('A transfer requires distinct wallets');
  if (actorId !== undefined && actorId !== null) validId(actorId, 'Actor id');

  return db.transaction(() => {
    const existing = db.prepare(`SELECT id, from_id, to_id, amount, type, event_id, from_account, to_account
      FROM money_transactions WHERE id = ?`).get(id) as MoneyRow | undefined;
    if (existing) {
      if (existing.from_account !== from || existing.to_account !== to || existing.amount !== amount || existing.type !== kind || existing.event_id === null) {
        throw new Error(`Transaction id already exists with different contents: ${id}`);
      }
      return { id: existing.id, amount: existing.amount, eventId: existing.event_id };
    }

    const fromBalance = readBalance(db, from, fromParts);
    const toBalance = readBalance(db, to, toParts);
    const nextFrom = fromBalance - amount;
    const nextTo = toBalance + amount;
    if (nextFrom < 0) throw new Error('Insufficient wallet balance');
    if (!Number.isSafeInteger(nextFrom) || !Number.isSafeInteger(nextTo)) throw new Error('Transfer would exceed safe integer balance');

    if (db.prepare(walletSpecs[fromParts.kind].update).run(nextFrom, fromParts.id).changes !== 1) throw new Error(`Wallet does not exist: ${from}`);
    if (db.prepare(walletSpecs[toParts.kind].update).run(nextTo, toParts.id).changes !== 1) throw new Error(`Wallet does not exist: ${to}`);

    const eventId = economicEvent(
      db, world, eventTypes[kind] ?? 'money_transferred',
      actorId ?? defaultActor(fromParts, toParts), target ?? defaultTarget(fromParts, toParts), amount,
      importance(kind), { fromAccount: from, toAccount: to },
    );
    db.prepare(`INSERT INTO money_transactions
      (id, from_id, to_id, amount, type, event_id, game_time_ms, from_account, to_account)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      fromParts.kind === 'citizen' ? fromParts.id : null,
      toParts.kind === 'citizen' ? toParts.id : null,
      amount, kind, eventId, world.game_time_ms, from, to,
    );
    return { id, amount, eventId };
  })();
}
