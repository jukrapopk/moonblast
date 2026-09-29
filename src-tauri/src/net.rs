//! System connectivity + captive-portal detection.
//!
//! Two layers, each used where it's cheap:
//!
//! 1. **`connectivity()`** — Windows' own verdict, via the WinRT
//!    `Windows.Networking.Connectivity` `NetworkConnectivityLevel`. No network
//!    I/O of our own, so it rides along on the Wi-Fi chip's existing
//!    `wifi_current` read and can drive the chip's "no internet" state.
//!
//!    The docs are explicit that this is only a *hint*:
//!    `ConstrainedInternetAccess` is "possibly due to a captive portal. Or
//!    possibly due to some other reason" (a proxy rewriting headers), and a
//!    portal can equally show up as `LocalAccess`. So it decides *whether* to
//!    warn, never *what* the warning says.
//!
//! 2. **`probe_portal()`** — the active probe Windows' own NCSI performs,
//!    reproduced: one HTTP GET to the configured NCSI endpoint, expecting the
//!    configured payload. A captive portal answers it with a redirect (whose
//!    `Location` is the sign-in URL) or with a substituted/empty body — both
//!    mean "something rewrote the answer", which is the definition of a portal.
//!    Only called while the Wi-Fi modal is open *and* layer 1 already says "no
//!    internet", so a healthy network never pays for it.
//!
//! The endpoint itself is read from
//! `HKLM\SYSTEM\CurrentControlSet\Services\NlaSvc\Parameters\Internet`, where
//! Windows stores it (`ActiveWebProbeHost` / `ActiveWebProbePath` /
//! `ActiveWebProbeContent`), so private/enterprise probe servers are honoured
//! and our verdict matches the OS's. `EnableActiveProbing` is respected by not
//! making the request at all — the sign-in link is still offered, because
//! opening it is a user-initiated browser action, not a background beacon.

#![cfg(windows)]

use std::time::Duration;

use crate::moonblast_log;

/// Windows' verdict on the active connection (`NetworkConnectivityLevel`).
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Connectivity {
    /// Local and internet access.
    Internet,
    /// Limited internet access — usually a captive portal, but any
    /// header-rewriting middlebox lands here too.
    Constrained,
    /// Local network access only.
    Local,
    /// No connectivity.
    None,
}

/// Windows' connectivity verdict, optionally scoped to the WLAN profile we're
/// associated with.
///
/// `NetworkInformation` reports the *preferred* interface's profile ("most
/// likely to send or receive internet traffic"), which on a docked machine is
/// Ethernet even while the Wi-Fi sits on a captive portal — and the other way
/// round when the cable is dead but the Wi-Fi is fine. When the caller knows it
/// is associated with `ssid`, that WLAN profile is the honest one to ask.
///
/// Callers must run on a thread with a WinRT apartment (`ensure_winrt`) — the
/// `spawn_blocking` workers, never Tauri's main thread.
pub fn connectivity(ssid: Option<&str>) -> Option<Connectivity> {
    use windows::Networking::Connectivity::{NetworkConnectivityLevel, NetworkInformation};

    crate::radio::ensure_winrt();

    let profile = ssid
        .and_then(wlan_profile)
        .or_else(|| NetworkInformation::GetInternetConnectionProfile().ok())?;
    let level = profile.GetNetworkConnectivityLevel().ok()?;
    Some(match level {
        NetworkConnectivityLevel::InternetAccess => Connectivity::Internet,
        NetworkConnectivityLevel::ConstrainedInternetAccess => Connectivity::Constrained,
        NetworkConnectivityLevel::LocalAccess => Connectivity::Local,
        _ => Connectivity::None,
    })
}

/// The WLAN connection profile currently associated with `ssid`, if any.
///
/// Matching on the connected SSID (rather than taking the first WLAN profile)
/// keeps multi-radio machines honest — the codebase already documents DBS
/// adapters that report two interfaces ("Wi-Fi" + "Wi-Fi 3").
fn wlan_profile(ssid: &str) -> Option<windows::Networking::Connectivity::ConnectionProfile> {
    use windows::Networking::Connectivity::NetworkInformation;

    let profiles = NetworkInformation::GetConnectionProfiles().ok()?;
    let size = profiles.Size().ok()?;
    for i in 0..size {
        // A single profile that won't answer must not abort the whole scan.
        let Ok(profile) = profiles.GetAt(i) else {
            continue;
        };
        if !profile.IsWlanConnectionProfile().unwrap_or(false) {
            continue;
        }
        let Ok(details) = profile.WlanConnectionProfileDetails() else {
            continue;
        };
        let Ok(connected) = details.GetConnectedSsid() else {
            continue;
        };
        if connected.to_string().eq_ignore_ascii_case(ssid) {
            return Some(profile);
        }
    }
    None
}

/// Outcome of the NCSI-shaped probe.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PortalState {
    /// The endpoint answered with the expected content: real internet.
    Internet,
    /// Something between us and the internet rewrote or redirected the probe.
    Portal,
    /// The request never got an answer (DNS, route, timeout).
    Offline,
    /// We deliberately didn't probe (`EnableActiveProbing` is off).
    Unknown,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortalStatus {
    pub state: PortalState,
    /// Best-known sign-in URL: the portal's redirect target when it sent one,
    /// otherwise the probe URL itself — the portal intercepts that host, so
    /// opening it lands on the sign-in page. `None` when there's nothing to
    /// sign into.
    pub portal_url: Option<String>,
    /// Endpoint that was probed (scheme + host + path), for display and logs.
    pub probe_url: String,
}

/// True for a plain `http(s)://` URL.
///
/// The sign-in target comes from a redirect header supplied by whatever is on
/// the other end of the network — hostile by assumption — so it must never
/// reach `ShellExecuteW` as a `file:` / `ms-settings:` / custom-protocol
/// target. Also rejects control characters and spaces, which no real URL needs.
pub fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && !url.contains(['"', ' '])
        && !url.chars().any(|c| c.is_control())
}

/// The NCSI probe endpoint and expected payload, from the registry keys where
/// Windows keeps them, falling back to the documented public defaults.
/// Returns `(probing_enabled, url, expected_content)`.
fn probe_endpoint() -> (bool, String, String) {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    const KEY: &str = r"SYSTEM\CurrentControlSet\Services\NlaSvc\Parameters\Internet";

    let mut host = "www.msftconnecttest.com".to_string();
    let mut path = "connecttest.txt".to_string();
    let mut content = "Microsoft Connect Test".to_string();
    let mut enabled = true;
    if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(KEY) {
        if let Ok(v) = key.get_value::<String, _>("ActiveWebProbeHost") {
            if !v.trim().is_empty() {
                host = v.trim().to_string();
            }
        }
        if let Ok(v) = key.get_value::<String, _>("ActiveWebProbePath") {
            if !v.trim().is_empty() {
                path = v.trim().trim_start_matches('/').to_string();
            }
        }
        if let Ok(v) = key.get_value::<String, _>("ActiveWebProbeContent") {
            content = v;
        }
        if let Ok(v) = key.get_value::<u32, _>("EnableActiveProbing") {
            enabled = v != 0;
        }
    }
    (enabled, format!("http://{host}/{path}"), content)
}

/// Reproduce NCSI's active probe: one GET against the configured endpoint,
/// expecting the configured payload back.
///
/// Redirects are deliberately *not* followed — a captive portal answers with a
/// 302 whose `Location` **is** the sign-in URL we want to hand the user, and
/// the body check covers the other documented shape (portals that substitute
/// or empty the payload instead of redirecting).
pub fn probe_portal() -> PortalStatus {
    let (enabled, probe_url, expected) = probe_endpoint();
    if !enabled {
        moonblast_log!("portal probe: EnableActiveProbing=0 — not probing");
        return PortalStatus {
            state: PortalState::Unknown,
            portal_url: Some(probe_url.clone()),
            probe_url,
        };
    }
    probe_target(&probe_url, &expected)
}

/// The probe itself, against an explicit endpoint/payload — split out so the
/// endpoint resolution stays trivial and the request logic is testable.
fn probe_target(probe_url: &str, expected: &str) -> PortalStatus {
    let probe_url = probe_url.to_string();
    let agent = ureq::builder()
        .redirects(0)
        .timeout(Duration::from_secs(4))
        .build();
    // With `redirects(0)` a 3xx may come back as `Ok` or as `Error::Status`
    // depending on the agent's handling; normalise both into (status, response).
    let (status, response) = match agent.get(&probe_url).call() {
        Ok(r) => (r.status(), r),
        Err(ureq::Error::Status(code, r)) => (code, r),
        Err(ureq::Error::Transport(e)) => {
            moonblast_log!("portal probe: {probe_url} unreachable: {e}");
            return PortalStatus {
                state: PortalState::Offline,
                portal_url: None,
                probe_url,
            };
        }
    };

    if (300..400).contains(&status) {
        // The classic captive-portal answer. A relative or malformed target
        // falls back to the probe URL (which the portal intercepts anyway).
        let location = response
            .header("location")
            .map(str::to_string)
            .filter(|l| is_http_url(l));
        moonblast_log!("portal probe: status {status} location={location:?} — captive portal");
        return PortalStatus {
            state: PortalState::Portal,
            portal_url: location.or_else(|| Some(probe_url.clone())),
            probe_url,
        };
    }

    if status == 200 {
        let body = response.into_string().unwrap_or_default();
        if body.trim() == expected.trim() {
            return PortalStatus {
                state: PortalState::Internet,
                portal_url: None,
                probe_url,
            };
        }
    }

    // Anything else — a substituted or empty body, a proxy's 403, a 5xx:
    // something answered, and it wasn't the internet.
    moonblast_log!("portal probe: unexpected answer (status {status}) — treating as portal");
    PortalStatus {
        state: PortalState::Portal,
        portal_url: Some(probe_url.clone()),
        probe_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// Minimal one-shot HTTP responder — `response` is written to the first
    /// connection, so a test can pose as a healthy endpoint or as a portal.
    fn serve_once(response: &'static [u8]) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf);
                let _ = sock.write_all(response);
            }
        });
        format!("http://{addr}/connecttest.txt")
    }

    #[test]
    fn expected_payload_is_internet() {
        let url = serve_once(
            b"HTTP/1.1 200 OK\r\nContent-Length: 22\r\nConnection: close\r\n\r\nMicrosoft Connect Test",
        );
        let s = probe_target(&url, "Microsoft Connect Test");
        println!("healthy -> {s:?}");
        assert_eq!(s.state, PortalState::Internet);
        assert!(s.portal_url.is_none());
    }

    #[test]
    fn redirect_is_a_portal_with_the_location() {
        let url = serve_once(
            b"HTTP/1.1 302 Found\r\nLocation: http://portal.test/signin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let s = probe_target(&url, "Microsoft Connect Test");
        println!("redirect -> {s:?}");
        assert_eq!(s.state, PortalState::Portal);
        assert_eq!(s.portal_url.as_deref(), Some("http://portal.test/signin"));
    }

    #[test]
    fn substituted_body_is_a_portal() {
        let url = serve_once(
            b"HTTP/1.1 200 OK\r\nContent-Length: 21\r\nConnection: close\r\n\r\n<html>sign in</html>\n",
        );
        let s = probe_target(&url, "Microsoft Connect Test");
        println!("substituted -> {s:?}");
        assert_eq!(s.state, PortalState::Portal);
        assert_eq!(s.portal_url.as_deref(), Some(url.as_str()));
    }

    #[test]
    fn hostile_redirect_scheme_falls_back_to_the_probe_url() {
        let url = serve_once(
            b"HTTP/1.1 302 Found\r\nLocation: ms-settings:network-wifi\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let s = probe_target(&url, "Microsoft Connect Test");
        println!("hostile location -> {s:?}");
        assert_eq!(s.state, PortalState::Portal);
        assert_eq!(s.portal_url.as_deref(), Some(url.as_str()));
    }
}