mod common;

use common::anon_app;
use eg_server::config::Config;
use eg_server::import_tokens::TokenFormat;
use eg_server::state::SIGNATURES_SETTING;
use serde_json::json;
use sqlx::PgPool;

fn cfg(enabled: bool) -> Config {
    let mut cfg = Config::default();
    cfg.signatures.enabled = enabled;
    cfg
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn the_signature_switch_prefers_the_setting_over_config(pool: PgPool) {
    // A setting of false wins over a config of true.
    let (_, state, _) = anon_app(pool.clone(), cfg(true));
    state
        .store
        .setting_set(SIGNATURES_SETTING, &json!(false))
        .await
        .unwrap();
    state.load_signatures_setting().await.unwrap();
    assert!(!state.signatures_enabled());

    // And a setting of true over a config of false.
    state
        .store
        .setting_set(SIGNATURES_SETTING, &json!(true))
        .await
        .unwrap();
    let (_, off, _) = anon_app(pool.clone(), cfg(false));
    off.load_signatures_setting().await.unwrap();
    assert!(off.signatures_enabled());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn without_a_setting_the_config_decides(pool: PgPool) {
    let (_, on, _) = anon_app(pool.clone(), cfg(true));
    on.load_signatures_setting().await.unwrap();
    assert!(on.signatures_enabled());
    let (_, off, _) = anon_app(pool, cfg(false));
    off.load_signatures_setting().await.unwrap();
    assert!(!off.signatures_enabled());
}

#[sqlx::test(migrations = "../eg-store/migrations")]
async fn cli_token_import_records_status(pool: PgPool) {
    let (_, state, _) = anon_app(pool, Config::default());
    let list = format!(
        r#"{{"name":"x","version":{{"major":1,"minor":2,"patch":3}},"tokens":[
            {{"chainId":1,"address":"{:#x}","symbol":"AAA","name":"A"}},
            {{"chainId":1,"address":"{:#x}","symbol":"BBB","name":"B"}}]}}"#,
        alloy_primitives::Address::repeat_byte(0x11),
        alloy_primitives::Address::repeat_byte(0x22),
    );
    let path = std::env::temp_dir().join(format!("eg-local-data-{}.json", std::process::id()));
    std::fs::write(&path, &list).unwrap();
    let out = eg_server::cli::import_tokens(&state.store, TokenFormat::Uniswap, &path).await;
    std::fs::remove_file(&path).ok();
    out.unwrap();

    let rows = state.store.local_data_all().await.unwrap();
    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!(r.source, "tokens_uniswap");
    assert_eq!(r.version.as_deref(), Some("1.2.3"));
    assert_eq!(r.rows, Some(2));
    assert_eq!(r.state, "idle");
    assert!(r.imported_at.is_some());
    assert_eq!(r.sha256.as_ref().map(String::len), Some(64));
}
