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
    /// Highest block whose remaining rows were skipped; it is only partially
    /// fetched, so it bounds the claimed coverage.
    #[serde(default)]
    pub skipped_block: Option<u64>,
}

impl Cursor {
    pub fn new(end_block: u64) -> Self {
        Self {
            end_block,
            page: 1,
            fetched: 0,
            min_seen: None,
            skipped: false,
            skipped_block: None,
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
/// the cap was hit or rows of an over-full block were skipped; in the latter
/// case `min_block` is that (partially fetched) block, never anything below it.
pub fn advance(c: &Cursor, page: &HistoryPage, page_size: u32, cap: u32) -> Step {
    let fetched = c.fetched.saturating_add(page.row_count);
    let min_seen = match (c.min_seen, page.min_block) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    let done = |truncated: bool, skipped_block: Option<u64>| Step::Done {
        truncated: truncated || c.skipped || skipped_block.is_some(),
        min_block: skipped_block.or(min_seen),
    };
    if fetched >= cap {
        return done(true, c.skipped_block);
    }
    if page.row_count < page_size {
        return done(false, c.skipped_block);
    }
    if (u64::from(c.page) + 1) * u64::from(page_size) > RESULT_WINDOW {
        // A full page always has a minimum block; be conservative if not.
        let Some(min_block) = page.min_block else {
            return done(true, c.skipped_block);
        };
        if min_block != c.end_block {
            return Step::Next(Cursor {
                end_block: min_block,
                page: 1,
                fetched,
                min_seen,
                ..c.clone()
            });
        }
        // More than a window's worth of rows in one block: skip the rest of
        // it. Blocks only descend, so an earlier skipped block is higher.
        let skipped_block = c.skipped_block.or(Some(min_block));
        let Some(end_block) = min_block.checked_sub(1) else {
            return done(true, skipped_block);
        };
        return Step::Next(Cursor {
            end_block,
            page: 1,
            fetched,
            min_seen,
            skipped: true,
            skipped_block,
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
            skipped_block: None,
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
                skipped_block: None,
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
                skipped_block: Some(9000),
            }
        );
        // Any later completion is truncated at the partially fetched block,
        // however far below it the fetch went.
        assert_eq!(
            advance(&next, &hp(5, Some(8000)), 1000, 50_000),
            Step::Done {
                truncated: true,
                min_block: Some(9000)
            }
        );
        assert_eq!(
            advance(&next, &hp(0, None), 1000, 50_000),
            Step::Done {
                truncated: true,
                min_block: Some(9000)
            }
        );
        assert_eq!(
            advance(&next, &hp(1000, Some(7000)), 1000, 11_000),
            Step::Done {
                truncated: true,
                min_block: Some(9000)
            }
        );
        // A plain window slide keeps the skipped block.
        let deep = Cursor {
            page: 10,
            ..next.clone()
        };
        let Step::Next(slid) = advance(&deep, &hp(1000, Some(5000)), 1000, 50_000) else {
            panic!("expected Next");
        };
        assert_eq!(
            (slid.end_block, slid.skipped, slid.skipped_block),
            (5000, true, Some(9000))
        );
        // A second over-full block keeps the highest skipped block.
        let again = Cursor { page: 10, ..slid };
        let Step::Next(twice) = advance(&again, &hp(1000, Some(5000)), 1000, 50_000) else {
            panic!("expected Next");
        };
        assert_eq!((twice.end_block, twice.skipped_block), (4999, Some(9000)));
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
        let after_skip = Cursor {
            skipped: true,
            skipped_block: Some(7),
            ..c
        };
        assert_eq!(
            advance(&after_skip, &hp(1000, Some(0)), 1000, 50_000),
            Step::Done {
                truncated: true,
                min_block: Some(7)
            }
        );
    }
}
