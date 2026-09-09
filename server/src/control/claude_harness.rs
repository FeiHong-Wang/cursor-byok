//! Implements Claude Desktop configuration takeover and 3P profile management.
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{store::Store, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClaudeDesktopStatus {
    pub enabled: bool,
    pub config_path: Option<String>,
}

pub fn claude_3p_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|p| p.join("Claude-3p"))
    }
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir().map(|p| p.join("Claude-3p"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        dirs::config_dir().map(|p| p.join("Claude-3p"))
    }
}

pub async fn get_status(service_port: u16) -> Result<ClaudeDesktopStatus> {
    let Some(dir) = claude_3p_dir() else {
        return Ok(ClaudeDesktopStatus { enabled: false, config_path: None });
    };

    let meta_path = dir.join("configLibrary").join("_meta.json");
    if !meta_path.exists() {
        return Ok(ClaudeDesktopStatus { enabled: false, config_path: None });
    }

    let meta_content = tokio::fs::read_to_string(&meta_path).await.unwrap_or_default();
    let meta: Value = serde_json::from_str(&meta_content).unwrap_or(Value::Null);
    let applied_id = meta.get("appliedId").and_then(Value::as_str).unwrap_or_default();

    if applied_id.is_empty() {
        return Ok(ClaudeDesktopStatus { enabled: false, config_path: None });
    }

    let config_file = dir.join("configLibrary").join(format!("{applied_id}.json"));
    if !config_file.exists() {
        return Ok(ClaudeDesktopStatus { enabled: false, config_path: None });
    }

    let config_content = tokio::fs::read_to_string(&config_file).await.unwrap_or_default();
    let config: Value = serde_json::from_str(&config_content).unwrap_or(Value::Null);
    let base_url = config.get("inferenceGatewayBaseUrl").and_then(Value::as_str).unwrap_or_default();

    let expected_port = format!("{service_port}");
    let enabled = base_url.contains(&expected_port);

    Ok(ClaudeDesktopStatus {
        enabled,
        config_path: Some(config_file.to_string_lossy().to_string()),
    })
}

pub async fn set_enabled(store: &Store, service_port: u16, enabled: bool) -> Result<ClaudeDesktopStatus> {
    let Some(dir) = claude_3p_dir() else {
        return Err(crate::Error::Config("Claude-3p directory not found".into()));
    };

    let library_dir = dir.join("configLibrary");
    tokio::fs::create_dir_all(&library_dir).await?;

    let profile_id = "00000000-0000-4000-8000-000000146090";
    let meta_path = library_dir.join("_meta.json");
    let config_path = library_dir.join(format!("{profile_id}.json"));

    if enabled {
        let models = store.models().await?;
        let mut inference_models = Vec::new();

        // 将助手里的模型映射为 Claude Desktop 可选的标准角色
        let default_roles = [
            ("claude-opus-4-8", "Opus"),
            ("claude-sonnet-4-6", "Sonnet"),
            ("claude-haiku-4-5", "Haiku"),
        ];

        for (idx, (role_name, display_role)) in default_roles.iter().enumerate() {
            let model_display = models.get(idx)
                .map(|m| format!("{} ({display_role})", m.display_name))
                .unwrap_or_else(|| display_role.to_string());

            inference_models.push(json!({
                "name": role_name,
                "displayName": model_display,
                "supports1m": true
            }));
        }

        let profile_content = json!({
            "inferenceProvider": "gateway",
            "inferenceGatewayBaseUrl": format!("http://127.0.0.1:{service_port}"),
            "inferenceGatewayAuthScheme": "x-api-key",
            "inferenceGatewayApiKey": "cursor-byok-local-gateway",
            "inferenceModels": inference_models,
            "modelDiscoveryEnabled": true,
            "chatTabEnabled": true,
            "coworkTabEnabled": true,
            "isClaudeCodeForDesktopEnabled": true,
            "disableDeploymentModeChooser": true
        });

        tokio::fs::write(&config_path, serde_json::to_string_pretty(&profile_content)?).await?;

        let meta_content = json!({
            "appliedId": profile_id,
            "entries": [{
                "id": profile_id,
                "name": "Cursor BYOK Gateway"
            }]
        });
        tokio::fs::write(&meta_path, serde_json::to_string_pretty(&meta_content)?).await?;

        // 写入 claude_desktop_config.json
        let root_config_path = dir.join("claude_desktop_config.json");
        let root_config = json!({ "deploymentMode": "3p" });
        tokio::fs::write(&root_config_path, serde_json::to_string_pretty(&root_config)?).await?;
    } else {
        // 关闭接管时，置空 appliedId
        let meta_content = json!({
            "appliedId": null,
            "entries": []
        });
        tokio::fs::write(&meta_path, serde_json::to_string_pretty(&meta_content)?).await?;

        let root_config_path = dir.join("claude_desktop_config.json");
        let root_config = json!({ "deploymentMode": "1p" });
        tokio::fs::write(&root_config_path, serde_json::to_string_pretty(&root_config)?).await?;
    }

    Ok(ClaudeDesktopStatus {
        enabled,
        config_path: Some(config_path.to_string_lossy().to_string()),
    })
}
