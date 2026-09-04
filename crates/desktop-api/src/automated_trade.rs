use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MAX_SELL_PERCENT_BPS: u64 = 2_500;
pub const MAX_SLIPPAGE_BPS: u64 = 500;
const MAX_CLOCK_SKEW_MS: u64 = 5_000;
const MAX_INTENT_LIFETIME_MS: u64 = 120_000;
const MAX_REPLAY_RECORDS: usize = 1_024;

#[derive(Clone, Debug, Deserialize)]
pub struct AutomatedTokenSellIntent {
    pub request_id: String,
    pub wallet_id: String,
    pub mint: String,
    pub venue: String,
    pub sell_percent_bps: u64,
    pub slippage_bps: u64,
    pub expires_at_ms: u64,
}

impl AutomatedTokenSellIntent {
    pub fn validate(&self, now_ms: u64) -> Result<(), String> {
        if self.request_id.len() < 16
            || self.request_id.len() > 80
            || !self
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("automated trade request_id is invalid".to_string());
        }
        if self.sell_percent_bps == 0 || self.sell_percent_bps > MAX_SELL_PERCENT_BPS {
            return Err(format!(
                "automated sells must be between 1 and {MAX_SELL_PERCENT_BPS} basis points"
            ));
        }
        if self.slippage_bps == 0 || self.slippage_bps > MAX_SLIPPAGE_BPS {
            return Err(format!(
                "automated trade slippage must be between 1 and {MAX_SLIPPAGE_BPS} basis points"
            ));
        }
        if !matches!(self.venue.as_str(), "pumpfun" | "pumpswap") {
            return Err("automated trade venue must be pumpfun or pumpswap".to_string());
        }
        if self.expires_at_ms.saturating_add(MAX_CLOCK_SKEW_MS) < now_ms {
            return Err("automated trade intent has expired".to_string());
        }
        if self.expires_at_ms > now_ms.saturating_add(MAX_INTENT_LIFETIME_MS) {
            return Err("automated trade intent lifetime exceeds two minutes".to_string());
        }
        Ok(())
    }

    fn fingerprint(&self) -> String {
        format!(
            "{}\0{}\0{}\0{}\0{}",
            self.wallet_id, self.mint, self.venue, self.sell_percent_bps, self.slippage_bps
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AutomatedTradeReceipt {
    pub status: String,
    pub signature: String,
    pub dex: String,
    pub market: String,
    pub sold_raw_amount: String,
    pub decimals: u8,
    pub source_account: String,
}

#[derive(Clone)]
enum ReplayRecord {
    InFlight,
    Finished(Result<AutomatedTradeReceipt, String>),
}

#[derive(Clone)]
struct ReplayEntry {
    fingerprint: String,
    expires_at_ms: u64,
    record: ReplayRecord,
}

#[derive(Default)]
struct ReplayGuard {
    records: HashMap<String, ReplayEntry>,
}

static REPLAY_GUARD: OnceLock<Mutex<ReplayGuard>> = OnceLock::new();

fn replay_guard() -> &'static Mutex<ReplayGuard> {
    REPLAY_GUARD.get_or_init(|| Mutex::new(ReplayGuard::default()))
}

pub enum ReplayDecision {
    Execute(TradeExecutionGuard),
    Finished(Result<AutomatedTradeReceipt, String>),
}

pub struct TradeExecutionGuard {
    request_id: String,
    finished: bool,
}

impl TradeExecutionGuard {
    pub fn finish(mut self, result: Result<AutomatedTradeReceipt, String>) -> Result<(), String> {
        store_result(&self.request_id, result)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for TradeExecutionGuard {
    fn drop(&mut self) {
        if !self.finished {
            let _ = store_result(
                &self.request_id,
                Err(
                    "automated trade was interrupted; inspect transaction history before retrying"
                        .to_string(),
                ),
            );
        }
    }
}

pub fn begin(intent: &AutomatedTokenSellIntent, now_ms: u64) -> Result<ReplayDecision, String> {
    let mut guard = replay_guard()
        .lock()
        .map_err(|_| "automated trade replay guard is poisoned".to_string())?;
    guard
        .records
        .retain(|_, entry| entry.expires_at_ms.saturating_add(MAX_CLOCK_SKEW_MS) >= now_ms);
    match guard
        .records
        .get(&intent.request_id)
        .map(|entry| &entry.record)
    {
        Some(ReplayRecord::InFlight) => {
            return Err("automated trade request is already in progress".to_string())
        }
        Some(ReplayRecord::Finished(result)) => {
            return Ok(ReplayDecision::Finished(result.clone()))
        }
        None => {}
    }
    let fingerprint = intent.fingerprint();
    if let Some(existing) = guard
        .records
        .values()
        .find(|entry| entry.fingerprint == fingerprint)
    {
        return match &existing.record {
            ReplayRecord::InFlight => {
                Err("an equivalent automated trade is already in progress".to_string())
            }
            ReplayRecord::Finished(result) => Ok(ReplayDecision::Finished(result.clone())),
        };
    }
    if guard.records.len() >= MAX_REPLAY_RECORDS {
        let completed = guard
            .records
            .iter()
            .find_map(|(id, record)| {
                matches!(record.record, ReplayRecord::Finished(_)).then(|| id.clone())
            })
            .ok_or_else(|| "too many automated trades are currently in progress".to_string())?;
        guard.records.remove(&completed);
    }
    guard.records.insert(
        intent.request_id.clone(),
        ReplayEntry {
            fingerprint,
            expires_at_ms: intent.expires_at_ms,
            record: ReplayRecord::InFlight,
        },
    );
    Ok(ReplayDecision::Execute(TradeExecutionGuard {
        request_id: intent.request_id.clone(),
        finished: false,
    }))
}

fn store_result(
    request_id: &str,
    result: Result<AutomatedTradeReceipt, String>,
) -> Result<(), String> {
    let mut guard = replay_guard()
        .lock()
        .map_err(|_| "automated trade replay guard is poisoned".to_string())?;
    let entry = guard
        .records
        .get_mut(request_id)
        .ok_or_else(|| "automated trade replay record is missing".to_string())?;
    entry.record = ReplayRecord::Finished(result);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent() -> AutomatedTokenSellIntent {
        AutomatedTokenSellIntent {
            request_id: "request-0123456789".to_string(),
            wallet_id: "a".repeat(32),
            mint: "11111111111111111111111111111111".to_string(),
            venue: "pumpfun".to_string(),
            sell_percent_bps: 1_000,
            slippage_bps: 100,
            expires_at_ms: 101_000,
        }
    }

    #[test]
    fn validates_bounded_short_lived_intents() {
        assert!(intent().validate(100_000).is_ok());
        let mut excessive_sell = intent();
        excessive_sell.sell_percent_bps = MAX_SELL_PERCENT_BPS + 1;
        assert!(excessive_sell.validate(100_000).is_err());
        let mut excessive_slippage = intent();
        excessive_slippage.slippage_bps = MAX_SLIPPAGE_BPS + 1;
        assert!(excessive_slippage.validate(100_000).is_err());
        let mut stale = intent();
        stale.expires_at_ms = 90_000;
        assert!(stale.validate(100_000).is_err());
    }

    #[test]
    fn replay_guard_returns_the_original_receipt() {
        let mut trade = intent();
        trade.request_id = "replay-request-0123456789".to_string();
        let guard = match begin(&trade, 100_000).unwrap() {
            ReplayDecision::Execute(guard) => guard,
            ReplayDecision::Finished(_) => panic!("expected new execution"),
        };
        assert!(begin(&trade, 100_000).is_err());
        let receipt = AutomatedTradeReceipt {
            status: "success".to_string(),
            signature: "signature".to_string(),
            dex: "pumpfun".to_string(),
            market: "inner".to_string(),
            sold_raw_amount: "42".to_string(),
            decimals: 6,
            source_account: "source".to_string(),
        };
        guard.finish(Ok(receipt.clone())).unwrap();
        match begin(&trade, 100_000).unwrap() {
            ReplayDecision::Finished(Ok(replayed)) => assert_eq!(replayed, receipt),
            _ => panic!("expected completed replay"),
        }

        let mut equivalent = trade.clone();
        equivalent.request_id = "equivalent-request-0123456789".to_string();
        assert!(matches!(
            begin(&equivalent, 100_000).unwrap(),
            ReplayDecision::Finished(Ok(_))
        ));

        equivalent.request_id = "expired-fingerprint-0123456789".to_string();
        equivalent.expires_at_ms = 200_000;
        let guard = match begin(&equivalent, 106_001).unwrap() {
            ReplayDecision::Execute(guard) => guard,
            ReplayDecision::Finished(_) => {
                panic!("expired fingerprint must not block a new intent")
            }
        };
        drop(guard);
    }

    #[test]
    fn dropped_execution_guard_caches_an_interrupted_result() {
        let mut trade = intent();
        trade.request_id = "interrupted-request-0123456789".to_string();
        trade.mint = "22222222222222222222222222222222".to_string();
        let guard = match begin(&trade, 100_000).unwrap() {
            ReplayDecision::Execute(guard) => guard,
            ReplayDecision::Finished(_) => panic!("expected new execution"),
        };
        drop(guard);
        match begin(&trade, 100_000).unwrap() {
            ReplayDecision::Finished(Err(message)) => {
                assert!(message.contains("interrupted"));
            }
            _ => panic!("expected interrupted replay result"),
        }
    }
}
