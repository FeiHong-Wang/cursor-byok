//! Builds the top-level server router.

use crate::{cursor::transport::TransportRegistry, network::NetworkClients, store::Store, Result};

pub fn router(
    registry: TransportRegistry,
    store: Store,
    clients: NetworkClients,
) -> Result<axum::Router> {
    let cursor_router = super::cursor::router(registry, clients.clone())?;
    let claude_router = super::claude::router(store, clients);
    Ok(cursor_router.merge(claude_router))
}
