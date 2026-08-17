//! 로컬 SQLite 저장소. 추출 이력·프롬프트·설정·마스터 캐시가 전부 여기 들어간다.
//! 외부로 나가는 건 사용자가 명시적으로 내보내기를 눌렀을 때뿐이다.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        let conn = Connection::open(path)
            .with_context(|| format!("데이터베이스를 열지 못했습니다: {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        migrate(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS prompts (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            body       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            builtin    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id              TEXT PRIMARY KEY,
            pdf_name        TEXT NOT NULL,
            pdf_path        TEXT NOT NULL,
            page_count      INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL,
            status          TEXT NOT NULL,
            error           TEXT,
            prompt_id       TEXT,
            prompt_snapshot TEXT NOT NULL DEFAULT '',
            elapsed_ms      INTEGER NOT NULL DEFAULT 0,
            payload         TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);

        -- 구글시트에서 받아온 마스터 데이터 캐시. 오프라인에서도 앱이 돌아가게 한다.
        CREATE TABLE IF NOT EXISTS master_cache (
            tab       TEXT PRIMARY KEY,
            rows_json TEXT NOT NULL,
            synced_at TEXT NOT NULL
        );

        -- 확정 내역 장부. 여기가 1차 저장소이고 구글시트는 동기화 대상이다.
        -- 인터넷이 없거나 시트를 연결하지 않아도 장부는 그대로 쓸 수 있어야 한다.
        CREATE TABLE IF NOT EXISTS records (
            key        TEXT PRIMARY KEY,   -- DATE \u{1} Invoice_number \u{1} LOCATION
            values_json TEXT NOT NULL,     -- 16컬럼 값 배열
            synced     INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS records_synced ON records(synced);
        "#,
    )?;
    Ok(())
}

// ── settings ──────────────────────────────────────────────────────

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    Ok(rows.next()?.map(|r| r.get(0)).transpose()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ── master cache ──────────────────────────────────────────────────

pub fn cache_master(conn: &Connection, tab: &str, rows_json: &str, synced_at: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO master_cache(tab, rows_json, synced_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(tab) DO UPDATE SET rows_json = excluded.rows_json, synced_at = excluded.synced_at",
        params![tab, rows_json, synced_at],
    )?;
    Ok(())
}

pub fn read_master_cache(conn: &Connection) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare("SELECT tab, rows_json, synced_at FROM master_cache")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ── records (장부) ─────────────────────────────────────────────────

pub struct RecordRow {
    pub key: String,
    pub values: Vec<String>,
    pub synced: bool,
}

/// 이미 있는 키면 값만 갱신하고 synced 를 내린다(다시 올려야 하므로).
pub fn upsert_record(conn: &Connection, key: &str, values: &[String], synced: bool, now: &str) -> Result<bool> {
    let json = serde_json::to_string(values)?;
    let existing: Option<String> = conn
        .query_row("SELECT values_json FROM records WHERE key = ?1", params![key], |r| r.get(0))
        .ok();

    match existing {
        Some(old) if old == json => Ok(false), // 완전히 같으면 건드리지 않는다
        Some(_) => {
            conn.execute(
                "UPDATE records SET values_json = ?2, synced = ?3, updated_at = ?4 WHERE key = ?1",
                params![key, json, synced as i64, now],
            )?;
            Ok(true)
        }
        None => {
            conn.execute(
                "INSERT INTO records(key, values_json, synced, created_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?4)",
                params![key, json, synced as i64, now],
            )?;
            Ok(true)
        }
    }
}

pub fn list_records(conn: &Connection) -> Result<Vec<RecordRow>> {
    let mut stmt = conn.prepare("SELECT key, values_json, synced FROM records")?;
    let rows = stmt
        .query_map([], |r| {
            let json: String = r.get(1)?;
            Ok(RecordRow {
                key: r.get(0)?,
                values: serde_json::from_str(&json).unwrap_or_default(),
                synced: r.get::<_, i64>(2)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn mark_synced(conn: &Connection, keys: &[String]) -> Result<()> {
    for k in keys {
        conn.execute("UPDATE records SET synced = 1 WHERE key = ?1", params![k])?;
    }
    Ok(())
}

pub fn delete_record(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM records WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn unsynced_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM records WHERE synced = 0", [], |r| r.get(0))?)
}

// ── jobs ──────────────────────────────────────────────────────────

pub fn insert_job(
    conn: &Connection,
    id: &str,
    pdf_name: &str,
    pdf_path: &str,
    page_count: i64,
    created_at: &str,
    prompt_id: Option<&str>,
    prompt_snapshot: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO jobs(id, pdf_name, pdf_path, page_count, created_at, status, prompt_id, prompt_snapshot)
         VALUES(?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)",
        params![id, pdf_name, pdf_path, page_count, created_at, prompt_id, prompt_snapshot],
    )?;
    Ok(())
}

pub fn update_job_status(conn: &Connection, id: &str, status: &str, error: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE jobs SET status = ?2, error = ?3 WHERE id = ?1",
        params![id, status, error],
    )?;
    Ok(())
}

pub fn save_job_payload(conn: &Connection, id: &str, payload: &str, elapsed_ms: i64) -> Result<()> {
    conn.execute(
        "UPDATE jobs SET payload = ?2, elapsed_ms = ?3, status = 'done', error = NULL WHERE id = ?1",
        params![id, payload, elapsed_ms],
    )?;
    Ok(())
}

pub fn list_jobs(conn: &Connection) -> Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
        "SELECT id, pdf_name, pdf_path, page_count, created_at, status, error, prompt_id,
                prompt_snapshot, elapsed_ms, payload
         FROM jobs ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let payload: String = r.get(10)?;
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "pdfName": r.get::<_, String>(1)?,
                "pdfPath": r.get::<_, String>(2)?,
                "pageCount": r.get::<_, i64>(3)?,
                "createdAt": r.get::<_, String>(4)?,
                "status": r.get::<_, String>(5)?,
                "error": r.get::<_, Option<String>>(6)?,
                "promptId": r.get::<_, Option<String>>(7)?,
                "promptSnapshot": r.get::<_, String>(8)?,
                "elapsedMs": r.get::<_, i64>(9)?,
                "payload": serde_json::from_str::<serde_json::Value>(&payload)
                    .unwrap_or(serde_json::json!({})),
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 앱이 추출 도중 꺼지면 그 작업은 'extracting' 상태로 영영 남는다.
/// 프로세스는 이미 사라졌으므로 기동할 때 중단됨으로 바꿔 준다.
pub fn mark_stale_jobs_interrupted(conn: &Connection) -> Result<usize> {
    let n = conn.execute(
        "UPDATE jobs SET status = 'interrupted',
                error = COALESCE(error, '앱이 종료되어 추출이 중단되었습니다.')
         WHERE status IN ('pending', 'rendering', 'extracting')",
        [],
    )?;
    Ok(n)
}

pub fn delete_job(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM jobs WHERE id = ?1", params![id])?;
    Ok(())
}

// ── prompts ───────────────────────────────────────────────────────

pub fn upsert_prompt(
    conn: &Connection,
    id: &str,
    name: &str,
    body: &str,
    created_at: &str,
    builtin: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO prompts(id, name, body, created_at, builtin) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, body = excluded.body",
        params![id, name, body, created_at, builtin as i64],
    )?;
    Ok(())
}

pub fn list_prompts(conn: &Connection) -> Result<Vec<serde_json::Value>> {
    let mut stmt =
        conn.prepare("SELECT id, name, body, created_at, builtin FROM prompts ORDER BY builtin DESC, created_at DESC")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "body": r.get::<_, String>(2)?,
                "createdAt": r.get::<_, String>(3)?,
                "builtin": r.get::<_, i64>(4)? != 0,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn delete_prompt(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM prompts WHERE id = ?1 AND builtin = 0", params![id])?;
    Ok(())
}
