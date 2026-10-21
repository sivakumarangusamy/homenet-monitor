import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
fs.mkdirSync("data",{recursive:true});
const db=new Database(path.resolve("data/homenet.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS devices(id INTEGER PRIMARY KEY,name TEXT NOT NULL,host TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'device',enabled INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'unknown',latency_ms REAL,packet_loss_pct REAL,last_checked_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY,device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,checked_at TEXT NOT NULL,latency_ms REAL,success INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checks_device_time ON checks(device_id,checked_at);
CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY,device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,started_at TEXT NOT NULL,ended_at TEXT);
`);
if((db.prepare("SELECT COUNT(*) n FROM devices").get() as {n:number}).n===0){
 const add=db.prepare("INSERT INTO devices(name,host,kind) VALUES(?,?,?)");
 add.run("Home router","192.168.1.1","router"); add.run("Cloudflare DNS","1.1.1.1","internet");
}
export default db;
