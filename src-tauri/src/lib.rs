mod claude;
mod db;
mod secrets;
mod sheets;

use anyhow::Result;
use base64::Engine;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

/// anyhow 에러를 프런트에 문자열로 넘기기 위한 얇은 래퍼.
fn e(err: anyhow::Error) -> String {
    format!("{err:#}")
}

struct AppState {
    db: db::Db,
    data_dir: PathBuf,
    /// 서비스 계정 키 캐시.
    ///
    /// macOS 키체인은 접근할 때마다 사용자에게 확인을 요구할 수 있어서, 화면을 옮길 때마다
    /// 암호를 묻는 일이 생긴다. 실행당 한 번만 읽고 메모리에 들고 있는다.
    key_cache: std::sync::Mutex<Option<String>>,
    /// 진행 중인 claude 프로세스. 앱 종료 시 정리한다.
    running: std::sync::Arc<claude::Running>,
}

impl AppState {
    /// 캐시된 키를 주고, 없으면 키체인에서 한 번 읽어 캐시한다.
    fn service_key(&self) -> Result<Option<String>, String> {
        {
            let cached = self.key_cache.lock().unwrap();
            if cached.is_some() {
                return Ok(cached.clone());
            }
        }
        let loaded = secrets::load_key().map_err(e)?;
        *self.key_cache.lock().unwrap() = loaded.clone();
        Ok(loaded)
    }

    fn set_service_key(&self, key: Option<String>) {
        *self.key_cache.lock().unwrap() = key;
    }

    fn running_handle(&self) -> std::sync::Arc<claude::Running> {
        self.running.clone()
    }
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// ── claude ────────────────────────────────────────────────────────

#[tauri::command]
fn claude_status(state: State<AppState>) -> Result<String, String> {
    let conn = state.db.0.lock().unwrap();
    let configured = db::get_setting(&conn, "claude_path").map_err(e)?;
    drop(conn);
    let cli = claude::resolve_cli(configured.as_deref()).map_err(e)?;
    let version = claude::health_check(&cli).map_err(e)?;
    Ok(format!("{version} · {}", cli.display()))
}

/// 프런트(pdf.js)가 렌더링한 페이지 PNG 들을 작업 폴더에 저장한다.
/// 한 조각의 페이지 이미지를 저장한다.
///
/// PDF 를 통째로 한 번에 돌리면 페이지 수에 비례해 시간이 늘어난다(장당 10~15초).
/// 조각으로 나눠 동시에 돌리면 그만큼 빨라지므로, 조각마다 별도 폴더를 쓴다.
/// 파일명에는 원본 페이지 번호를 그대로 넣어 나중에 합칠 때 헷갈리지 않게 한다.
#[tauri::command]
fn stage_pages(
    state: State<AppState>,
    job_id: String,
    chunk: usize,
    page_numbers: Vec<usize>,
    pages_base64: Vec<String>,
) -> Result<String, String> {
    let workdir = chunk_dir(&state.data_dir, &job_id, chunk);
    std::fs::create_dir_all(&workdir).map_err(|x| x.to_string())?;

    let engine = base64::engine::general_purpose::STANDARD;
    for (i, b64) in pages_base64.iter().enumerate() {
        let n = page_numbers.get(i).copied().unwrap_or(i + 1);
        // data URL 로 넘어오는 경우를 대비해 앞부분을 떼어낸다.
        let raw = b64.split(",").last().unwrap_or(b64);
        let bytes = engine.decode(raw).map_err(|x| format!("페이지 {n} 디코딩 실패: {x}"))?;
        std::fs::write(workdir.join(format!("page{n:02}.png")), bytes)
            .map_err(|x| x.to_string())?;
    }
    Ok(workdir.to_string_lossy().to_string())
}

fn chunk_dir(data_dir: &std::path::Path, job_id: &str, chunk: usize) -> PathBuf {
    data_dir.join("jobs").join(job_id).join(format!("c{chunk}"))
}

#[tauri::command]
async fn run_extraction(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    chunk: usize,
    prompt: String,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let (configured, workdir) = {
        let conn = state.db.0.lock().unwrap();
        let c = db::get_setting(&conn, "claude_path").map_err(e)?;
        (c, chunk_dir(&state.data_dir, &job_id, chunk))
    };

    let cli = claude::resolve_cli(configured.as_deref()).map_err(e)?;
    let running = state.running_handle();
    let id = format!("{job_id}#{chunk}");

    // claude 실행은 블로킹이라 별도 스레드로 뺀다.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        claude::run_extraction(
            &cli,
            &workdir,
            &prompt,
            Duration::from_secs(timeout_secs),
            &running,
            &id,
            // 추출이 몇 분씩 걸리므로 진행 상황을 그때그때 화면으로 보낸다.
            move |p| {
                let _ = app.emit("extraction-progress", p);
            },
        )
    })
    .await
    .map_err(|x| x.to_string())?
    .map_err(e)?;

    // 추출이 끝나면 claude 대화 기록은 쓸모가 없다. 한 건에 수십 MB 라 바로 지운다.
    let freed = claude::cleanup_session(&chunk_dir(&state.data_dir, &job_id, chunk));
    if freed > 0 {
        eprintln!("claude 세션 기록 {}MB 정리", freed / 1_048_576);
    }

    let parsed: serde_json::Value = serde_json::from_str(&outcome.extracted_json)
        .map_err(|x| format!("추출 결과 JSON 을 해석하지 못했습니다: {x}"))?;

    Ok(serde_json::json!({ "result": parsed, "elapsedMs": outcome.elapsed_ms }))
}

// ── jobs ──────────────────────────────────────────────────────────

#[tauri::command]
fn create_job(
    state: State<AppState>,
    pdf_name: String,
    pdf_path: String,
    page_count: i64,
    prompt_id: Option<String>,
    prompt_snapshot: String,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = state.db.0.lock().unwrap();
    db::insert_job(
        &conn,
        &id,
        &pdf_name,
        &pdf_path,
        page_count,
        &now(),
        prompt_id.as_deref(),
        &prompt_snapshot,
    )
    .map_err(e)?;
    Ok(id)
}

#[tauri::command]
fn set_job_status(
    state: State<AppState>,
    job_id: String,
    status: String,
    error: Option<String>,
) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::update_job_status(&conn, &job_id, &status, error.as_deref()).map_err(e)
}

/// 사용자가 표에서 고친 내용을 저장한다.
#[tauri::command]
fn save_job_payload(
    state: State<AppState>,
    job_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::save_job_payload(&conn, &job_id, &payload.to_string(), 0).map_err(e)
}

#[tauri::command]
fn list_jobs(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let conn = state.db.0.lock().unwrap();
    db::list_jobs(&conn).map_err(e)
}

#[tauri::command]
fn delete_job(state: State<AppState>, job_id: String) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::delete_job(&conn, &job_id).map_err(e)?;
    let _ = std::fs::remove_dir_all(state.data_dir.join("jobs").join(&job_id));
    Ok(())
}

// ── prompts ───────────────────────────────────────────────────────

#[tauri::command]
fn save_prompt(
    state: State<AppState>,
    id: Option<String>,
    name: String,
    body: String,
    builtin: Option<bool>,
) -> Result<String, String> {
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let conn = state.db.0.lock().unwrap();
    db::upsert_prompt(&conn, &id, &name, &body, &now(), builtin.unwrap_or(false)).map_err(e)?;
    Ok(id)
}

#[tauri::command]
fn list_prompts(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let conn = state.db.0.lock().unwrap();
    db::list_prompts(&conn).map_err(e)
}

#[tauri::command]
fn delete_prompt(state: State<AppState>, id: String) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::delete_prompt(&conn, &id).map_err(e)
}

// ── settings ──────────────────────────────────────────────────────

#[tauri::command]
fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let conn = state.db.0.lock().unwrap();
    db::get_setting(&conn, &key).map_err(e)
}

#[tauri::command]
fn set_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::set_setting(&conn, &key, &value).map_err(e)
}

#[tauri::command]
fn data_dir(state: State<AppState>) -> String {
    state.data_dir.to_string_lossy().to_string()
}

/// 파일을 저장 대화상자로 내보낸다.
///
/// 웹의 `<a download>` 는 Tauri 웹뷰에서 동작하지 않아 버튼을 눌러도 아무 일이 없었다.
/// 저장 위치를 직접 고르게 하고 네이티브로 쓴다.
#[tauri::command]
async fn save_file_as(
    app: tauri::AppHandle,
    default_name: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let ext = std::path::Path::new(&default_name)
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("xlsx")
        .to_string();

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(format!("{} 파일", ext.to_uppercase()), &[ext.as_str()])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(path) = rx.recv().map_err(|x| x.to_string())? else {
        return Ok(None); // 사용자가 취소했다
    };

    let path = path
        .into_path()
        .map_err(|x| format!("저장 위치를 해석하지 못했습니다: {x}"))?;
    std::fs::write(&path, bytes).map_err(|x| format!("저장에 실패했습니다: {x}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 작업 폴더에 남아 있는 조각별 추출 결과를 모아 돌려준다.
///
/// 앱이 강제 종료되면 claude 는 살아남아 결과를 다 쓰고 끝난다. 그런데 그걸 받아 갈
/// 앱이 없어서 결과가 디스크에 남은 채 버려진다. 이미 비용을 치른 작업이므로
/// 다시 켰을 때 주워 담는다. 정상 종료 때도 먼저 끝난 조각은 살릴 수 있다.
#[tauri::command]
fn chunk_results(state: State<AppState>, job_id: String) -> Result<Vec<serde_json::Value>, String> {
    let root = state.data_dir.join("jobs").join(&job_id);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(Vec::new());
    };

    // c0, c1 … 순서를 지켜야 합칠 때 페이지 순서가 유지된다.
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();

    let mut out = Vec::new();
    for d in dirs {
        let f = d.join("extracted.json");
        if !f.is_file() {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&f) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                out.push(v);
            }
        }
    }
    Ok(out)
}

/// 아직 끝나지 않은 것으로 남아 있는 작업들.
#[tauri::command]
fn unfinished_jobs(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let conn = state.db.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, pdf_name, page_count, status FROM jobs
             WHERE status != 'done' ORDER BY created_at DESC",
        )
        .map_err(|x| x.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "pdfName": r.get::<_, String>(1)?,
                "pageCount": r.get::<_, i64>(2)?,
                "status": r.get::<_, String>(3)?,
            }))
        })
        .map_err(|x| x.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 원본 PDF 를 작업 폴더에 보관한다.
///
/// 추출용 이미지는 긴 변 1568px 로 줄여 만든다(claude 가 그 크기로 보기 때문에 더 크게
/// 만들어도 인식률은 그대로다). 하지만 사람이 원본과 대조할 때는 그 해상도로는 글씨가
/// 뭉개진다. PDF 를 그대로 두고 볼 때마다 필요한 배율로 다시 그리는 편이 훨씬 선명하고,
/// 페이지 PNG 를 여러 장 두는 것보다 용량도 적다.
#[tauri::command]
fn store_pdf(state: State<AppState>, job_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let dir = state.data_dir.join("jobs").join(&job_id);
    std::fs::create_dir_all(&dir).map_err(|x| x.to_string())?;
    std::fs::write(dir.join("source.pdf"), bytes).map_err(|x| x.to_string())
}

/// 보관해 둔 원본 PDF 를 돌려준다. 없으면 None.
#[tauri::command]
fn read_pdf(state: State<AppState>, job_id: String) -> Result<Option<Vec<u8>>, String> {
    let path = state.data_dir.join("jobs").join(&job_id).join("source.pdf");
    if !path.is_file() {
        return Ok(None);
    }
    std::fs::read(&path).map(Some).map_err(|x| x.to_string())
}

/// 작업의 페이지 이미지를 돌려준다 (data URL).
///
/// 추출 직후에는 화면이 들고 있는 미리보기를 쓰면 되지만, 이력에서 과거 기록을 열면
/// 그 미리보기가 없다. 원본과 대조하려면 디스크에 있는 이미지를 다시 읽어야 한다.
#[tauri::command]
fn page_image(state: State<AppState>, job_id: String, page: usize) -> Result<Option<String>, String> {
    // 조각 나눠 처리하므로 페이지는 c0, c1 … 아래에 흩어져 있다.
    let root = state.data_dir.join("jobs").join(&job_id);
    let name = format!("page{page:02}.png");
    let mut found = root.join(&name);
    if !found.is_file() {
        found = match std::fs::read_dir(&root)
            .ok()
            .and_then(|d| {
                d.flatten()
                    .map(|e| e.path().join(&name))
                    .find(|p| p.is_file())
            }) {
            Some(p) => p,
            None => return Ok(None), // 이미지를 비웠을 수 있다. 오류가 아니다.
        };
    }

    let bytes = std::fs::read(&found).map_err(|x| x.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(format!("data:image/png;base64,{b64}")))
}

/// 그 작업의 페이지 이미지가 아직 남아 있는지.
#[tauri::command]
fn has_page_images(state: State<AppState>, job_id: String) -> bool {
    dir_size(&state.data_dir.join("jobs").join(&job_id)) > 0
}

// ── 저장 용량 ──────────────────────────────────────────────────────

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/// 무엇이 얼마나 차지하고 있는지 보여준다. 대부분은 작업별 페이지 이미지다.
#[tauri::command]
fn storage_stats(state: State<AppState>) -> Result<serde_json::Value, String> {
    let jobs_dir = state.data_dir.join("jobs");

    let mut per_job = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&jobs_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let id = entry.file_name().to_string_lossy().to_string();
                let bytes = dir_size(&entry.path());
                let images = std::fs::read_dir(entry.path())
                    .map(|d| d.flatten().filter(|f| {
                        f.path().extension().and_then(|x| x.to_str()) == Some("png")
                    }).count())
                    .unwrap_or(0);
                per_job.push(serde_json::json!({ "id": id, "bytes": bytes, "images": images }));
            }
        }
    }

    let db_bytes: u64 = ["invoice-extractor.db", "invoice-extractor.db-wal", "invoice-extractor.db-shm"]
        .iter()
        .map(|f| std::fs::metadata(state.data_dir.join(f)).map(|m| m.len()).unwrap_or(0))
        .sum();

    let images_bytes: u64 = per_job.iter().map(|j| j["bytes"].as_u64().unwrap_or(0)).sum();
    let session_bytes = claude_sessions_size();

    Ok(serde_json::json!({
        "dataDir": state.data_dir.to_string_lossy(),
        "dbBytes": db_bytes,
        "imagesBytes": images_bytes,
        // claude 가 앱 폴더 밖(~/.claude/projects)에 남기는 대화 기록.
        // 여기 포함하지 않으면 실제로 쓰는 용량이 훨씬 큰데도 모르고 지나간다.
        "sessionBytes": session_bytes,
        "totalBytes": db_bytes + images_bytes + session_bytes,
        "jobDirs": per_job.len(),
        "perJob": per_job,
    }))
}

/// 이 앱이 만든 claude 대화 기록 폴더들을 찾는다.
fn claude_session_dirs() -> Vec<PathBuf> {
    let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) else {
        return Vec::new();
    };
    let root = PathBuf::from(home).join(".claude/projects");
    std::fs::read_dir(&root)
        .map(|d| {
            d.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_dir()
                        && p.file_name()
                            .and_then(|x| x.to_str())
                            .map(|n| n.contains("com-scr-invoice-extractor-jobs-"))
                            .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn claude_sessions_size() -> u64 {
    claude_session_dirs().iter().map(|p| dir_size(p)).sum()
}

/// 남아 있는 claude 대화 기록을 모두 지운다. 확보한 바이트 수를 돌려준다.
#[tauri::command]
fn clear_claude_sessions() -> u64 {
    let mut freed = 0;
    for d in claude_session_dirs() {
        freed += dir_size(&d);
        let _ = std::fs::remove_dir_all(&d);
    }
    freed
}

/// 페이지 이미지를 지운다. 추출된 표와 이력은 DB 에 있으므로 그대로 남는다.
///
/// `job_id` 를 주면 그 작업만, 없으면 전부. 지운 바이트 수를 돌려준다.
#[tauri::command]
fn clear_page_images(state: State<AppState>, job_id: Option<String>) -> Result<u64, String> {
    Ok(clear_images_in(&state.data_dir.join("jobs"), job_id.as_deref()))
}

/// `clear_page_images` 의 알맹이. Tauri 상태에 의존하지 않아 테스트할 수 있다.
fn clear_images_in(jobs_dir: &std::path::Path, job_id: Option<&str>) -> u64 {
    let targets: Vec<PathBuf> = match job_id {
        Some(id) => vec![jobs_dir.join(id)],
        None => std::fs::read_dir(jobs_dir)
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default(),
    };

    let mut freed = 0u64;
    for dir in targets {
        if !dir.is_dir() {
            continue;
        }
        // 조각 폴더(c0, c1 …) 안에 이미지가 들어 있으므로 하위까지 훑는다.
        freed += purge_originals(&dir);
        if std::fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(&dir);
        }
    }
    freed
}

/// 원본 대조용 파일(페이지 이미지·PDF)만 지운다. 추출 결과는 DB 에 있어 영향 없다.
fn purge_originals(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut freed = 0u64;
    for f in entries.flatten() {
        let p = f.path();
        if p.is_dir() {
            freed += purge_originals(&p);
            let _ = std::fs::remove_dir(&p);
            continue;
        }
        let ext = p.extension().and_then(|x| x.to_str()).map(str::to_string);
        if matches!(ext.as_deref(), Some("png") | Some("pdf")) {
            freed += f.metadata().map(|m| m.len()).unwrap_or(0);
            let _ = std::fs::remove_file(&p);
        }
    }
    freed
}

/// 지정한 날짜보다 오래된 추출 이력을 지운다. 장부(records)는 건드리지 않는다.
#[tauri::command]
fn purge_jobs_before(state: State<AppState>, before: String) -> Result<serde_json::Value, String> {
    let conn = state.db.0.lock().unwrap();
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM jobs WHERE created_at < ?1")
            .map_err(|x| x.to_string())?;
        let rows = stmt
            .query_map([&before], |r| r.get::<_, String>(0))
            .map_err(|x| x.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut freed = 0u64;
    for id in &ids {
        let dir = state.data_dir.join("jobs").join(id);
        freed += dir_size(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        db::delete_job(&conn, id).map_err(e)?;
    }
    conn.execute("VACUUM", []).ok();

    Ok(serde_json::json!({ "deleted": ids.len(), "freedBytes": freed }))
}

// ── google sheets ─────────────────────────────────────────────────

#[tauri::command]
fn save_service_account_key(state: State<AppState>, key_json: String) -> Result<String, String> {
    secrets::store_key(&key_json).map_err(e)?;
    let email = sheets::client_email_of(&key_json).map_err(e)?;
    state.set_service_key(Some(key_json));
    // 이메일은 비밀이 아니다. 여기 적어두면 화면을 열 때마다 키체인을 건드리지 않아도 된다.
    let conn = state.db.0.lock().unwrap();
    db::set_setting(&conn, "service_account_email", &email).map_err(e)?;
    Ok(email)
}

/// 등록된 서비스 계정 이메일.
///
/// 평소에는 설정에서 읽어 키체인을 건드리지 않는다. 다만 앱을 다시 깔거나 데이터 폴더가
/// 초기화되면 설정만 비고 키체인에는 키가 남는다. 그 경우 한 번만 키체인을 읽어 되채운다.
#[tauri::command]
fn service_account_email(state: State<AppState>) -> Result<Option<String>, String> {
    {
        let conn = state.db.0.lock().unwrap();
        if let Some(saved) = db::get_setting(&conn, "service_account_email").map_err(e)? {
            if !saved.is_empty() {
                return Ok(Some(saved));
            }
            // 빈 문자열은 사용자가 키를 지웠다는 뜻이므로 키체인을 다시 보지 않는다.
            return Ok(None);
        }
    }

    let Some(json) = state.service_key()? else {
        return Ok(None);
    };
    let email = sheets::client_email_of(&json).map_err(e)?;
    let conn = state.db.0.lock().unwrap();
    db::set_setting(&conn, "service_account_email", &email).map_err(e)?;
    Ok(Some(email))
}

#[tauri::command]
fn clear_service_account_key(state: State<AppState>) -> Result<(), String> {
    secrets::clear_key().map_err(e)?;
    state.set_service_key(None);
    let conn = state.db.0.lock().unwrap();
    db::set_setting(&conn, "service_account_email", "").map_err(e)
}

async fn connect(state: &State<'_, AppState>) -> Result<(sheets::SheetsClient, String), String> {
    let json = state
        .service_key()?
        .ok_or_else(|| "서비스 계정 키가 등록되어 있지 않습니다.".to_string())?;
    let key = sheets::ServiceAccountKey::parse(&json).map_err(e)?;
    let url = {
        let conn = state.db.0.lock().unwrap();
        db::get_setting(&conn, "sheet_url")
            .map_err(e)?
            .ok_or_else(|| "마스터 시트 URL 이 설정되어 있지 않습니다.".to_string())?
    };
    let client = sheets::SheetsClient::connect(&key, &url).await.map_err(e)?;
    Ok((client, key.client_email))
}

#[tauri::command]
async fn test_sheet_connection(state: State<'_, AppState>) -> Result<sheets::SheetInfo, String> {
    let (client, email) = connect(&state).await?;
    client.info(&email).await.map_err(e)
}

/// 마스터 시트를 읽어 로컬 캐시에 넣는다.
#[tauri::command]
async fn sync_master(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let (client, _) = connect(&state).await?;
    let stamp = now();
    let mut out = serde_json::Map::new();

    for tab in ["Vendors", "Cards", "Locations", "COA"] {
        let rows = client.read_tab(tab).await.map_err(e)?;
        let json = serde_json::to_string(&rows).map_err(|x| x.to_string())?;
        {
            let conn = state.db.0.lock().unwrap();
            db::cache_master(&conn, tab, &json, &stamp).map_err(e)?;
        }
        out.insert(tab.to_string(), serde_json::json!(rows));
    }
    out.insert("syncedAt".into(), serde_json::json!(stamp));
    Ok(serde_json::Value::Object(out))
}

/// 캐시된 마스터를 돌려준다 (오프라인 기동용).
#[tauri::command]
fn cached_master(state: State<AppState>) -> Result<serde_json::Value, String> {
    let conn = state.db.0.lock().unwrap();
    let mut out = serde_json::Map::new();
    let mut synced = String::new();
    for (tab, rows_json, synced_at) in db::read_master_cache(&conn).map_err(e)? {
        out.insert(
            tab,
            serde_json::from_str(&rows_json).unwrap_or(serde_json::json!([])),
        );
        synced = synced_at;
    }
    out.insert("syncedAt".into(), serde_json::json!(synced));
    Ok(serde_json::Value::Object(out))
}

/// 시트에 탭과 헤더를 만들고 초기 데이터를 채운다.
#[tauri::command]
async fn init_master_sheet(
    state: State<'_, AppState>,
    tabs: serde_json::Value,
) -> Result<(), String> {
    let (client, _) = connect(&state).await?;
    let obj = tabs
        .as_object()
        .ok_or_else(|| "탭 데이터 형식이 올바르지 않습니다.".to_string())?;
    for (tab, rows) in obj {
        let rows: Vec<Vec<String>> =
            serde_json::from_value(rows.clone()).map_err(|x| x.to_string())?;
        client.write_tab(tab, rows).await.map_err(e)?;
    }
    Ok(())
}

/// 새로 발견된 벤더 한 줄을 Vendors 탭에 덧붙인다.
#[tauri::command]
async fn append_vendor(state: State<'_, AppState>, row: Vec<String>) -> Result<(), String> {
    let (client, _) = connect(&state).await?;
    // 반드시 append 로 붙인다. 읽어서 통째로 다시 쓰면 버튼을 연달아 누를 때
    // 서로 덮어써서 기존 벤더가 통째로 사라진다(실제로 그런 사고가 있었다).
    client.append_rows("Vendors", vec![row]).await.map_err(e)?;
    Ok(())
}

/// 마스터 탭을 로컬 캐시로 되살린다.
///
/// 시트 내용이 지워졌을 때 쓴다. 마지막 동기화 시점의 캐시를 바탕으로 하되,
/// 지금 시트에만 있는 행(캐시 이후에 추가된 것)은 그대로 살려 둔다.
#[tauri::command]
async fn restore_master_tab(
    state: State<'_, AppState>,
    tab: String,
) -> Result<serde_json::Value, String> {
    let cached: Vec<Vec<String>> = {
        let conn = state.db.0.lock().unwrap();
        let found = db::read_master_cache(&conn)
            .map_err(e)?
            .into_iter()
            .find(|(t, _, _)| *t == tab);
        match found {
            Some((_, json, _)) => serde_json::from_str(&json).unwrap_or_default(),
            None => return Err(format!("{tab} 탭의 로컬 캐시가 없습니다.")),
        }
    };
    if cached.is_empty() {
        return Err(format!("{tab} 탭의 로컬 캐시가 비어 있습니다."));
    }

    let (client, _) = connect(&state).await?;
    let current = client.read_tab(&tab).await.unwrap_or_default();

    // 첫 칸(이름)을 기준으로 이미 있는 것은 건너뛴다.
    let known: std::collections::HashSet<String> = cached
        .iter()
        .filter_map(|r| r.first().map(|x| x.trim().to_lowercase()))
        .collect();

    let mut merged = cached.clone();
    let mut kept = 0usize;
    for r in current.into_iter().skip(1) {
        let name = r.first().map(|x| x.trim().to_lowercase()).unwrap_or_default();
        if name.is_empty() || known.contains(&name) {
            continue;
        }
        merged.push(r);
        kept += 1;
    }

    let total = merged.len().saturating_sub(1);
    client.write_tab(&tab, merged).await.map_err(e)?;
    Ok(serde_json::json!({ "restored": total, "kept": kept }))
}

/// 장부 키. DATE + Invoice_number + LOCATION 조합으로 같은 내역을 식별한다.
fn record_key(row: &[String], header: &[String]) -> String {
    ["date", "invoiceno", "buyer"]
        .iter()
        .map(|name| {
            header
                .iter()
                .position(|h| h == name)
                .and_then(|i| row.get(i))
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join("\u{1}")
}

/// 확정 내역을 로컬 장부에 저장한다. 인터넷·시트 연결과 무관하게 항상 성공해야 한다.
#[tauri::command]
fn save_records_local(
    state: State<AppState>,
    header: Vec<String>,
    rows: Vec<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let conn = state.db.0.lock().unwrap();
    // 형식이 바뀌기 전에 보관한 행은 컬럼이 어긋나 쓸 수 없다. 시트로 나가기 전에 치운다.
    let dropped = db::purge_mismatched_records(&conn, header.len()).map_err(e)?;
    let stamp = now();
    let mut changed = 0usize;
    let mut same = 0usize;
    for r in &rows {
        let key = record_key(r, &header);
        if db::upsert_record(&conn, &key, r, false, &stamp).map_err(e)? {
            changed += 1;
        } else {
            same += 1;
        }
    }
    let pending = db::unsynced_count(&conn).map_err(e)?;
    Ok(serde_json::json!({
        "saved": changed, "unchanged": same, "pending": pending, "dropped": dropped
    }))
}

/// 로컬 장부 전체를 돌려준다.
#[tauri::command]
fn list_records_local(state: State<AppState>) -> Result<serde_json::Value, String> {
    let conn = state.db.0.lock().unwrap();
    let rows = db::list_records(&conn).map_err(e)?;
    Ok(serde_json::json!({
        "rows": rows.iter().map(|r| serde_json::json!({
            "key": r.key, "values": r.values, "synced": r.synced
        })).collect::<Vec<_>>(),
        "pending": db::unsynced_count(&conn).map_err(e)?,
    }))
}

#[tauri::command]
fn delete_record_local(state: State<AppState>, key: String) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::delete_record(&conn, &key).map_err(e)
}

/// 로컬 장부와 구글시트 Records 탭을 맞춘다.
///
/// 한쪽에만 있는 행을 서로 채워 넣는 합집합 방식이다. 양쪽에 같은 키가 있는데 값이 다르면
/// 임의로 덮어쓰지 않고 건수만 알려준다 — 어느 쪽이 맞는지는 사람이 판단할 일이다.
#[tauri::command]
async fn sync_records(
    state: State<'_, AppState>,
    header: Vec<String>,
) -> Result<serde_json::Value, String> {
    let (client, _) = connect(&state).await?;

    let (local, dropped) = {
        let conn = state.db.0.lock().unwrap();
        // 옛 형식 행이 섞여 있으면 시트의 컬럼이 통째로 밀린다. 먼저 치운다.
        let dropped = db::purge_mismatched_records(&conn, header.len()).map_err(e)?;
        (db::list_records(&conn).map_err(e)?, dropped)
    };

    let sheet_rows = if client.tab_exists("History").await.map_err(e)? {
        client.read_tab("History").await.map_err(e)?
    } else {
        client.append_rows("History", vec![header.clone()]).await.map_err(e)?;
        vec![header.clone()]
    };

    let sheet_header = sheet_rows.first().cloned().unwrap_or_else(|| header.clone());
    if sheet_header != header {
        bail_sync(&sheet_header, &header)?;
    }
    let sheet_body: Vec<&Vec<String>> = sheet_rows
        .iter()
        .skip(1)
        .filter(|r| r.iter().any(|c| !c.trim().is_empty()))
        .collect();

    let sheet_map: std::collections::HashMap<String, &Vec<String>> = sheet_body
        .iter()
        .map(|r| (record_key(r, &sheet_header), *r))
        .collect();
    let local_keys: std::collections::HashSet<&String> = local.iter().map(|r| &r.key).collect();

    // 로컬에만 있는 것 → 시트로 올린다.
    let mut push_rows = Vec::new();
    let mut push_keys = Vec::new();
    let mut conflicts = 0usize;
    for r in &local {
        match sheet_map.get(&r.key) {
            None => {
                push_rows.push(r.values.clone());
                push_keys.push(r.key.clone());
            }
            Some(remote) if **remote != r.values => conflicts += 1,
            Some(_) => {}
        }
    }
    let pushed = client.append_rows("History", push_rows).await.map_err(e)?;

    // 시트에만 있는 것 → 로컬로 내린다.
    let stamp = now();
    let mut pulled = 0usize;
    {
        let conn = state.db.0.lock().unwrap();
        db::mark_synced(&conn, &push_keys).map_err(e)?;
        for (key, row) in &sheet_map {
            if !local_keys.contains(key) {
                db::upsert_record(&conn, key, row, true, &stamp).map_err(e)?;
                pulled += 1;
            }
        }
        db::set_setting(&conn, "records_synced_at", &stamp).map_err(e)?;
    }

    Ok(serde_json::json!({
        "pushed": pushed, "pulled": pulled, "conflicts": conflicts,
        "dropped": dropped, "syncedAt": stamp
    }))
}

/// 시트 헤더가 지금 형식과 다르면 그대로 붙이면 안 된다.
fn bail_sync(sheet: &[String], expected: &[String]) -> Result<(), String> {
    Err(format!(
        "시트의 History 탭이 지금 형식과 다릅니다.\n\n시트: {}\n지금: {}\n\n         '보관 초기화' 로 탭을 다시 쓴 뒤 동기화해 주세요.",
        sheet.join(", "),
        expected.join(", ")
    ))
}

/// History 탭을 지금 로컬 내용으로 통째로 다시 쓴다.
///
/// 형식이 바뀌어 컬럼이 어긋났거나 같은 기록이 중복으로 쌓였을 때 쓴다.
#[tauri::command]
async fn rewrite_archive(
    state: State<'_, AppState>,
    header: Vec<String>,
) -> Result<serde_json::Value, String> {
    let (client, _) = connect(&state).await?;

    let (local, dropped) = {
        let conn = state.db.0.lock().unwrap();
        let dropped = db::purge_mismatched_records(&conn, header.len()).map_err(e)?;
        (db::list_records(&conn).map_err(e)?, dropped)
    };

    let mut rows = vec![header.clone()];
    rows.extend(local.iter().map(|r| r.values.clone()));
    client.write_tab("History", rows).await.map_err(e)?;

    {
        let conn = state.db.0.lock().unwrap();
        let keys: Vec<String> = local.iter().map(|r| r.key.clone()).collect();
        db::mark_synced(&conn, &keys).map_err(e)?;
        db::set_setting(&conn, "records_synced_at", &now()).map_err(e)?;
    }

    Ok(serde_json::json!({ "written": local.len(), "dropped": dropped }))
}

/// Records 탭 전체를 읽어온다 (과거 내역 조회용).
#[tauri::command]
async fn read_records(state: State<'_, AppState>) -> Result<Vec<Vec<String>>, String> {
    let (client, _) = connect(&state).await?;
    client.read_tab("History").await.map_err(e)
}

// ── setup ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
            let db = db::Db::open(&data_dir.join("invoice-extractor.db"))?;
            // 지난번 실행이 추출 도중 꺼졌다면 그 작업들은 영원히 '진행 중'으로 남는다.
            // 프로세스는 이미 죽었으므로 중단됨으로 표시해 사용자가 알 수 있게 한다.
            {
                let conn = db.0.lock().unwrap();
                let n = db::mark_stale_jobs_interrupted(&conn)?;
                if n > 0 {
                    eprintln!("이전 실행에서 중단된 작업 {n}건을 정리했습니다.");
                }
            }

            app.manage(AppState {
                db,
                data_dir,
                key_cache: std::sync::Mutex::new(None),
                running: std::sync::Arc::new(claude::Running::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            claude_status,
            stage_pages,
            run_extraction,
            create_job,
            set_job_status,
            save_job_payload,
            list_jobs,
            delete_job,
            save_prompt,
            list_prompts,
            delete_prompt,
            get_setting,
            set_setting,
            data_dir,
            save_file_as,
            chunk_results,
            unfinished_jobs,
            store_pdf,
            read_pdf,
            page_image,
            has_page_images,
            storage_stats,
            clear_page_images,
            clear_claude_sessions,
            purge_jobs_before,
            save_service_account_key,
            service_account_email,
            clear_service_account_key,
            test_sheet_connection,
            sync_master,
            cached_master,
            init_master_sheet,
            append_vendor,
            restore_master_tab,
            save_records_local,
            list_records_local,
            delete_record_local,
            sync_records,
            rewrite_archive,
            read_records,
        ])
        .build(tauri::generate_context!())
        .expect("앱 실행에 실패했습니다")
        .run(|app, event| {
            // 앱이 닫힐 때 돌고 있던 claude 프로세스를 정리한다.
            // 그냥 두면 화면은 사라졌는데 백그라운드에서 계속 돌면서 API 를 쓴다.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    let n = state.running.kill_all();
                    if n > 0 {
                        eprintln!("진행 중이던 claude 프로세스 {n}건을 종료했습니다.");
                    }
                    if let Ok(conn) = state.db.0.lock() {
                        let _ = db::mark_stale_jobs_interrupted(&conn);
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &std::path::Path, bytes: usize) {
        std::fs::write(p, vec![b'x'; bytes]).unwrap();
    }

    #[test]
    fn clears_only_page_images_and_reports_freed_bytes() {
        let root = std::env::temp_dir().join(format!("ie-test-{}", uuid::Uuid::new_v4()));
        let job_a = root.join("jobA");
        let job_b = root.join("jobB");
        std::fs::create_dir_all(&job_a).unwrap();
        std::fs::create_dir_all(&job_b).unwrap();

        write(&job_a.join("page01.png"), 1000);
        write(&job_a.join("page02.png"), 500);
        write(&job_a.join("extracted.json"), 42); // 결과 파일은 남아야 한다
        write(&job_b.join("page01.png"), 300);

        // 특정 작업만 비우기
        let freed = clear_images_in(&root, Some("jobA"));
        assert_eq!(freed, 1500);
        assert!(!job_a.join("page01.png").exists());
        assert!(job_a.join("extracted.json").exists(), "추출 결과는 지우면 안 된다");
        assert!(job_b.join("page01.png").exists(), "다른 작업은 건드리면 안 된다");

        // 전체 비우기 — 이미지가 없어 빈 폴더가 된 jobB 는 폴더까지 정리된다
        let freed_all = clear_images_in(&root, None);
        assert_eq!(freed_all, 300);
        assert!(!job_b.exists(), "빈 작업 폴더는 정리되어야 한다");
        assert!(job_a.exists(), "남은 파일이 있는 폴더는 유지되어야 한다");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dir_size_counts_nested_files() {
        let root = std::env::temp_dir().join(format!("ie-size-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        write(&root.join("a.bin"), 100);
        write(&root.join("sub/b.bin"), 250);
        assert_eq!(dir_size(&root), 350);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn record_key_uses_date_invoice_buyer() {
        let header: Vec<String> = ["date", "invoiceno", "amt", "buyer"]
            .iter().map(|s| s.to_string()).collect();
        let row: Vec<String> = ["08/15/2026", "3040-13", "457.98", "IFO"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(record_key(&row, &header), "08/15/2026\u{1}3040-13\u{1}IFO");

        // 컬럼 순서가 바뀌어도 헤더 이름으로 찾으므로 같은 키가 나와야 한다
        let header2: Vec<String> = ["buyer", "amt", "date", "invoiceno"]
            .iter().map(|s| s.to_string()).collect();
        let row2: Vec<String> = ["IFO", "457.98", "08/15/2026", "3040-13"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(record_key(&row2, &header2), record_key(&row, &header));
    }
}
