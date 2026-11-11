//! The library half of the fixture: sccache caches an rlib compile.

/// The sum of the first `n` squares.
pub fn sum_of_squares(n: u64) -> u64 {
    (1..=n).map(|k| k * k).sum()
}

#[cfg(test)]
mod tests {
    #[test]
    fn sums() {
        assert_eq!(super::sum_of_squares(3), 14);
    }
}
