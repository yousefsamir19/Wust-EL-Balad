import type Database from 'better-sqlite3';

const citizens = [
  ['karim', 'Karim', 'Mechanic', 'mechanic', 'practical', '#396b8c'],
  ['laila', 'Laila', 'Cafe owner', 'cafe', 'outgoing', '#b45752'],
  ['omar', 'Omar', 'Bank teller', 'bank', 'careful', '#54648d'],
  ['nour', 'Nour', 'Journalist', 'square', 'curious', '#d6aa55'],
  ['youssef', 'Youssef', 'Store clerk', 'store', 'generous', '#5a875d'],
  ['dina', 'Dina', 'Accountant', 'bank', 'ambitious', '#87678f'],
  ['fatma', 'Fatma', 'Barista', 'cafe', 'patient', '#c3825b'],
  ['hassan', 'Hassan', 'Police officer', 'police', 'dutiful', '#46586e'],
  ['salma', 'Salma', 'Florist', 'square', 'optimistic', '#a96e96'],
  ['mostafa', 'Mostafa', 'Mechanic apprentice', 'mechanic', 'impulsive', '#758954'],
] as const;

export function seed(db: Database.Database) {
  if (db.prepare('SELECT id FROM world WHERE id = 1').get()) return;
  db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO world (id, seed, created_at, updated_at) VALUES (1, ?, ?, ?)').run('downtown-cairo-v1', now, now);
    const building = db.prepare('INSERT INTO buildings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [id, name, type, x, y, width, height] of [
      ['cafe', 'Cafe El Balad', 'cafe', 8, 8, 8, 7],
      ['bank', 'Downtown Bank', 'bank', 28, 8, 10, 7],
      ['police', 'Police Station', 'police', 48, 8, 9, 7],
      ['store', 'General Store', 'store', 8, 30, 8, 7],
      ['mechanic', 'Karim Workshop', 'mechanic', 28, 30, 10, 7],
      ['square', 'Talaat Harb Square', 'square', 48, 30, 10, 7],
    ] as const) {
      building.run(id, name, type, x, y, width, height, x + Math.floor(width / 2), y + height);
    }
    const citizen = db.prepare(`INSERT INTO citizens
      (id,name,job,money,personality,goals,needs,mood,x,y,home_id,workplace_id,building_id,activity,thoughts,appearance)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [index, [id, name, job, workplace, trait, clothing]] of citizens.entries()) {
      const home = `home-${id}`;
      const x = 6 + index * 6;
      building.run(home, `${name}'s home`, 'house', x, 48, 4, 5, x + 2, 53);
      citizen.run(id, name, job, 60000 + index * 7500,
        JSON.stringify({ trait, sociability: 30 + index * 6, caution: 80 - index * 5 }),
        JSON.stringify(['Stay financially secure', `Improve as a ${job.toLowerCase()}`]),
        JSON.stringify({ hunger: 15 + index * 3, energy: 85 - index * 2, social: 20 + index * 4 }),
        'Calm', x + 2, 53, home, workplace, home, 'idle', 'A new day in downtown Cairo.',
        JSON.stringify({ hair: index % 4, clothing, accessory: index % 3 }));
      const secret = `secret-${id}`;
      db.prepare('INSERT INTO secrets (id,owner_id,claim,truth_status) VALUES (?,?,?,?)')
        .run(secret, id, `${name} privately hopes to change something about their working life.`, 'true');
      db.prepare('INSERT INTO secret_knowledge (secret_id,citizen_id,confidence) VALUES (?,?,?)').run(secret, id, 100);
      db.prepare('INSERT INTO knowledge (citizen_id,kind,claim,confidence,game_time_ms) VALUES (?,?,?,?,?)')
        .run(id, 'belief', 'Steady work can help me achieve my goals.', 70, 28800000);
    }
    const relation = db.prepare('INSERT INTO relationships (citizen_id,other_id,trust,affection,respect) VALUES (?,?,?,?,?)');
    for (const [a, citizenA] of citizens.entries()) {
      for (const [b, citizenB] of citizens.entries()) {
        if (a !== b) relation.run(citizenA[0], citizenB[0], 35 + (a * 7 + b * 3) % 35, 25 + (a * 3 + b * 5) % 40, 45 + (a + b * 2) % 25);
      }
    }
  })();
}
