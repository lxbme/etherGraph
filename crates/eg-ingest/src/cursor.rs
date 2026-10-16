//! Sliding-window pagination over a block range ordered newest first.
//!
//! The upstream only serves `page * offset <= 10000` rows per query, so once a
//! window is exhausted the next one restarts at page 1 with `end_block` moved
//! down to the oldest block seen so far.

use eg_core::source::HistoryPage;
use serde::{Deserialize, Serialize};

/// Largest `page * offset` the upstream accepts.
pub const RESULT_WINDOW: u64 = 10_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cursor {
    pub end_block: u64,
    pub page: u32,
    pub fetched: u32,
    pub min_seen: Option<u64>,
    /// Rows of a single block exceeded the window and some were skipped.
    pub skipped: bool,
}

impl Cursor {
    pub fn new(end_block: u64) -> Self {
        Self {
            end_block,
            page: 1,
            fetched: 0,
            min_seen: None,
            skipped: false,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Step {
    Next(Cursor),
    Done {
        truncated: bool,
        min_block: Option<u64>,
    },
}

/// Folds one fetched page into the cursor. `truncated` in `Done` is true when
/// the cap was hit or rows of an over-full block were skipped.
pub fn advance(c: &Cursor, page: &HistoryPage, page_size: u32, cap: u32) -> Step {
    let fetched = c.fetched.saturating_add(page.row_count);
    let min_seen = match (c.min_seen, page.min_block) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    let done = |truncated: bool| Step::Done {
        truncated: truncated || c.skipped,
        min_block: min_seen,
    };
    if fetched >= cap {
        return done(true);
    }
    if page.row_count < page_size {
        return done(false);
    }
    if (u64::from(c.page) + 1) * u64::from(page_size) > RESULT_WINDOW {
        // A full page always has a minimum block; be conservative if not.
        let Some(min_block) = page.min_block else {
            return done(true);
        };
        let (end_block, skipped) = if min_block == c.end_block {
            // More than a window's worth of rows in one block: skip the rest of it.
            match min_block.checked_sub(1) {
                Some(b) => (b, true),
                None => return done(true),
            }
        } else {
            (min_block, c.skipped)
        };
        return Step::Next(Cursor {
            end_block,
            page: 1,
            fetched,
            min_seen,
            skipped,
        });
    }
    Step::Next(Cursor {
        page: c.page + 1,
        fetched,
        min_seen,
        ..c.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hp(row_count: u32, min_block: Option<u64>) -> HistoryPage {
        HistoryPage {
            transfers: vec![],
            tokens: vec![],
            row_count,
            min_block,
        }
    }

    fn cur(end_block: u64, page: u32, fetched: u32) -> Cursor {
        Cursor {
            end_block,
            page,
            fetched,
            min_seen: None,
            skipped: false,
        }
    }

    #[test]
    fn advance_short_page_done() {
        let c = Cursor {
            min_seen: Some(500),
            ..cur(1000, 2, 1000)
        };
        assert_eq!(
            advance(&c, &hp(10, Some(300)), 1000, 10_000),
            Step::Done {
                truncated: false,
                min_block: Some(300)
            }
        );
        // An empty page keeps the previously seen minimum.
        assert_eq!(
            advance(&c, &hp(0, None), 1000, 10_000),
            Step::Done {
                truncated: false,
                min_block: Some(500)
            }
        );
        assert_eq!(
            advance(&Cursor::new(1000), &hp(0, None), 1000, 10_000),
            Step::Done {
                truncated: false,
                min_block: None
            }
        );
    }

    #[test]
    fn advance_full_page_moves_to_next_page() {
        assert_eq!(
            advance(&cur(1000, 1, 0), &hp(1000, Some(800)), 1000, 10_000),
            Step::Next(Cursor {
                min_seen: Some(800),
                ..cur(1000, 2, 1000)
            })
        );
    }

    #[test]
    fn advance_cap_truncates() {
        let c = Cursor {
            min_seen: Some(900),
            ..cur(1000, 3, 2000)
        };
        // The cap wins even over a short page.
        assert_eq!(
            advance(&c, &hp(1000, Some(700)), 1000, 3000),
            Step::Done {
                truncated: true,
                min_block: Some(700)
            }
        );
        assert_eq!(
            advance(&c, &hp(999, Some(700)), 1000, 2500),
            Step::Done {
                truncated: true,
                min_block: Some(700)
            }
        );
    }

    #[test]
    fn advance_slides_window_at_10000() {
        let c = Cursor {
            min_seen: Some(5000),
            ..cur(9000, 10, 9000)
        };
        assert_eq!(
            advance(&c, &hp(1000, Some(4000)), 1000, 20_000),
            Step::Next(Cursor {
                end_block: 4000,
                page: 1,
                fetched: 10_000,
                min_seen: Some(4000),
                skipped: false,
            })
        );
        // Page 9 of 1000 still fits: 10 * 1000 <= 10000.
        assert_eq!(
            advance(&cur(9000, 9, 8000), &hp(1000, Some(4000)), 1000, 20_000),
            Step::Next(Cursor {
                min_seen: Some(4000),
                ..cur(9000, 10, 9000)
            })
        );
    }

    #[test]
    fn advance_same_block_overflow_skips_block() {
        let c = Cursor {
            min_seen: Some(9000),
            ..cur(9000, 10, 9000)
        };
        let Step::Next(next) = advance(&c, &hp(1000, Some(9000)), 1000, 50_000) else {
            panic!("expected Next");
        };
        assert_eq!(
            next,
            Cursor {
                end_block: 8999,
                page: 1,
                fetched: 10_000,
                min_seen: Some(9000),
                skipped: true,
            }
        );
        // Any later completion reports truncation.
        assert_eq!(
            advance(&next, &hp(5, Some(8000)), 1000, 50_000),
            Step::Done {
                truncated: true,
                min_block: Some(8000)
            }
        );
        assert_eq!(
            advance(&next, &hp(0, None), 1000, 50_000),
            Step::Done {
                truncated: true,
                min_block: Some(9000)
            }
        );
    }

    #[test]
    fn advance_same_block_overflow_at_genesis_is_done() {
        let c = cur(0, 10, 9000);
        assert_eq!(
            advance(&c, &hp(1000, Some(0)), 1000, 50_000),
            Step::Done {
                truncated: true,
                min_block: Some(0)
            }
        );
    }
}
