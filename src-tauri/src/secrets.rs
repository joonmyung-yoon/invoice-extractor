//! 서비스 계정 키를 OS 자격증명 저장소에 넣는다.
//! macOS 는 키체인, Windows 는 자격 증명 관리자를 쓴다. 앱 폴더에는 키를 남기지 않는다.

use anyhow::{Context, Result};

const SERVICE: &str = "invoice-extractor";
const ACCOUNT: &str = "google-service-account-key";

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).context("OS 자격증명 저장소를 열지 못했습니다.")
}

pub fn store_key(json: &str) -> Result<()> {
    // 넣기 전에 형식을 검증해서 잘못된 파일이 저장되지 않게 한다.
    crate::sheets::ServiceAccountKey::parse(json)?;
    entry()?.set_password(json).context("키 저장에 실패했습니다.")?;
    Ok(())
}

pub fn load_key() -> Result<Option<String>> {
    match entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e).context("저장된 키를 읽지 못했습니다."),
    }
}

pub fn clear_key() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e).context("키 삭제에 실패했습니다."),
    }
}
