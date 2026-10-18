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
    /// `owner`'s workspaces, most recently updated first.
    pub async fn list_workspaces(&self, owner: i64) -> Result<Vec<WorkspaceMeta>> {
        let rows = sqlx::query(
            "SELECT id, name, updated_at FROM workspaces WHERE owner_id = $1 \
             ORDER BY updated_at DESC, id DESC",
        )
        .bind(owner)
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
        owner: i64,
        name: &str,
        schema_version: i32,
        state: &serde_json::Value,
    ) -> Result<WorkspaceRow> {
        let sql = concat!(
            "INSERT INTO workspaces (name, schema_version, state, owner_id) \
             VALUES ($1, $2, $3, $4) RETURNING ",
            ws_cols!()
        );
        let row = sqlx::query(sql)
            .bind(name)
            .bind(schema_version)
            .bind(state)
            .bind(owner)
            .fetch_one(&self.pool)
            .await?;
        ws_row(&row)
    }

    /// One of `owner`'s workspaces; another user's is `NotFound`, like a
    /// missing one.
    pub async fn get_workspace(&self, owner: i64, id: i64) -> Result<WorkspaceRow> {
        let sql = concat!(
            "SELECT ",
            ws_cols!(),
            " FROM workspaces WHERE id = $1 AND owner_id = $2"
        );
        let row = sqlx::query(sql)
            .bind(id)
            .bind(owner)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(StoreError::NotFound)?;
        ws_row(&row)
    }

    /// Optimistic update of one of `owner`'s workspaces: succeeds only if
    /// `updated_at` still equals `expected_updated_at`; otherwise `Conflict`
    /// (or `NotFound` if gone or another user's). A `None` schema version
    /// keeps the stored one.
    pub async fn update_workspace(
        &self,
        owner: i64,
        id: i64,
        name: &str,
        schema_version: Option<i32>,
        state: &serde_json::Value,
        expected_updated_at: DateTime<Utc>,
    ) -> Result<WorkspaceRow> {
        let sql = concat!(
            "UPDATE workspaces SET name = $2, state = $3, updated_at = now(), \
             schema_version = COALESCE($5, schema_version) \
             WHERE id = $1 AND updated_at = $4 AND owner_id = $6 RETURNING ",
            ws_cols!()
        );
        let row = sqlx::query(sql)
            .bind(id)
            .bind(name)
            .bind(state)
            .bind(expected_updated_at)
            .bind(schema_version)
            .bind(owner)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            Some(r) => ws_row(&r),
            None => {
                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = $1 AND owner_id = $2)",
                )
                .bind(id)
                .bind(owner)
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

    /// Deletes one of `owner`'s workspaces; another user's is `NotFound`.
    pub async fn delete_workspace(&self, owner: i64, id: i64) -> Result<()> {
        let res = sqlx::query("DELETE FROM workspaces WHERE id = $1 AND owner_id = $2")
            .bind(id)
            .bind(owner)
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
    use crate::{Address, Store, StoreError};
    use serde_json::json;
    use sqlx::PgPool;

    async fn user(s: &Store, byte: u8) -> i64 {
        s.upsert_user_on_login(Address::repeat_byte(byte))
            .await
            .unwrap()
            .id
    }

    #[sqlx::test]
    async fn workspace_optimistic_conflict(pool: PgPool) {
        let s = Store::from_pool(pool);
        let me = user(&s, 0xe0).await;
        let w = s
            .create_workspace(me, "a", 1, &json!({"v": 1}))
            .await
            .unwrap();
        assert_eq!(w.schema_version, 1);
        assert_eq!(
            s.get_workspace(me, w.id).await.unwrap().updated_at,
            w.updated_at
        );
        let w2 = s
            .update_workspace(me, w.id, "b", None, &json!({"v": 2}), w.updated_at)
            .await
            .unwrap();
        assert_eq!((w2.name.as_str(), &w2.state), ("b", &json!({"v": 2})));
        assert!(w2.updated_at > w.updated_at);
        let err = s
            .update_workspace(me, w.id, "c", None, &json!({}), w.updated_at)
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Conflict));
        // fresh timestamp round-trips exactly
        s.update_workspace(me, w.id, "d", None, &json!({}), w2.updated_at)
            .await
            .unwrap();
        let err = s
            .update_workspace(me, 999, "x", None, &json!({}), w.updated_at)
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::NotFound));
    }

    #[sqlx::test]
    async fn workspace_list_get_delete(pool: PgPool) {
        let s = Store::from_pool(pool);
        let me = user(&s, 0xe0).await;
        let a = s.create_workspace(me, "a", 1, &json!({})).await.unwrap();
        let b = s.create_workspace(me, "b", 1, &json!({})).await.unwrap();
        let l = s.list_workspaces(me).await.unwrap();
        assert_eq!(l.iter().map(|m| m.id).collect::<Vec<_>>(), vec![b.id, a.id]);
        s.update_workspace(me, a.id, "a2", None, &json!({}), a.updated_at)
            .await
            .unwrap();
        let l = s.list_workspaces(me).await.unwrap();
        assert_eq!(l[0].id, a.id);
        assert_eq!(l[0].name, "a2");
        s.delete_workspace(me, a.id).await.unwrap();
        assert!(matches!(
            s.get_workspace(me, a.id).await.unwrap_err(),
            StoreError::NotFound
        ));
        assert!(matches!(
            s.delete_workspace(me, a.id).await.unwrap_err(),
            StoreError::NotFound
        ));
    }

    #[sqlx::test]
    async fn another_users_workspace_is_not_found(pool: PgPool) {
        let s = Store::from_pool(pool);
        let (me, other) = (user(&s, 0xe0).await, user(&s, 0xe1).await);
        let w = s
            .create_workspace(me, "mine", 1, &json!({"v": 1}))
            .await
            .unwrap();
        assert!(s.list_workspaces(other).await.unwrap().is_empty());
        assert!(matches!(
            s.get_workspace(other, w.id).await.unwrap_err(),
            StoreError::NotFound
        ));
        // Even with the right timestamp: NotFound, not Conflict.
        assert!(matches!(
            s.update_workspace(other, w.id, "x", None, &json!({}), w.updated_at)
                .await
                .unwrap_err(),
            StoreError::NotFound
        ));
        assert!(matches!(
            s.delete_workspace(other, w.id).await.unwrap_err(),
            StoreError::NotFound
        ));
        let still = s.get_workspace(me, w.id).await.unwrap();
        assert_eq!(
            (still.name.as_str(), &still.state, still.updated_at),
            ("mine", &json!({"v": 1}), w.updated_at)
        );
        // An unadopted workspace (no owner) is nobody's.
        sqlx::query("UPDATE workspaces SET owner_id = NULL WHERE id = $1")
            .bind(w.id)
            .execute(s.pool())
            .await
            .unwrap();
        assert!(s.list_workspaces(me).await.unwrap().is_empty());
    }
}
