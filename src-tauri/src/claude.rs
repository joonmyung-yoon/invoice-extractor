//! 로컬에 설치된 claude CLI 를 일회성으로 돌려서 추출 결과를 받아온다.
//!
//! 세션이 claude.ai 에 남지 않도록 항상 `-p`(비대화 1회 실행) 로만 부른다.
//! MCP 서버는 전부 차단하고, 허용 도구도 Read/Write 로 묶어 작업 폴더 밖으로 못 나가게 한다.

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// claude 실행 파일을 찾는다. 사용자가 설정에서 직접 지정한 경로를 최우선으로 본다.
pub fn resolve_cli(configured: Option<&str>) -> Result<PathBuf> {
    if let Some(p) = configured.filter(|s| !s.trim().is_empty()) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        bail!("설정된 claude 경로가 실행 파일이 아닙니다: {}", p.display());
    }

    if let Ok(p) = which::which("claude") {
        return Ok(p);
    }

    // GUI 앱은 로그인 셸의 PATH 를 물려받지 못하는 경우가 많아서 흔한 위치를 직접 본다.
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let candidates = [
        format!("{home}/.local/bin/claude"),
        format!("{home}/.claude/local/claude"),
        "/opt/homebrew/bin/claude".into(),
        "/usr/local/bin/claude".into(),
        format!("{home}/AppData/Local/Programs/claude/claude.exe"),
    ];
    for c in candidates {
        let p = PathBuf::from(&c);
        if p.is_file() {
            return Ok(p);
        }
    }

    bail!("claude CLI 를 찾지 못했습니다. 설정에서 경로를 직접 지정해 주세요.")
}

pub struct RunOutcome {
    pub extracted_json: String,
    pub elapsed_ms: u128,
}

/// 추출 도중 화면에 보낼 진행 상황.
///
/// 예전에는 "시작"과 "완료" 두 상태뿐이라 몇 분 동안 아무것도 알 수 없었다.
/// claude 가 내보내는 작업 이벤트를 그대로 옮겨 실제로 진행 중임을 보여준다.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub job_id: String,
    /// 지금까지 읽은 페이지 수
    pub pages_read: usize,
    /// 방금 읽은 페이지 번호 (파일명에서 뽑는다)
    pub current_page: Option<usize>,
    /// 사람이 읽을 수 있는 현재 단계
    pub phase: String,
    /// 결과 파일을 쓰기 시작했는지
    pub writing: bool,
    pub elapsed_ms: u128,
}

/// 지금 돌고 있는 claude 프로세스들.
///
/// 앱을 닫으면 자식 프로세스는 자동으로 죽지 않는다. 그대로 두면 화면에는 아무것도 없는데
/// 백그라운드에서 계속 돌면서 API 를 쓰게 되므로, 종료할 때 여기 있는 것들을 정리한다.
#[derive(Default)]
pub struct Running(std::sync::Mutex<Vec<u32>>);

impl Running {
    fn add(&self, pid: u32) {
        self.0.lock().unwrap().push(pid);
    }

    fn remove(&self, pid: u32) {
        self.0.lock().unwrap().retain(|p| *p != pid);
    }

    /// 남아 있는 프로세스를 모두 종료한다. 종료한 개수를 돌려준다.
    pub fn kill_all(&self) -> usize {
        let pids: Vec<u32> = std::mem::take(&mut *self.0.lock().unwrap());
        let n = pids.len();
        for pid in pids {
            kill_pid(pid);
        }
        n
    }
}

#[cfg(unix)]
fn kill_pid(pid: u32) {
    // SIGTERM 으로 정리할 기회를 준다.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// 파일 경로에서 pageNN 의 번호를 뽑는다.
fn page_number(path: &str) -> Option<usize> {
    let name = path.rsplit(['/', '\\']).next()?;
    let rest = name.strip_prefix("page")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// `workdir` 안에서 claude 를 돌린다. 프롬프트는 결과를 `extracted.json` 에 쓰도록 지시되어 있어야 한다.
///
/// `on_progress` 는 claude 가 작업할 때마다 호출된다.
pub fn run_extraction(
    cli: &Path,
    workdir: &Path,
    prompt: &str,
    timeout: Duration,
    running: &Running,
    job_id: &str,
    on_progress: impl Fn(Progress) + Send + 'static,
) -> Result<RunOutcome> {
    let out_path = workdir.join("extracted.json");
    let _ = std::fs::remove_file(&out_path);

    let started = std::time::Instant::now();

    let mut child = std::process::Command::new(cli)
        .current_dir(workdir)
        .arg("-p")
        .arg(prompt)
        // 작업 폴더 안에서 이미지 읽고 결과 쓰는 것만 허용한다.
        .arg("--allowedTools")
        .arg("Read,Write")
        .arg("--permission-mode")
        .arg("acceptEdits")
        // 사용자 환경의 MCP 서버를 끌고 들어오지 않는다 (외부 유출 차단).
        .arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg("{\"mcpServers\":{}}")
        // 작업 이벤트를 한 줄에 하나씩 받아 진행 상황을 알아낸다.
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("claude 실행 실패: {}", cli.display()))?;

    let pid = child.id();
    running.add(pid);

    // stdout 을 별도 스레드에서 읽는다. 파이프가 가득 차면 claude 가 멈추므로
    // 프로세스를 기다리는 동안에도 계속 비워 줘야 한다.
    let stdout = child.stdout.take().expect("stdout 파이프");
    let job = job_id.to_string();
    let reader = std::thread::spawn(move || {
        let mut pages_read = 0usize;
        let mut seen = std::collections::HashSet::new();
        let mut writing = false;
        let mut last_text = String::new();

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };

            let mut changed = false;
            let mut current_page = None;

            if ev["type"] == "assistant" {
                if let Some(content) = ev["message"]["content"].as_array() {
                    for c in content {
                        match c["type"].as_str() {
                            Some("tool_use") => {
                                let name = c["name"].as_str().unwrap_or("");
                                let path = c["input"]["file_path"].as_str().unwrap_or("");
                                if name == "Read" {
                                    if let Some(n) = page_number(path) {
                                        // 같은 페이지를 다시 읽는 경우는 세지 않는다.
                                        if seen.insert(n) {
                                            pages_read += 1;
                                            current_page = Some(n);
                                            changed = true;
                                        }
                                    }
                                } else if name == "Write" && path.ends_with("extracted.json") {
                                    writing = true;
                                    changed = true;
                                }
                            }
                            Some("text") => {
                                let t = c["text"].as_str().unwrap_or("").trim();
                                if !t.is_empty() {
                                    last_text = t.chars().take(80).collect();
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }

            if changed {
                let phase = if writing {
                    "결과 정리 중".to_string()
                } else if pages_read > 0 {
                    format!("페이지 {pages_read}장 확인함")
                } else {
                    last_text.clone()
                };
                on_progress(Progress {
                    job_id: job.clone(),
                    pages_read,
                    current_page,
                    phase,
                    writing,
                    elapsed_ms: started.elapsed().as_millis(),
                });
            }
        }
    });

    // 무한정 매달리지 않도록 폴링하며 기다린다.
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    running.remove(pid);
                    bail!("추출이 제한 시간({}초)을 넘겨 중단했습니다.", timeout.as_secs());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(err) => {
                running.remove(pid);
                return Err(err).context("claude 프로세스 상태를 확인하지 못했습니다.");
            }
        }
    }
    running.remove(pid);
    let _ = reader.join();

    let mut stderr = String::new();
    if let Some(mut e) = child.stderr.take() {
        use std::io::Read;
        let _ = e.read_to_string(&mut stderr);
    }

    if !out_path.is_file() {
        return Err(anyhow!(
            "extracted.json 이 생성되지 않았습니다.\nstderr: {}",
            stderr.chars().take(2000).collect::<String>()
        ));
    }

    Ok(RunOutcome {
        extracted_json: std::fs::read_to_string(&out_path)?,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// claude 가 로그인되어 있는지 가볍게 확인한다.
pub fn health_check(cli: &Path) -> Result<String> {
    let output = std::process::Command::new(cli)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("claude 실행 실패: {}", cli.display()))?;

    if !output.status.success() {
        bail!("claude --version 이 실패했습니다: {}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::page_number;

    #[test]
    fn extracts_page_numbers_from_paths() {
        assert_eq!(page_number("/tmp/job/page07.png"), Some(7));
        assert_eq!(page_number(r"C:\jobs\x\page19.png"), Some(19));
        assert_eq!(page_number("/tmp/job/extracted.json"), None);
        assert_eq!(page_number("/tmp/page.png"), None);
    }
}
