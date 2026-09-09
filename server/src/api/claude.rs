//! Handles standard Anthropic Messages protocol endpoints for Claude Code CLI and Desktop.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{HeaderMap, Request, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::Value;

use crate::{
    network::NetworkClients,
    store::Store,
    Error, Result,
};

#[derive(Clone)]
pub struct ClaudeGatewayContext {
    pub store: Store,
    pub clients: NetworkClients,
}

pub fn router(store: Store, clients: NetworkClients) -> Router {
    let ctx = ClaudeGatewayContext { store, clients };
    Router::new()
        .route("/v1/messages", post(handle_messages))
        .route("/v1/models", get(handle_models))
        .with_state(ctx)
}

#[derive(Serialize)]
struct ModelListItem {
    id: String,
    object: &'static str,
    created: u64,
    owned_by: &'static str,
    display_name: String,
}

#[derive(Serialize)]
struct ModelListResponse {
    object: &'static str,
    data: Vec<ModelListItem>,
}

async fn handle_models(
    State(ctx): State<ClaudeGatewayContext>,
) -> Result<Json<ModelListResponse>> {
    let models = ctx.store.models().await?;
    let data = models
        .into_iter()
        .map(|m| ModelListItem {
            id: m.model_id.clone(),
            object: "model",
            created: m.created_at_ms / 1000,
            owned_by: "cursor-byok",
            display_name: m.display_name,
        })
        .collect();

    Ok(Json(ModelListResponse {
        object: "list",
        data,
    }))
}

async fn handle_messages(
    State(ctx): State<ClaudeGatewayContext>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let body_bytes = to_bytes(request.into_body(), 20 * 1024 * 1024)
        .await
        .map_err(|e| Error::Protocol(format!("failed to read request body: {e}")))?;

    let json_body: Value = serde_json::from_slice(&body_bytes)
        .map_err(|e| Error::Protocol(format!("invalid json body: {e}")))?;

    let requested_model = json_body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // 尝试在本地配置中匹配模型
    let models = ctx.store.models().await?;
    let target_model = models
        .iter()
        .find(|m| m.model_id == requested_model || m.model_hash == requested_model)
        .or_else(|| models.first());

    let (upstream_url, api_key, custom_headers) = if let Some(cfg) = target_model {
        let url = cfg.request_url()?;
        (url, cfg.api_key.clone(), cfg.custom_headers.clone())
    } else {
        let client_key = headers
            .get("x-api-key")
            .and_then(|h| h.to_str().ok())
            .unwrap_or_default()
            .to_string();
        (
            "https://api.anthropic.com/v1/messages".to_string(),
            client_key,
            std::collections::BTreeMap::new(),
        )
    };

    let client = ctx.clients.provider_client(std::time::Duration::from_secs(600)).await?;
    let mut upstream_req = client.post(&upstream_url);

    // 传递客户端与协议相关的 Header
    for (k, v) in headers.iter() {
        let name = k.as_str();
        if name.starts_with("anthropic-") || name == "content-type" {
            upstream_req = upstream_req.header(k, v);
        }
    }
    if !api_key.is_empty() {
        upstream_req = upstream_req.header("x-api-key", api_key);
    }
    for (k, v) in custom_headers {
        upstream_req = upstream_req.header(k, v);
    }

    let upstream_resp = upstream_req
        .body(body_bytes)
        .send()
        .await
        .map_err(Error::Http)?;

    let status = upstream_resp.status();
    let mut client_resp = Response::builder().status(status);

    for (k, v) in upstream_resp.headers().iter() {
        let name = k.as_str();
        if name == "content-type" || name == "cache-control" || name.starts_with("anthropic-") {
            client_resp = client_resp.header(k, v);
        }
    }

    let stream = upstream_resp.bytes_stream();
    let body = Body::from_stream(stream);

    client_resp
        .body(body)
        .map_err(|e| Error::Protocol(e.to_string()))
}
