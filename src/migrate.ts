import { openDb, migrate } from './db/connection.ts';

const path = process.env.JM_DB ?? 'data/jobmargin.db';
const db = openDb(path);
const applied = migrate(db);
console.log(`db=${path} applied migrations: ${applied.length ? applied.join(',') : '(none)'}`);
db.close();
