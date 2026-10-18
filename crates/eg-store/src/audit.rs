//! The append-only audit log: database triggers reject UPDATE, DELETE and
//! TRUNCATE, and the store offers no way to change a row.
use chrono::{DateTime, Utc};
use sqlx::{Postgres, QueryBuilder, Row};

use crate::{Result, Store, StoreError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuditOutcome {
    Ok,
    Denied,
    Failed,
}

impl AuditOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            AuditOutcome::Ok => "ok",
            AuditOutcome::Denied => "denied",
            AuditOutcome::Failed => "failed",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "ok" => AuditOutcome::Ok,
            "denied" => AuditOutcome::Denied,
            "failed" => AuditOutcome::Failed,
            _ => return Err(StoreError::Invalid(format!("unknown audit outcome {s}"))),
        })
    }
}

/// One audit record as written; never holds secrets (tokens, cookies, keys).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditEntry {
    pub actor: String,
    pub action: String,
    pub target: Option<String>,
    pub before: Option<serde_json::Value>,
    pub after: Option<serde_json::Value>,
    pub outcome: AuditOutcome,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    /// The signed message, for signed actions.
    pub message: Option<String>,
    pub signature: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditRow {
    pub id: i64,
    pub at: DateTime<Utc>,
    pub entry: AuditEntry,
}

/// Every set field must match; `from`/`to` bound `at` inclusively.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuditFilter {
    pub actor: Option<String>,
    pub action: Option<String>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

impl Store {
    /// Returns the new row's id.
    pub async fn audit_append(&self, e: &AuditEntry) -> Result<i64> {
        Ok(sqlx::query_scalar(
            "INSERT INTO audit_log (actor, action, target, before, after, outcome, ip, \
             user_agent, message, signature) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             RETURNING id",
        )
        .bind(&e.actor)
        .bind(&e.action)
        .bind(&e.target)
        .bind(&e.before)
        .bind(&e.after)
        .bind(e.outcome.as_str())
        .bind(&e.ip)
        .bind(&e.user_agent)
        .bind(&e.message)
        .bind(&e.signature)
        .fetch_one(&self.pool)
        .await?)
    }

    /// Up to `limit` rows matching `filter`, newest first; `cursor` (the last
    /// id of the previous page) continues with strictly older rows.
    pub async fn audit_page(
        &self,
        filter: &AuditFilter,
        cursor: Option<i64>,
        limit: u32,
    ) -> Result<Vec<AuditRow>> {
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
            "SELECT id, at, actor, action, target, before, after, outcome, ip, user_agent, \
             message, signature FROM audit_log WHERE true",
        );
        if let Some(c) = cursor {
            qb.push(" AND id < ").push_bind(c);
        }
        if let Some(a) = &filter.actor {
            qb.push(" AND actor = ").push_bind(a);
        }
        if let Some(a) = &filter.action {
            qb.push(" AND action = ").push_bind(a);
        }
        if let Some(t) = filter.from {
            qb.push(" AND at >= ").push_bind(t);
        }
        if let Some(t) = filter.to {
            qb.push(" AND at <= ").push_bind(t);
        }
        qb.push(" ORDER BY id DESC LIMIT ")
            .push_bind(i64::from(limit));
        let rows = qb.build().fetch_all(&self.pool).await?;
        rows.iter()
            .map(|r| {
                Ok(AuditRow {
                    id: r.try_get("id")?,
                    at: r.try_get("at")?,
                    entry: AuditEntry {
                        actor: r.try_get("actor")?,
                        action: r.try_get("action")?,
                        target: r.try_get("target")?,
                        before: r.try_get("before")?,
                        after: r.try_get("after")?,
                        outcome: AuditOutcome::parse(r.try_get("outcome")?)?,
                        ip: r.try_get("ip")?,
                        user_agent: r.try_get("user_agent")?,
                        message: r.try_get("message")?,
                        signature: r.try_get("signature")?,
                    },
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use chrono::Utc;
    use serde_json::json;
    use sqlx::PgPool;

    fn entry(actor: &str, action: &str) -> AuditEntry {
        AuditEntry {
            actor: actor.into(),
            action: action.into(),
            target: Some("0xabc".into()),
            before: Some(json!({"calls": 1000})),
            after: Some(json!({"calls": 5000})),
            outcome: AuditOutcome::Ok,
            ip: Some("127.0.0.1".into()),
            user_agent: Some("test".into()),
            message: Some("Set the daily quota".into()),
            signature: Some("0xsig".into()),
        }
    }

    async fn db_err(pool: &PgPool, sql: &'static str) -> String {
        sqlx::query(sql)
            .execute(pool)
            .await
            .expect_err(sql)
            .to_string()
    }

    #[sqlx::test]
    async fn audit_log_is_append_only(pool: PgPool) {
        let s = Store::from_pool(pool.clone());
        s.audit_append(&entry("0xadmin", "login")).await.unwrap();
        for sql in [
            "UPDATE audit_log SET actor = 'x'",
            "DELETE FROM audit_log",
            "TRUNCATE audit_log",
        ] {
            let err = db_err(&pool, sql).await;
            assert!(err.contains("audit_log is append-only"), "{sql}: {err}");
        }
        let rows = s
            .audit_page(&AuditFilter::default(), None, 10)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].entry.actor, "0xadmin");
    }

    #[sqlx::test]
    async fn audit_roundtrip_and_paging(pool: PgPool) {
        let s = Store::from_pool(pool);
        let first = s.audit_append(&entry("a", "login")).await.unwrap();
        let mut denied = entry("b", "admin_access");
        denied.outcome = AuditOutcome::Denied;
        denied.target = None;
        denied.before = None;
        denied.after = None;
        denied.ip = None;
        denied.user_agent = None;
        denied.message = None;
        denied.signature = None;
        let second = s.audit_append(&denied).await.unwrap();
        let third = s.audit_append(&entry("a", "logout")).await.unwrap();
        assert!(first < second && second < third);

        let all = s
            .audit_page(&AuditFilter::default(), None, 10)
            .await
            .unwrap();
        let ids: Vec<i64> = all.iter().map(|r| r.id).collect();
        assert_eq!(ids, [third, second, first]);
        assert_eq!(all[1].entry, denied);
        assert_eq!(all[2].entry, entry("a", "login"));
        assert!(all[0].at <= Utc::now());

        // Cursor: rows strictly older than the given id.
        let page = s
            .audit_page(&AuditFilter::default(), Some(third), 1)
            .await
            .unwrap();
        assert_eq!(page.iter().map(|r| r.id).collect::<Vec<_>>(), [second]);

        let by_actor = AuditFilter {
            actor: Some("a".into()),
            ..AuditFilter::default()
        };
        let got = s.audit_page(&by_actor, None, 10).await.unwrap();
        assert_eq!(got.iter().map(|r| r.id).collect::<Vec<_>>(), [third, first]);
        let by_action = AuditFilter {
            action: Some("logout".into()),
            ..AuditFilter::default()
        };
        let got = s.audit_page(&by_action, None, 10).await.unwrap();
        assert_eq!(got.iter().map(|r| r.id).collect::<Vec<_>>(), [third]);
        let future = AuditFilter {
            from: Some(Utc::now() + chrono::Duration::hours(1)),
            ..AuditFilter::default()
        };
        assert!(s.audit_page(&future, None, 10).await.unwrap().is_empty());
        let past = AuditFilter {
            to: Some(Utc::now() - chrono::Duration::hours(1)),
            ..AuditFilter::default()
        };
        assert!(s.audit_page(&past, None, 10).await.unwrap().is_empty());
    }
}
