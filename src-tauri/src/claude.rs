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

/// 실패했을 때 왜 실패했는지 알아내기 위해 스트림에서 모아 두는 것들.
///
/// stderr 만 보고 있으면 claude 가 정상 종료한 실패(예: 파일 쓰기 거부)를
/// 전혀 알 수 없다. 실제 사유는 stdout 이벤트에 들어 있다.
#[derive(Default)]
struct Diagnostics {
    /// 도구 사용이 거부된 경우 (도구 이름, 사유)
    denials: Vec<(String, String)>,
    /// claude 가 마지막으로 한 말
    last_text: String,
    /// 종료 결과 (subtype)
    result: Option<String>,
    /// claude 의 최종 응답. 여기에 추출 결과 JSON 이 들어 있다.
    final_text: String,
}

/// 모델 응답에서 JSON 부분만 꺼낸다.
///
/// 앞뒤에 설명을 붙이거나 ```json 으로 감싸는 경우가 있어 그대로 파싱하면 실패한다.
fn extract_json(text: &str) -> Option<String> {
    let t = text.trim();
    if t.starts_with('{') && t.ends_with('}') {
        return Some(t.to_string());
    }
    // 코드펜스 안이나 설명 뒤에 붙은 경우 가장 바깥 중괄호 범위를 찾는다.
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    if end > start {
        Some(t[start..=end].to_string())
    } else {
        None
    }
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

/// claude 가 그 작업 폴더의 대화 기록을 남기는 위치.
///
/// `~/.claude/projects/<경로를 -로 바꾼 이름>` 에 쌓인다. 우리는 추출 결과만 필요하고
/// 대화 기록은 볼 일이 없는데, 작업 한 건에 수십 MB 씩 쌓여 디스크를 잡아먹는다.
fn session_dir(workdir: &Path) -> Option<PathBuf> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()?;
    let encoded: String = workdir
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    Some(PathBuf::from(home).join(".claude/projects").join(encoded))
}

/// 추출이 끝난 뒤 그 작업의 대화 기록을 지운다. 지운 바이트 수를 돌려준다.
pub fn cleanup_session(workdir: &Path) -> u64 {
    let Some(dir) = session_dir(workdir) else { return 0 };
    if !dir.is_dir() {
        return 0;
    }
    let size = std::fs::read_dir(&dir)
        .map(|d| d.flatten().filter_map(|f| f.metadata().ok()).map(|m| m.len()).sum())
        .unwrap_or(0);
    let _ = std::fs::remove_dir_all(&dir);
    size
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
        // 결과는 응답으로 받는 것이 정본이다. PC 에 따라 Claude Code 의 안전 검사가
        // 파일 쓰기를 거부해(safetyCheck) 추출이 통째로 실패한 적이 있다.
        //
        // 다만 쓰기도 함께 허용한다. 앱이 강제 종료되면 응답을 받아 갈 주체가 없어
        // 결과가 사라지는데, 파일이 남아 있으면 다시 켤 때 되살릴 수 있다.
        // 쓰기가 거부돼도 응답이 있으므로 추출은 성공한다.
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
    let diag = std::sync::Arc::new(std::sync::Mutex::new(Diagnostics::default()));
    let diag_w = diag.clone();
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

            // 실패 원인이 될 만한 것들을 모아 둔다.
            match ev["type"].as_str() {
                Some("system") if ev["subtype"] == "permission_denied" => {
                    let tool = ev["tool_name"].as_str().unwrap_or("?").to_string();
                    let why = ev["decision_reason_type"]
                        .as_str()
                        .or_else(|| ev["reason"].as_str())
                        .unwrap_or("사유 없음")
                        .to_string();
                    diag_w.lock().unwrap().denials.push((tool, why));
                }
                Some("result") => {
                    let mut d = diag_w.lock().unwrap();
                    d.result = Some(ev["subtype"].as_str().unwrap_or("").to_string());
                    // 최종 응답이 곧 추출 결과다.
                    if let Some(t) = ev["result"].as_str() {
                        d.final_text = t.to_string();
                    }
                }
                _ => {}
            }

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
                                    diag_w.lock().unwrap().last_text =
                                        t.chars().take(600).collect();
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

    let d = diag.lock().unwrap();

    // 응답으로 받은 JSON 을 먼저 쓴다. 파일은 예전 방식과의 호환용 대비책이다.
    if let Some(json) = extract_json(&d.final_text) {
        if serde_json::from_str::<serde_json::Value>(&json).is_ok() {
            return Ok(RunOutcome {
                extracted_json: json,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
    }

    if !out_path.is_file() {
        let mut msg = String::from("추출 결과 파일이 만들어지지 않았습니다.\n");

        if !d.denials.is_empty() {
            msg.push_str("\n원인: Claude Code 가 도구 사용을 거부당했습니다.\n");
            for (tool, why) in &d.denials {
                msg.push_str(&format!("  · {tool} 거부됨 ({why})\n"));
            }
            msg.push_str(
                "\n그 PC 의 Claude Code 권한 설정 때문입니다. 터미널에서 아래를 실행해\n                 한 번 허용해 두면 해결됩니다:\n                 \n  claude --version\n                 \n그래도 안 되면 ~/.claude/settings.json 의 permissions 설정을 확인해 주세요.\n",
            );
        } else if !d.final_text.is_empty() {
            msg.push_str(&format!(
                "\nClaude Code 의 응답에서 JSON 을 찾지 못했습니다:\n{}\n",
                d.final_text.chars().take(600).collect::<String>()
            ));
        } else if !d.last_text.is_empty() {
            msg.push_str(&format!("\nClaude Code 의 마지막 응답:\n{}\n", d.last_text));
        }

        if let Some(r) = &d.result {
            if r != "success" {
                msg.push_str(&format!("\n종료 상태: {r}\n"));
            }
        }

        if !stderr.trim().is_empty() {
            msg.push_str(&format!(
                "\nstderr:\n{}",
                stderr.chars().take(1500).collect::<String>()
            ));
        }

        return Err(anyhow!(msg));
    }

    Ok(RunOutcome {
        extracted_json: std::fs::read_to_string(&out_path)?,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// 로그인까지 확인한 결과.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub path: String,
    pub version: String,
    /// 실제로 요청이 통했는지. false 면 설치는 됐지만 로그인이 안 된 것이다.
    pub logged_in: bool,
    pub detail: String,
}

/// 로그인 여부까지 확인한다.
///
/// `claude --version` 은 로그아웃 상태에서도 성공하므로 설치 확인용일 뿐이다.
/// 실제로 통하는지 알려면 아주 짧은 요청을 한 번 보내 보는 수밖에 없다.
pub fn check_ready(cli: &Path, timeout: Duration) -> Result<Readiness> {
    let version = health_check(cli)?;

    let mut child = std::process::Command::new(cli)
        .arg("-p")
        .arg("Reply with exactly: OK")
        // 도구도 MCP 도 쓰지 않는 최소 요청이라 비용이 거의 들지 않는다.
        .arg("--allowedTools")
        .arg("")
        .arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg("{\"mcpServers\":{}}")
        .arg("--output-format")
        .arg("json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("claude 실행 실패: {}", cli.display()))?;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait()? {
            Some(_) => break,
            None => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Ok(Readiness {
                        path: cli.display().to_string(),
                        version,
                        logged_in: false,
                        detail: "응답이 없어 확인을 중단했습니다. 네트워크를 확인해 주세요.".into(),
                    });
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }

    let out = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    let ok = serde_json::from_str::<serde_json::Value>(stdout.trim())
        .map(|v| v["is_error"] != true && v["subtype"] == "success")
        .unwrap_or(false);

    let detail = if ok {
        "요청이 정상 처리되었습니다.".to_string()
    } else {
        let raw = if stderr.trim().is_empty() { stdout } else { stderr };
        format!(
            "요청이 처리되지 않았습니다. 터미널에서 `claude` 를 실행해 로그인했는지 \
             확인해 주세요.\n{}",
            raw.trim().chars().take(400).collect::<String>()
        )
    };

    Ok(Readiness { path: cli.display().to_string(), version, logged_in: ok, detail })
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
