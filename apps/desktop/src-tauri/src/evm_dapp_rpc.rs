//! Read-only EIP-1193 transport. The trusted wallet window selects the endpoint;
//! remote DApps supply only an allowlisted method and JSON parameters.
use serde::Serialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

const MAX_REQUEST: usize = 128 * 1024;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}
impl RpcError {
    pub fn new(code: i64, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
}

pub fn validate_request(method: &str, params: &Value) -> Result<(), RpcError> {
    if !matches!(
        method,
        "eth_blockNumber"
            | "eth_gasPrice"
            | "eth_maxPriorityFeePerGas"
            | "eth_feeHistory"
            | "eth_getBalance"
            | "eth_getCode"
            | "eth_getTransactionCount"
            | "eth_getTransactionReceipt"
            | "eth_getTransactionByHash"
            | "eth_getBlockByNumber"
            | "eth_getBlockByHash"
            | "eth_call"
            | "eth_estimateGas"
            | "eth_getLogs"
            | "eth_getStorageAt"
    ) {
        return Err(RpcError::new(4200, "Unsupported FnzSafe read method"));
    }
    if !params.is_array() || params.to_string().len() > MAX_REQUEST {
        return Err(RpcError::new(-32602, "Invalid or oversized RPC parameters"));
    }
    Ok(())
}

fn decode_response(value: Value) -> Result<Value, RpcError> {
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || value.get("id") != Some(&json!(1))
    {
        return Err(RpcError::new(-32603, "Invalid RPC response"));
    }
    if let Some(error) = value.get("error") {
        return Err(RpcError {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("RPC request failed")
                .chars()
                .take(512)
                .collect(),
            data: error.get("data").cloned(),
        });
    }
    // A null receipt is valid while a transaction is pending.
    value
        .get("result")
        .cloned()
        .ok_or_else(|| RpcError::new(-32603, "Missing RPC result"))
}

pub struct ReadRpc {
    url: reqwest::Url,
    chain_id: u64,
    client: reqwest::Client,
    in_flight: Semaphore,
}
impl ReadRpc {
    pub fn new(url: &str, network: &str) -> Result<Arc<Self>, String> {
        let chain_id = network
            .strip_prefix("eip155:")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .ok_or("invalid EVM dapp network")?;
        let url = reqwest::Url::parse(url).map_err(|_| "invalid EVM RPC URL")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(url.scheme() == "https" || (url.scheme() == "http" && local))
            || url.host_str().is_none()
            || url.fragment().is_some()
        {
            return Err("EVM RPC requires HTTPS or local HTTP".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "RPC client unavailable")?;
        Ok(Arc::new(Self {
            url,
            chain_id,
            client,
            in_flight: Semaphore::new(8),
        }))
    }
    async fn send(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let mut response = self
            .client
            .post(self.url.clone())
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await
            .map_err(|_| RpcError::new(4900, "FnzSafe RPC connection failed"))?;
        if !response.status().is_success() {
            return Err(RpcError::new(4900, "FnzSafe RPC returned an HTTP error"));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| RpcError::new(4900, "FnzSafe RPC response failed"))?
        {
            if body.len() + chunk.len() > MAX_RESPONSE {
                return Err(RpcError::new(-32603, "RPC response too large"));
            }
            body.extend_from_slice(&chunk);
        }
        decode_response(
            serde_json::from_slice(&body).map_err(|_| RpcError::new(-32603, "Invalid RPC JSON"))?,
        )
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        validate_request(method, &params)?;
        let _permit = self
            .in_flight
            .try_acquire()
            .map_err(|_| RpcError::new(-32005, "Too many pending RPC requests"))?;
        let reported = self.send("eth_chainId", json!([])).await?;
        let actual = reported
            .as_str()
            .and_then(|v| v.strip_prefix("0x"))
            .and_then(|v| u64::from_str_radix(v, 16).ok());
        if actual != Some(self.chain_id) {
            return Err(RpcError::new(
                4901,
                "RPC network does not match the selected wallet network",
            ));
        }
        self.send(method, params).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn read_boundary_rejects_signing_admin_and_arbitrary_payloads() {
        for method in [
            "eth_sendRawTransaction",
            "eth_sendTransaction",
            "personal_sign",
            "eth_sign",
            "admin_peers",
            "debug_traceCall",
            "wallet_addEthereumChain",
            "eth_newFilter",
        ] {
            assert_eq!(validate_request(method, &json!([])).unwrap_err().code, 4200);
        }
        assert!(
            validate_request("eth_estimateGas", &json!([{"to":"0x123", "data":"0x456"}])).is_ok()
        );
        assert!(validate_request("eth_call", &json!({"url":"http://localhost"})).is_err());
        assert!(validate_request("eth_call", &json!(["x".repeat(MAX_REQUEST)])).is_err());
    }
    #[test]
    fn preserves_null_receipts_and_revert_details() {
        assert_eq!(
            decode_response(json!({"jsonrpc":"2.0","id":1,"result":null})).unwrap(),
            Value::Null
        );
        let e=decode_response(json!({"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x1234"}})).unwrap_err();
        assert_eq!(e.code, 3);
        assert_eq!(e.data, Some(json!("0x1234")));
        assert!(decode_response(json!({"jsonrpc":"2.0","id":2,"result":"0x1"})).is_err());
        assert!(decode_response(json!({"jsonrpc":"2.0","id":1})).is_err());
    }
    #[test]
    fn rpc_configuration_is_bound_to_a_valid_network() {
        assert!(ReadRpc::new("https://rpc.example/path", "eip155:97").is_ok());
        assert!(ReadRpc::new("http://127.0.0.1:8545", "eip155:1337").is_ok());
        for url in [
            "file:///tmp/foo",
            "http://remote.example",
            "https://rpc.example/#key",
        ] {
            assert!(ReadRpc::new(url, "eip155:97").is_err());
        }
        assert!(ReadRpc::new("https://rpc.example", "mainnet").is_err());
    }
    fn mock_rpc(replies: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let mut methods = Vec::new();
            for reply in replies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let header_end = loop {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                    if bytes.ends_with(b"\r\n\r\n") {
                        break bytes.len();
                    }
                };
                let headers = String::from_utf8_lossy(&bytes).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|s| s.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                bytes.resize(header_end + length, 0);
                stream.read_exact(&mut bytes[header_end..]).unwrap();
                let request: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                methods.push(request["method"].as_str().unwrap().into());
                let body = reply.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
            methods
        });
        (url, task)
    }
    #[test]
    fn transport_checks_network_and_forwards_estimation_errors() {
        let (url, task) = mock_rpc(vec![
            json!({"jsonrpc":"2.0","id":1,"result":"0x61"}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0xaabbccdd"}}),
        ]);
        let rpc = ReadRpc::new(&url, "eip155:97").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let e = rt
            .block_on(rpc.request("eth_estimateGas", json!([{"from":"0x123"}])))
            .unwrap_err();
        assert_eq!(e.code, 3);
        assert_eq!(e.data, Some(json!("0xaabbccdd")));
        assert_eq!(task.join().unwrap(), vec!["eth_chainId", "eth_estimateGas"]);
    }
    #[test]
    fn wrong_network_stops_before_forwarding_the_read() {
        let (url, task) = mock_rpc(vec![json!({"jsonrpc":"2.0","id":1,"result":"0x38"})]);
        let rpc = ReadRpc::new(&url, "eip155:97").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            rt.block_on(rpc.request("eth_getBalance", json!([])))
                .unwrap_err()
                .code,
            4901
        );
        assert_eq!(task.join().unwrap(), vec!["eth_chainId"]);
    }
}
