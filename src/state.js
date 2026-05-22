import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'state.db');

let db;

export function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id TEXT,
      title TEXT,
      artist TEXT,
      source TEXT,
      played_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan (
      day TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function addMessage(role, content) {
  db.prepare('INSERT INTO messages (role, content, ts) VALUES (?, ?, ?)')
    .run(role, content, Date.now());
}

export function getRecentMessages(limit = 20) {
  return db.prepare('SELECT role, content, ts FROM messages ORDER BY id DESC LIMIT ?')
    .all(limit).reverse();
}

export function addPlay({ song_id, title, artist, source }) {
  db.prepare('INSERT INTO plays (song_id, title, artist, source, played_at) VALUES (?, ?, ?, ?, ?)')
    .run(song_id ?? null, title ?? null, artist ?? null, source ?? null, Date.now());
}

export function getRecentPlays(limit = 20) {
  return db.prepare('SELECT song_id, title, artist, source, played_at FROM plays ORDER BY id DESC LIMIT ?')
    .all(limit);
}

export function setPlan(day, content) {
  db.prepare('INSERT OR REPLACE INTO plan (day, content, created_at) VALUES (?, ?, ?)')
    .run(day, JSON.stringify(content), Date.now());
}

export function getPlan(day) {
  const row = db.prepare('SELECT content FROM plan WHERE day = ?').get(day);
  return row ? JSON.parse(row.content) : null;
}

export function setPref(key, value) {
  db.prepare('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)')
    .run(key, JSON.stringify(value));
}

export function getPref(key) {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}
