//! Generic Google `spot-pa` unary gRPC relay (Cloudflare Container).
//!
//! Workers `fetch()` strips `te: trailers`, so the Spot gRPC call can't run on
//! the edge (master-plan §1.5). This bare binary does ONLY that POST: the
//! fronting Worker builds the EID/window/protobuf + frame and mints the token,
//! then hands us `{x-spot-token, x-spot-method, body=framed gRPC message}`.
//! Promoted + generalised from spike/rust-transport (transport VALIDATED).
//!
//! Two modes:
//!   * `PORT` set → HTTP server (the Container shape). POST: body = the framed
//!     gRPC message, `x-spot-method` = the SpotService method path,
//!     `x-spot-token` (or `SPOT_TOKEN` env) = the bearer. Replies JSON with the
//!     full response body hex so the Worker can inspect it.
//!   * otherwise   → one-shot self-test (GetEidInfoForE2eeDevices) using
//!     `SPOT_TOKEN`, to confirm transport from `cargo run`.

use std::time::Duration;
use tiny_http::{Header, Response, Server};

const SPOT_HOST: &str = "https://spot-pa.googleapis.com";
const HEALTH_METHOD: &str = "google.internal.spot.v1.SpotService/GetEidInfoForE2eeDevices";
const UA: &str = "com.google.android.gms/244433022 grpc-java-cronet/1.69.0-SNAPSHOT";

fn hex_all(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect::<String>()
}

fn jstr(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}
fn jopt(o: &Option<String>) -> String {
    o.as_deref().map_or_else(|| "null".to_string(), jstr)
}

/// `{SPOT_HOST}/{method}` — the unary gRPC endpoint for `method`.
fn build_spot_url(method: &str) -> String {
    format!("{SPOT_HOST}/{method}")
}

/// gRPC length-prefixed frame `[compressed=0][u32 BE len][payload]`. Used only
/// for the self-test (the Worker frames real calls itself, identically).
fn build_health_frame() -> Vec<u8> {
    // GetEidInfoForE2eeDevicesRequest { ownerKeyVersion(1) = -1; hasOwnerKeyVersion(2) = true }
    let payload: [u8; 13] = [
        0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x10, 0x01,
    ];
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(0x00);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    frame
}

/// `ok` if the transport completed cleanly: HTTP 200 and (if present) grpc-status 0.
/// A definitive success/failure for a mutating call (Upload) is confirmed
/// out-of-band by the caller re-reading state — see master-plan Phase 4 step 8.
fn call_ok(http_status: u16, grpc_status: &Option<String>) -> bool {
    http_status == 200 && grpc_status.as_deref().map_or(true, |s| s == "0")
}

/// POST a framed gRPC message to `spot-pa` and return a JSON diagnostics object
/// (incl. the full response body as hex).
fn relay(token: &str, method: &str, frame: &[u8]) -> String {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => return format!("{{\"error\":{}}}", jstr(&format!("client build: {e}"))),
    };

    let resp = match client
        .post(build_spot_url(method))
        .header("content-type", "application/grpc")
        .header("te", "trailers")
        .header("authorization", format!("Bearer {token}"))
        .header("user-agent", UA)
        .header("grpc-accept-encoding", "gzip")
        .body(frame.to_vec())
        .send()
    {
        Ok(r) => r,
        Err(e) => return format!("{{\"phase\":\"fetch\",\"error\":{}}}", jstr(&e.to_string())),
    };

    let version = format!("{:?}", resp.version());
    let status = resp.status().as_u16();
    let h = |k: &str| {
        resp.headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let content_type = h("content-type");
    let server = h("server");
    let grpc_status = h("grpc-status");
    let grpc_message = h("grpc-message");
    let body = resp.bytes().map(|b| b.to_vec()).unwrap_or_default();

    let ok = call_ok(status, &grpc_status);

    format!(
        "{{\"http_version\":{},\"http_status\":{},\"content_type\":{},\"server\":{},\"grpc_status\":{},\"grpc_message\":{},\"body_len\":{},\"body_hex\":{},\"ok\":{}}}",
        jstr(&version),
        status,
        jopt(&content_type),
        jopt(&server),
        jopt(&grpc_status),
        jopt(&grpc_message),
        body.len(),
        jstr(&hex_all(&body)),
        ok,
    )
}

fn header_value(req: &tiny_http::Request, name: &str) -> Option<String> {
    // tiny_http's `HeaderField::equiv` wants a &'static str; compare case-
    // insensitively against the runtime header name instead.
    req.headers()
        .iter()
        .find(|hd| hd.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|hd| hd.value.as_str().to_string())
}

fn run_server(port: u16) {
    let server = Server::http(("0.0.0.0", port)).expect("bind server");
    eprintln!("spot-relay listening on 0.0.0.0:{port}");
    for mut req in server.incoming_requests() {
        let token = header_value(&req, "x-spot-token").or_else(|| std::env::var("SPOT_TOKEN").ok());
        let method =
            header_value(&req, "x-spot-method").unwrap_or_else(|| HEALTH_METHOD.to_string());

        let mut body: Vec<u8> = Vec::new();
        let _ = req.as_reader().read_to_end(&mut body);
        // No body → self-test frame (lets a Worker hit `/` as a health check).
        if body.is_empty() {
            body = build_health_frame();
        }

        let json = match token {
            Some(t) if !t.is_empty() => relay(&t, &method, &body),
            _ => "{\"error\":\"no token: send x-spot-token header or set SPOT_TOKEN\"}".to_string(),
        };
        let header = Header::from_bytes(&b"content-type"[..], &b"application/json"[..]).unwrap();
        let _ = req.respond(Response::from_string(json).with_header(header));
    }
}

fn main() {
    if let Ok(port) = std::env::var("PORT") {
        let port: u16 = port.parse().unwrap_or(8080);
        run_server(port);
    } else {
        let token = std::env::var("SPOT_TOKEN").expect("set SPOT_TOKEN for the self-test");
        println!("{}", relay(&token, HEALTH_METHOD, &build_health_frame()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_joins_host_and_method() {
        assert_eq!(
            build_spot_url("google.internal.spot.v1.SpotService/UploadPrecomputedPublicKeyIds"),
            "https://spot-pa.googleapis.com/google.internal.spot.v1.SpotService/UploadPrecomputedPublicKeyIds"
        );
    }

    #[test]
    fn health_frame_is_grpc_length_prefixed() {
        let f = build_health_frame();
        assert_eq!(f[0], 0x00); // uncompressed
        let len = u32::from_be_bytes([f[1], f[2], f[3], f[4]]) as usize;
        assert_eq!(len, 13);
        assert_eq!(f.len(), 5 + 13);
    }

    #[test]
    fn ok_requires_200_and_non_error_grpc_status() {
        assert!(call_ok(200, &None));
        assert!(call_ok(200, &Some("0".to_string())));
        assert!(!call_ok(200, &Some("14".to_string())));
        assert!(!call_ok(502, &None));
    }
}
