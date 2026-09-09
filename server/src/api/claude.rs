//! Handles standard Anthropic Messages protocol endpoints for Claude Code CLI and Desktop.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{HeaderMap, Request, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;

use crate::{
    model::{NewLlmCall, ProviderType, Usage},
    network::NetworkClients,
    provider::CallRecorder,
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
            created: (m.created_at_ms / 1000).max(0) as u64,
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

    // 匹配本地模型配置
    let models = ctx.store.models().await?;
    let target_model = if requested_model.contains("opus") {
        models.iter().find(|m| m.model_id.contains("opus")).or_else(|| models.first())
    } else if requested_model.contains("sonnet") {
        models.iter().find(|m| m.model_id.contains("sonnet")).or_else(|| models.first())
    } else if requested_model.contains("haiku") {
        models.iter().find(|m| m.model_id.contains("haiku")).or_else(|| models.first())
    } else {
        models.iter().find(|m| m.model_id == requested_model || m.model_hash == requested_model).or_else(|| models.first())
    };

    let (upstream_url, api_key, custom_headers_val, model_hash, display_name, provider_type, actual_model_id) =
        if let Some(cfg) = target_model {
            let url = cfg.request_url()?;
            (
                url,
                cfg.api_key.clone(),
                cfg.custom_headers.clone(),
                cfg.model_hash.clone(),
                cfg.display_name.clone(),
                cfg.provider_type(),
                cfg.model_id.clone(),
            )
        } else {
            let client_key = headers
                .get("x-api-key")
                .and_then(|h| h.to_str().ok())
                .unwrap_or_default()
                .to_string();
            (
                "https://api.anthropic.com/v1/messages".to_string(),
                client_key,
                serde_json::json!({}),
                requested_model.to_string(),
                requested_model.to_string(),
                ProviderType::Anthropic,
                requested_model.to_string(),
            )
        };

    // 核心模型映射改写: 将 Claude 客户端发来的 claude-opus-* 等固定角色名替换为你中转站真实的 model_id
    let mut rewritten_body = json_body.clone();
    rewritten_body["model"] = serde_json::Value::String(actual_model_id);
    let final_body_bytes = serde_json::to_vec(&rewritten_body)
        .map_err(|e| Error::Protocol(format!("failed to serialize rewritten body: {e}")))?;

    let call_id = format!("claude-{}", uuid::Uuid::new_v4());
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let conversation_id = headers
        .get("x-session-id")
        .or_else(|| headers.get("conversation-id"))
        .and_then(|h| h.to_str().ok())
        .unwrap_or(&run_id)
        .to_string();

    let message_count = json_body
        .get("messages")
        .and_then(Value::as_array)
        .map(|m| m.len())
        .unwrap_or(1);
    let tool_count = json_body
        .get("tools")
        .and_then(Value::as_array)
        .map(|t| t.len())
        .unwrap_or(0);

    let new_call = NewLlmCall {
        call_id: call_id.clone(),
        run_id,
        conversation_id,
        provider_call_index: 0,
        model_hash,
        provider_type,
        provider_url: upstream_url.clone(),
        request_type: provider_type,
        request_url: upstream_url.clone(),
        model_id: requested_model.to_string(),
        display_name,
        reasoning_effort: None,
        fast: false,
        message_count,
        tool_count,
        detailed: false,
    };

    // 启动全局调用追踪记录器（让数据概览与调用详细完整可用）
    let recorder = CallRecorder::start(ctx.store.clone(), new_call).await.ok();
    if let Some(ref rec) = recorder {
        let headers_val = serde_json::to_value(
            headers
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.as_str(), s)))
                .collect::<std::collections::HashMap<_, _>>(),
        )
        .unwrap_or_default();
        let _ = rec.request(headers_val, &json_body).await;
    }

    let client = ctx.clients.provider_client(std::time::Duration::from_secs(600)).await?;
    let mut upstream_req = client.post(&upstream_url);

    for (k, v) in headers.iter() {
        let name = k.as_str();
        if name.starts_with("anthropic-") || name == "content-type" {
            upstream_req = upstream_req.header(k, v);
        }
    }
    if !api_key.is_empty() {
        upstream_req = upstream_req.header("x-api-key", api_key);
    }
    if let Some(map) = custom_headers_val.as_object() {
        for (k, v) in map {
            if let Some(val_str) = v.as_str() {
                upstream_req = upstream_req.header(k, val_str);
            }
        }
    }

    let upstream_resp = match upstream_req.body(final_body_bytes).send().await {
        Ok(resp) => resp,
        Err(err) => {
            let error = Error::Http(err);
            if let Some(ref rec) = recorder {
                let _ = rec.failed(&error).await;
            }
            return Err(error);
        }
    };

    let status = upstream_resp.status();
    if let Some(ref rec) = recorder {
        let _ = rec.response_headers(status.as_u16()).await;
    }

    let mut client_resp = Response::builder().status(status);
    for (k, v) in upstream_resp.headers().iter() {
        let name = k.as_str();
        if name == "content-type" || name == "cache-control" || name.starts_with("anthropic-") {
            client_resp = client_resp.header(k, v);
        }
    }

    let raw_stream = upstream_resp.bytes_stream();
    let stream_recorder = recorder.clone();

    // 流式消费并实时解析 SSE 中的 usage 及完成状态
    let stream = async_stream::stream! {
        let mut raw_stream = raw_stream;
        let mut accumulated_input_tokens: Option<u64> = None;
        let mut accumulated_output_tokens: Option<u64> = None;
        let mut accumulated_cache_read: Option<u64> = None;
        let mut accumulated_cache_write: Option<u64> = None;

        while let Some(chunk_res) = raw_stream.next().await {
            match chunk_res {
                Ok(chunk) => {
                    if let Some(ref rec) = stream_recorder {
                        let _ = rec.response_chunk(&chunk).await;
                    }
                    if let Ok(text) = std::str::from_utf8(&chunk) {
                        for line in text.lines() {
                            if line.starts_with("data: ") {
                                let payload = &line[6..];
                                if let Ok(val) = serde_json::from_str::<Value>(payload) {
                                    if let Some(usage_obj) = val.get("usage") {
                                        if let Some(input) = usage_obj.get("input_tokens").and_then(Value::as_u64) {
                                            accumulated_input_tokens = Some(input);
                                        }
                                        if let Some(output) = usage_obj.get("output_tokens").and_then(Value::as_u64) {
                                            accumulated_output_tokens = Some(output);
                                        }
                                        if let Some(cache_read) = usage_obj.get("cache_read_input_tokens").and_then(Value::as_u64) {
                                            accumulated_cache_read = Some(cache_read);
                                        }
                                        if let Some(cache_write) = usage_obj.get("cache_creation_input_tokens").and_then(Value::as_u64) {
                                            accumulated_cache_write = Some(cache_write);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    yield Ok(chunk);
                }
                Err(err) => {
                    if let Some(ref rec) = stream_recorder {
                        let _ = rec.failed(&Error::Http(err)).await;
                    }
                    yield Err(std::io::Error::new(std::io::ErrorKind::Other, "stream error"));
                    return;
                }
            }
        }

        if let Some(ref rec) = stream_recorder {
            let total = accumulated_input_tokens.unwrap_or(0) + accumulated_output_tokens.unwrap_or(0);
            let usage = Usage {
                input_tokens: accumulated_input_tokens,
                context_input_tokens: accumulated_input_tokens,
                output_tokens: accumulated_output_tokens,
                total_tokens: if total > 0 { Some(total) } else { None },
                cache_read_tokens: accumulated_cache_read,
                cache_write_tokens: accumulated_cache_write,
                reasoning_tokens: None,
            };
            let _ = rec.usage(usage).await;
            let _ = rec.completed(crate::provider::FinishReason::Stop).await;
        }
    };

    let body = Body::from_stream(stream);
    client_resp
        .body(body)
        .map_err(|e| Error::Protocol(e.to_string()))
}
