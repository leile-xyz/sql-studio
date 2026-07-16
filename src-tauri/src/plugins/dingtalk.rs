use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

const CREDENTIAL_ACCOUNT: &str = "plugin:dingtalk:default";
const DINGTALK_HOST: &str = "oapi.dingtalk.com";
const DINGTALK_PATH: &str = "/robot/send";
const REQUEST_TIMEOUT_SECONDS: u64 = 15;
const MAX_MESSAGE_LENGTH: usize = 20_000;

#[derive(Deserialize, Serialize)]
struct Credentials {
    webhook: String,
    secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStatus {
    configured: bool,
    masked_webhook: String,
}

#[derive(Deserialize)]
struct DingTalkResponse {
    errcode: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DingTalkMessage {
    pub format: String,
    pub title: String,
    pub body: String,
    pub at_all: bool,
    pub at_mobiles: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DingTalkReceipt {
    pub http_status: u16,
    pub errcode: i64,
    pub message_type: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DispatchFailureKind {
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DispatchFailure {
    pub kind: DispatchFailureKind,
    pub code: &'static str,
    pub safe_message: String,
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(super::super::KEYRING_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|e| e.to_string())
}

fn validate_webhook(webhook: &str) -> Result<Url, String> {
    let url = Url::parse(webhook).map_err(|_| "Webhook 地址格式无效".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some(DINGTALK_HOST) {
        return Err("Webhook 必须使用钉钉官方 HTTPS 地址".into());
    }
    if url.path() != DINGTALK_PATH
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Webhook 地址路径或端口无效".into());
    }
    let tokens = url
        .query_pairs()
        .filter(|(key, value)| key == "access_token" && !value.is_empty())
        .count();
    if url.fragment().is_some() || tokens != 1 {
        return Err("Webhook 缺少有效的 access_token".into());
    }
    Ok(url)
}

fn signed_url(webhook: &str, secret: &str, timestamp: i64) -> Result<Url, String> {
    let mut url = validate_webhook(webhook)?;
    let input = format!("{timestamp}\n{secret}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "加签密钥无效".to_string())?;
    mac.update(input.as_bytes());
    let signature = STANDARD.encode(mac.finalize().into_bytes());
    let retained: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "timestamp" && key != "sign")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    let mut query = url.query_pairs_mut();
    query
        .extend_pairs(retained)
        .append_pair("timestamp", &timestamp.to_string())
        .append_pair("sign", &signature);
    drop(query);
    Ok(url)
}

fn load_credentials() -> Result<Option<Credentials>, String> {
    let value = match credential_entry()?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(format!("读取钉钉插件凭据失败：{e}")),
    };
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|_| "钉钉插件凭据格式无效，请重新配置".into())
}

pub fn is_configured() -> Result<bool, String> {
    Ok(load_credentials()?.is_some())
}

fn mask_webhook(webhook: &str) -> String {
    validate_webhook(webhook)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "access_token")
                .map(|(_, value)| value.into_owned())
        })
        .map(|token| {
            let suffix: String = token
                .chars()
                .rev()
                .take(4)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            format!("https://{DINGTALK_HOST}{DINGTALK_PATH}?access_token=***{suffix}")
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn dingtalk_config_status() -> Result<ConfigStatus, String> {
    let credentials = load_credentials()?;
    Ok(ConfigStatus {
        configured: credentials.is_some(),
        masked_webhook: credentials
            .as_ref()
            .map(|c| mask_webhook(&c.webhook))
            .unwrap_or_default(),
    })
}

#[tauri::command]
pub fn dingtalk_save_config(webhook: String, secret: String) -> Result<(), String> {
    validate_webhook(webhook.trim())?;
    if secret.trim().is_empty() {
        return Err("加签密钥不能为空".into());
    }
    let value = serde_json::to_string(&Credentials {
        webhook: webhook.trim().into(),
        secret: secret.trim().into(),
    })
    .map_err(|e| e.to_string())?;
    credential_entry()?
        .set_password(&value)
        .map_err(|e| format!("保存钉钉插件凭据失败：{e}"))
}

#[tauri::command]
pub fn dingtalk_delete_config() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除钉钉插件凭据失败：{e}")),
    }
}

#[tauri::command]
pub async fn dingtalk_send_text(content: String) -> Result<(), String> {
    let message = DingTalkMessage {
        format: "text".into(),
        title: String::new(),
        body: content,
        at_all: false,
        at_mobiles: Vec::new(),
    };
    send_message(&message)
        .await
        .map(|_| ())
        .map_err(|failure| failure.safe_message)
}

pub(crate) async fn send_message(
    message: &DingTalkMessage,
) -> Result<DingTalkReceipt, DispatchFailure> {
    validate_message(message)?;
    let credentials = load_credentials()
        .map_err(|_| failed("DINGTALK_CREDENTIAL_READ_FAILED", "读取钉钉插件凭据失败"))?
        .ok_or_else(|| failed("DINGTALK_NOT_CONFIGURED", "钉钉机器人尚未配置"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| failed("SYSTEM_TIME_INVALID", "系统时间无效"))?
        .as_millis() as i64;
    let url = signed_url(&credentials.webhook, &credentials.secret, timestamp)
        .map_err(|_| failed("DINGTALK_SIGN_FAILED", "钉钉请求加签失败"))?;
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|_| failed("DINGTALK_CLIENT_FAILED", "创建钉钉请求客户端失败"))?;
    let payload = message_payload(message);
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|_| interrupted("钉钉请求发送结果未知"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| interrupted("钉钉响应无法确认，发送结果未知"))?;
    let result: DingTalkResponse =
        serde_json::from_value(body).map_err(|_| interrupted("钉钉响应无法确认，发送结果未知"))?;
    if !status.is_success() || result.errcode != 0 {
        return Err(failed(
            "DINGTALK_REJECTED",
            &format!(
                "钉钉明确拒绝请求（HTTP {}，errcode={}）",
                status.as_u16(),
                result.errcode
            ),
        ));
    }
    Ok(DingTalkReceipt {
        http_status: status.as_u16(),
        errcode: result.errcode,
        message_type: message.format.clone(),
    })
}

fn validate_message(message: &DingTalkMessage) -> Result<(), DispatchFailure> {
    let content_length = message.title.chars().count() + message.body.chars().count();
    if message.body.trim().is_empty() || content_length > MAX_MESSAGE_LENGTH {
        return Err(failed(
            "DINGTALK_MESSAGE_INVALID",
            "消息正文不能为空且标题与正文合计不能超过 20000 个字符",
        ));
    }
    if !matches!(message.format.as_str(), "text" | "markdown") {
        return Err(failed("DINGTALK_FORMAT_INVALID", "钉钉消息格式无效"));
    }
    Ok(())
}

fn message_payload(message: &DingTalkMessage) -> Value {
    let at = json!({
        "atMobiles": message.at_mobiles,
        "atUserIds": [],
        "isAtAll": message.at_all
    });
    if message.format == "markdown" {
        return json!({
            "msgtype": "markdown",
            "markdown": { "title": message.title, "text": message.body },
            "at": at
        });
    }
    let content = if message.title.trim().is_empty() {
        message.body.clone()
    } else {
        format!("{}\n{}", message.title, message.body)
    };
    json!({ "msgtype": "text", "text": { "content": content }, "at": at })
}

fn failed(code: &'static str, message: &str) -> DispatchFailure {
    DispatchFailure {
        kind: DispatchFailureKind::Failed,
        code,
        safe_message: message.into(),
    }
}

fn interrupted(message: &str) -> DispatchFailure {
    DispatchFailure {
        kind: DispatchFailureKind::Interrupted,
        code: "DINGTALK_RESULT_UNKNOWN",
        safe_message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_expected_signature() {
        let url = signed_url(
            "https://oapi.dingtalk.com/robot/send?access_token=test",
            "SECxxx",
            1_592_571_575_188,
        )
        .unwrap();
        assert_eq!(
            url.query_pairs().find(|(key, _)| key == "sign").unwrap().1,
            "ZtnS58FTx6yvY2Sj4faWZMA7e5sSmcvSui5AfdrfeqM="
        );
    }

    #[test]
    fn rejects_untrusted_webhooks() {
        assert!(validate_webhook("http://oapi.dingtalk.com/robot/send?access_token=x").is_err());
        assert!(validate_webhook("https://evil.example/robot/send?access_token=x").is_err());
        assert!(validate_webhook("https://oapi.dingtalk.com/other?access_token=x").is_err());
        assert!(validate_webhook(
            "https://oapi.dingtalk.com/robot/send?access_token=x&access_token=y"
        )
        .is_err());
    }

    #[test]
    fn replaces_existing_signature_parameters() {
        let url = signed_url(
            "https://oapi.dingtalk.com/robot/send?access_token=test&timestamp=old&sign=old",
            "SECxxx",
            1_592_571_575_188,
        )
        .unwrap();
        assert_eq!(
            url.query_pairs()
                .filter(|(key, _)| key == "timestamp")
                .count(),
            1
        );
        assert_eq!(
            url.query_pairs().filter(|(key, _)| key == "sign").count(),
            1
        );
    }

    #[test]
    fn builds_text_and_markdown_payloads_without_credentials() {
        let text = message_payload(&DingTalkMessage {
            format: "text".into(),
            title: "日报".into(),
            body: "完成".into(),
            at_all: false,
            at_mobiles: vec!["13800138000".into()],
        });
        assert_eq!(text["text"]["content"], "日报\n完成");
        assert!(text.to_string().find("access_token").is_none());

        let markdown = message_payload(&DingTalkMessage {
            format: "markdown".into(),
            title: "日报".into(),
            body: "# 完成".into(),
            at_all: true,
            at_mobiles: Vec::new(),
        });
        assert_eq!(markdown["msgtype"], "markdown");
        assert_eq!(markdown["at"]["isAtAll"], true);
    }
}
