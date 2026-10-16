use chrono::{DateTime, Utc};
use sqlx::Row;
use sqlx::postgres::PgRow;

use crate::{Result, Store, StoreError};

#[derive(Clone, Debug)]
pub struct WorkspaceMeta {
    pub id: i64,
    pub name: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct WorkspaceRow {
    pub id: i64,
    pub name: String,
    pub schema_version: i32,
    pub state: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

macro_rules! ws_cols {
    () => {
        "id, name, schema_version, state, created_at, updated_at"
    };
}

fn ws_row(r: &PgRow) -> Result<WorkspaceRow> {
    Ok(WorkspaceRow {
        id: r.try_get("id")?,
        name: r.try_get("name")?,
        schema_version: r.try_get("schema_version")?,
        state: r.try_get("state")?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

impl Store {
    pub async fn list_workspaces(&self) -> Result<Vec<WorkspaceMeta>> {
        let rows = sqlx::query(
            "SELECT id, name, updated_at FROM workspaces ORDER BY updated_at DESC, id DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok(WorkspaceMeta {
                    id: r.try_get("id")?,
                    name: r.try_get("name")?,
                    updated_at: r.try_get("updated_at")?,
                })
            })
            .collect()
    }

    pub async fn create_workspace(
        &self,
        name: &str,
        state: &serde_json::Value,
    ) -> Result<WorkspaceRow> {
        let sql = concat!(
            "INSERT INTO workspaces (name, schema_version, state) VALUES ($1, 1, $2) \
             RETURNING ",
            ws_cols!()
        );
        let row = sqlx::query(sql)
            .bind(name)
            .bind(state)
            .fetch_one(&self.pool)
            .await?;
        ws_row(&row)
    }

    pub async fn get_workspace(&self, id: i64) -> Result<WorkspaceRow> {
        let sql = concat!("SELECT ", ws_cols!(), " FROM workspaces WHERE id = $1");
        let row = sqlx::query(sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(StoreError::NotFound)?;
        ws_row(&row)
    }

    /// Optimistic update: succeeds only if `updated_at` still equals
    /// `expected_updated_at`; otherwise `Conflict` (or `NotFound` if gone).
    pub async fn update_workspace(
        &self,
        id: i64,
        name: &str,
        state: &serde_json::Value,
        expected_updated_at: DateTime<Utc>,
    ) -> Result<WorkspaceRow> {
        let sql = concat!(
            "UPDATE workspaces SET name = $2, state = $3, updated_at = now() \
             WHERE id = $1 AND updated_at = $4 RETURNING ",
            ws_cols!()
        );
        let row = sqlx::query(sql)
            .bind(id)
            .bind(name)
            .bind(state)
            .bind(expected_updated_at)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            Some(r) => ws_row(&r),
            None => {
                let exists: bool =
                    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = $1)")
                        .bind(id)
                        .fetch_one(&self.pool)
                        .await?;
                Err(if exists {
                    StoreError::Conflict
                } else {
                    StoreError::NotFound
                })
            }
        }
    }

    pub async fn delete_workspace(&self, id: i64) -> Result<()> {
        let res = sqlx::query("DELETE FROM workspaces WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{Store, StoreError};
    use serde_json::json;
    use sqlx::PgPool;

    #[sqlx::test]
    async fn workspace_optimistic_conflict(pool: PgPool) {
        let s = Store::from_pool(pool);
        let w = s.create_workspace("a", &json!({"v": 1})).await.unwrap();
        assert_eq!(w.schema_version, 1);
        assert_eq!(
            s.get_workspace(w.id).await.unwrap().updated_at,
            w.updated_at
        );
        let w2 = s
            .update_workspace(w.id, "b", &json!({"v": 2}), w.updated_at)
            .await
            .unwrap();
        assert_eq!((w2.name.as_str(), &w2.state), ("b", &json!({"v": 2})));
        assert!(w2.updated_at > w.updated_at);
        let err = s
            .update_workspace(w.id, "c", &json!({}), w.updated_at)
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Conflict));
        // fresh timestamp round-trips exactly
        s.update_workspace(w.id, "d", &json!({}), w2.updated_at)
            .await
            .unwrap();
        let err = s
            .update_workspace(999, "x", &json!({}), w.updated_at)
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::NotFound));
    }

    #[sqlx::test]
    async fn workspace_list_get_delete(pool: PgPool) {
        let s = Store::from_pool(pool);
        let a = s.create_workspace("a", &json!({})).await.unwrap();
        let b = s.create_workspace("b", &json!({})).await.unwrap();
        let l = s.list_workspaces().await.unwrap();
        assert_eq!(l.iter().map(|m| m.id).collect::<Vec<_>>(), vec![b.id, a.id]);
        s.update_workspace(a.id, "a2", &json!({}), a.updated_at)
            .await
            .unwrap();
        let l = s.list_workspaces().await.unwrap();
        assert_eq!(l[0].id, a.id);
        assert_eq!(l[0].name, "a2");
        s.delete_workspace(a.id).await.unwrap();
        assert!(matches!(
            s.get_workspace(a.id).await.unwrap_err(),
            StoreError::NotFound
        ));
        assert!(matches!(
            s.delete_workspace(a.id).await.unwrap_err(),
            StoreError::NotFound
        ));
    }
}
