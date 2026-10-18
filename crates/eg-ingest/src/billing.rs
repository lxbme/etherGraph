//! Who pays for an upstream call: the user a job or request runs for.
//!
//! The runner runs each job inside [`billed`] with the job's owner, and routes
//! wrap their synchronous Etherscan calls in `billed(Some(viewer), …)`. The
//! rate gate reads [`bill_to`] when a permit is requested and counts it toward
//! that user's daily limit. Work outside any scope (head refresh, EIP-1271
//! login checks, system jobs) is billed to nobody.

use std::future::Future;

tokio::task_local! {
    /// The user the current task's upstream calls are billed to; `None` for
    /// nobody (system work).
    pub static BILL_TO: Option<i64>;
}

/// Runs `f` with its upstream calls billed to `user` (`None`: nobody).
pub async fn billed<F: Future>(user: Option<i64>, f: F) -> F::Output {
    BILL_TO.scope(user, f).await
}

/// The user the calling task bills to; `None` outside any [`billed`] scope.
pub fn bill_to() -> Option<i64> {
    BILL_TO.try_with(|u| *u).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scopes_nest_and_end() {
        assert_eq!(bill_to(), None);
        let inner = billed(Some(7), async {
            let outer = bill_to();
            let nested = billed(None, async { bill_to() }).await;
            (outer, nested, bill_to())
        })
        .await;
        assert_eq!(inner, (Some(7), None, Some(7)));
        assert_eq!(bill_to(), None);
    }

    #[tokio::test]
    async fn a_spawned_task_bills_nobody() {
        let spawned = billed(Some(7), async { tokio::spawn(async { bill_to() }).await })
            .await
            .unwrap();
        assert_eq!(spawned, None);
    }
}
