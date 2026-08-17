//! 구글시트를 마스터 데이터 저장소로 쓰기 위한 최소 클라이언트.
//!
//! 서비스 계정 JSON 키로 JWT 를 만들어 액세스 토큰을 받고, Sheets API v4 를 직접 호출한다.
//! 사용자 로그인(OAuth 동의 흐름)은 없다 — 시트를 서비스 계정 이메일로 공유하기만 하면 된다.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

const SCOPE: &str = "https://www.googleapis.com/auth/spreadsheets";

#[derive(Debug, Deserialize)]
pub struct ServiceAccountKey {
    pub client_email: String,
    pub private_key: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

impl ServiceAccountKey {
    pub fn parse(json: &str) -> Result<Self> {
        let key: Self = serde_json::from_str(json)
            .context("서비스 계정 키 파일을 읽지 못했습니다. 구글 클라우드에서 받은 JSON 키가 맞는지 확인해 주세요.")?;
        if !key.private_key.contains("PRIVATE KEY") {
            bail!("키 파일에 private_key 가 없습니다. OAuth 클라이언트 JSON 이 아니라 '서비스 계정' 키인지 확인해 주세요.");
        }
        Ok(key)
    }
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    exp: i64,
    iat: i64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

async fn access_token(key: &ServiceAccountKey) -> Result<String> {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        iss: &key.client_email,
        scope: SCOPE,
        aud: &key.token_uri,
        exp: now + 3600,
        iat: now,
    };

    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    let enc = jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes())
        .context("private_key 형식이 올바르지 않습니다.")?;
    let assertion = jsonwebtoken::encode(&header, &claims, &enc)?;

    let res = reqwest::Client::new()
        .post(&key.token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &assertion),
        ])
        .send()
        .await
        .context("구글 토큰 서버에 접속하지 못했습니다. 네트워크를 확인해 주세요.")?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("액세스 토큰 발급 실패({status}): {body}");
    }

    let token: TokenResponse = serde_json::from_str(&body)
        .context("토큰 응답을 해석하지 못했습니다.")?;
    Ok(token.access_token)
}

/// 시트 URL 또는 ID 문자열에서 스프레드시트 ID 만 뽑아낸다.
pub fn extract_sheet_id(url_or_id: &str) -> Result<String> {
    let s = url_or_id.trim();
    if let Some(rest) = s.split("/spreadsheets/d/").nth(1) {
        let id = rest.split('/').next().unwrap_or("").split('?').next().unwrap_or("");
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    // 이미 ID 만 들어온 경우
    if !s.is_empty() && !s.contains('/') && s.len() > 20 {
        return Ok(s.to_string());
    }
    bail!("시트 URL 에서 ID 를 찾지 못했습니다: {s}")
}

pub struct SheetsClient {
    token: String,
    sheet_id: String,
}

#[derive(Debug, Serialize)]
pub struct SheetInfo {
    pub title: String,
    pub tabs: Vec<String>,
    pub client_email: String,
}

impl SheetsClient {
    pub async fn connect(key: &ServiceAccountKey, sheet_url: &str) -> Result<Self> {
        Ok(Self {
            token: access_token(key).await?,
            sheet_id: extract_sheet_id(sheet_url)?,
        })
    }

    async fn get(&self, path: &str) -> Result<serde_json::Value> {
        let url = format!("https://sheets.googleapis.com/v4/spreadsheets/{}{}", self.sheet_id, path);
        let res = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&self.token)
            .send()
            .await
            .context("구글시트에 접속하지 못했습니다.")?;
        self.handle(res).await
    }

    async fn post(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let url = format!("https://sheets.googleapis.com/v4/spreadsheets/{}{}", self.sheet_id, path);
        let res = reqwest::Client::new()
            .post(&url)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .context("구글시트에 접속하지 못했습니다.")?;
        self.handle(res).await
    }

    async fn put(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        let url = format!("https://sheets.googleapis.com/v4/spreadsheets/{}{}", self.sheet_id, path);
        let res = reqwest::Client::new()
            .put(&url)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .context("구글시트에 접속하지 못했습니다.")?;
        self.handle(res).await
    }

    async fn handle(&self, res: reqwest::Response) -> Result<serde_json::Value> {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND {
            // 가장 흔한 실수라 따로 안내한다.
            bail!(
                "시트에 접근할 수 없습니다({status}). 구글시트 '공유'에서 서비스 계정 이메일을 \
                 편집자로 추가했는지 확인해 주세요."
            );
        }
        if !status.is_success() {
            bail!("구글시트 API 오류({status}): {body}");
        }
        serde_json::from_str(&body).context("구글시트 응답을 해석하지 못했습니다.")
    }

    pub async fn info(&self, client_email: &str) -> Result<SheetInfo> {
        let v = self.get("?fields=properties.title,sheets.properties.title").await?;
        let title = v["properties"]["title"].as_str().unwrap_or("").to_string();
        let tabs = v["sheets"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s["properties"]["title"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        Ok(SheetInfo { title, tabs, client_email: client_email.to_string() })
    }

    /// 탭 하나를 통째로 읽어 문자열 2차원 배열로 돌려준다.
    pub async fn read_tab(&self, tab: &str) -> Result<Vec<Vec<String>>> {
        let v = self.get(&format!("/values/{}", urlencode(tab))).await?;
        Ok(v["values"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        r.as_array()
                            .map(|c| c.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// 탭을 통째로 덮어쓴다. 없으면 만든다.
    pub async fn write_tab(&self, tab: &str, rows: Vec<Vec<String>>) -> Result<()> {
        self.ensure_tab(tab).await?;
        self.post(&format!("/values/{}:clear", urlencode(tab)), serde_json::json!({})).await?;
        self.put(
            &format!("/values/{}?valueInputOption=RAW", urlencode(tab)),
            serde_json::json!({ "values": rows }),
        )
        .await?;
        Ok(())
    }

    /// 탭 끝에 행을 덧붙인다.
    ///
    /// write_tab 과 달리 기존 내용을 지우지 않는다. 장부처럼 계속 쌓이는 데이터는
    /// 반드시 이쪽을 써야 한다 — 지우고 다시 쓰는 방식은 중간에 끊기면 내역이 통째로 날아간다.
    pub async fn append_rows(&self, tab: &str, rows: Vec<Vec<String>>) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        self.ensure_tab(tab).await?;
        let n = rows.len();
        self.post(
            &format!(
                "/values/{}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
                urlencode(tab)
            ),
            serde_json::json!({ "values": rows }),
        )
        .await?;
        Ok(n)
    }

    pub async fn tab_exists(&self, tab: &str) -> Result<bool> {
        let v = self.get("?fields=sheets.properties.title").await?;
        Ok(v["sheets"]
            .as_array()
            .map(|a| a.iter().any(|s| s["properties"]["title"].as_str() == Some(tab)))
            .unwrap_or(false))
    }

    async fn ensure_tab(&self, tab: &str) -> Result<()> {
        let v = self.get("?fields=sheets.properties.title").await?;
        let exists = v["sheets"]
            .as_array()
            .map(|a| a.iter().any(|s| s["properties"]["title"].as_str() == Some(tab)))
            .unwrap_or(false);
        if exists {
            return Ok(());
        }
        self.post(
            ":batchUpdate",
            serde_json::json!({
                "requests": [{ "addSheet": { "properties": { "title": tab } } }]
            }),
        )
        .await?;
        Ok(())
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// 키 파일에서 서비스 계정 이메일만 뽑는다 (UI 안내용).
pub fn client_email_of(json: &str) -> Result<String> {
    ServiceAccountKey::parse(json).map(|k| k.client_email).map_err(|e| anyhow!(e))
}
