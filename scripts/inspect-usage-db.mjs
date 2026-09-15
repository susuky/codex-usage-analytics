import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) throw new Error("usage.sqlite3 path is required");

const db = new DatabaseSync(path, { readOnly: true });
const sources = db.prepare(`
  SELECT id, name, target, last_scanned_at,
    (SELECT COUNT(*) FROM sessions AS item WHERE item.source_id = sources.id) AS sessions,
    (SELECT MAX(ended_at) FROM sessions AS item WHERE item.source_id = sources.id) AS latest
  FROM sources
  ORDER BY name
`).all();
const todayRows = db.prepare(`
  SELECT source_id, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS turns,
    COALESCE(SUM(total_tokens), 0) AS tokens
  FROM turns
  WHERE timestamp >= ?
  GROUP BY source_id
`).all("2026-09-03T16:00:00Z");
const overlaps = db.prepare(`
  SELECT left_session.source_id AS left_source, right_session.source_id AS right_source,
    COUNT(*) AS overlap
  FROM sessions AS left_session
  JOIN sessions AS right_session
    ON left_session.session_id = right_session.session_id
    AND left_session.source_id < right_session.source_id
  GROUP BY left_session.source_id, right_session.source_id
`).all();
const settings = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'app'").get().value);
db.close();

console.log(JSON.stringify({ sources, todayRows, overlaps, sshSources: settings.sshSources }, null, 2));
