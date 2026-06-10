'use strict';

/**
 * Warstwa danych historycznych.
 *
 * Zgodnie z zalozeniami z pracy (rozdz. 3.3): kazdy pomiar ze sondy/symulatora ma
 * stala budowe (znacznik czasu, wartosc, ID zbiornika), wiec do jego przechowywania
 * uzywamy relacyjnej bazy danych. Tutaj jest to SQLite uruchomione in-memory, co daje
 * te sama semantyke SQL bez koniecznosci stawiania serwera PostgreSQL.
 *
 * Zmienna srodowiskowa DB_FILE pozwala podmienic baze in-memory na plikowa
 * (trwala) bez zmian w reszcie kodu.
 */

const Database = require('better-sqlite3');

const db = new Database(process.env.DB_FILE || ':memory:');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tank_id        TEXT    NOT NULL,
    ts             TEXT    NOT NULL,
    sim_hour       REAL,
    temperature    REAL    NOT NULL,
    oxygen         REAL    NOT NULL,
    recommended_kg REAL
  );

  CREATE INDEX IF NOT EXISTS idx_readings_tank_ts ON readings(tank_id, ts);

  CREATE TABLE IF NOT EXISTS decisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tank_id       TEXT    NOT NULL,
    ts            TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    final_mult    REAL    NOT NULL,
    recommended_kg REAL   NOT NULL,
    stress_index  INTEGER NOT NULL
  );
`);

const insertReadingStmt = db.prepare(
  `INSERT INTO readings (tank_id, ts, sim_hour, temperature, oxygen, recommended_kg)
   VALUES (@tankId, @ts, @simHour, @temperature, @oxygen, @recommendedKg)`
);

const insertDecisionStmt = db.prepare(
  `INSERT INTO decisions (tank_id, ts, status, final_mult, recommended_kg, stress_index)
   VALUES (@tankId, @ts, @status, @finalMult, @recommendedKg, @stressIndex)`
);

const recentReadingsStmt = db.prepare(
  `SELECT ts, sim_hour AS simHour, temperature, oxygen, recommended_kg AS recommendedKg FROM readings
   WHERE tank_id = ? ORDER BY id DESC LIMIT ?`
);

const latestReadingStmt = db.prepare(
  `SELECT ts, sim_hour AS simHour, temperature, oxygen, recommended_kg AS recommendedKg FROM readings
   WHERE tank_id = ? ORDER BY id DESC LIMIT 1`
);

const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM readings WHERE tank_id = ?`);

function saveReading(reading) {
  insertReadingStmt.run(reading);
}

function saveDecision(decision) {
  insertDecisionStmt.run(decision);
}

/** Zwraca ostatnie N odczytow w porzadku chronologicznym (rosnacym). */
function getRecentReadings(tankId, limit = 60) {
  return recentReadingsStmt.all(tankId, limit).reverse();
}

function getLatestReading(tankId) {
  return latestReadingStmt.get(tankId);
}

function countReadings(tankId) {
  return countStmt.get(tankId).n;
}

module.exports = {
  db,
  saveReading,
  saveDecision,
  getRecentReadings,
  getLatestReading,
  countReadings,
};
