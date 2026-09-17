//! WiFi access for Moonblast.
//!
//! The wlanapi path (Win32 `WlanEnumInterfaces` / `WlanQueryInterface` /
//! `WlanGetAvailableNetworkList`) is the "proper" way to read WiFi state on
//! Windows. In a long-lived Tauri process it returns `ERROR_NOT_FOUND` (1168)
//! for read opcodes — the wlan service's per-client cache goes stale. Only
//! the `WlanScan` write opcode is reliable; the read opcodes don't survive
//! multiple opens, so we shell out to `netsh` for everything that reads.
//! Radio on/off (`set_radio`) goes through the shared `Windows.Devices.Radios`
//! helper in `radio.rs` (`RadioKind::WiFi`) — the same WinRT API used for
//! Bluetooth's radio toggle and Windows' own Quick Settings toggle.
//!
//! `netsh wlan ...` — the reliable read path:
//! - `netsh wlan show interfaces`     → current connection (chip)
//! - `netsh wlan show networks`       → visible networks (modal scan)
//! - `netsh wlan connect name=...`    → join a network with a saved profile
//!   or an open network
//! - `netsh wlan disconnect`          → leave the current network
//!
//! No UWP manifest, no permissions grant needed. Returns `None` from the
//! public commands when no WiFi adapter is present so the UI can skip the
//! chip, mirroring the battery behaviour.

#![cfg(windows)]

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::process::{Command, Output};
use std::ptr;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::NetworkManagement::WiFi::{
    WlanCloseHandle, WlanEnumInterfaces, WlanOpenHandle, WlanScan, WLAN_INTERFACE_INFO_LIST,
};
// `WLAN_INTF_OPCODE` is `type WLAN_INTF_OPCODE = i32` in windows-sys 0.59, and
// the constants are also `i32` — just pass the integer directly.
// wlan_intf_opcode_current_connection = 7.

const WLAN_CLIENT_VERSION_2: u32 = 2;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiConnection {
    /// UTF-8 SSID (already validated as UTF-8 when stored).
    /// Empty when not connected.
    pub ssid: String,
    /// 0–100. 0 when not connected.
    pub signal: u32,
    /// True if the AP requires a password.
    pub secured: bool,
    /// True if a network is currently associated.
    pub connected: bool,
    /// True if the radio is on. When false, the adapter exists but is
    /// off — the UI shows a WifiX chip (still clickable, so the user
    /// can open the picker / OS settings). `None` (no `WifiConnection`
    /// at all) means no adapter — the chip stays hidden.
    pub radio_on: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiNetwork {
    pub ssid: String,
    /// 0–100.
    pub signal: u32,
    pub secured: bool,
    /// Raw auth string from the netsh scan, e.g. "WPA2-Personal" or
    /// "WEP". `None` for open networks.
    pub auth: Option<String>,
    /// True if the current connection is to this network.
    pub connected: bool,
    /// True if Windows already has a saved profile for it (auto-join on sight).
    pub known: bool,
    /// WiFi generation number (4/5/6/7) of the best BSSID — the
    /// generation number the network is *capable* of. Drives the small
    /// "6" / "5" badge in the modal row. `None` when unknown
    /// (e.g. legacy or unparseable "Radio type" line).
    pub gen: Option<u8>,
}

/// RAII wrapper for the WLAN client handle; closes on drop.
struct WlanClient(HANDLE);
// The wlanapi.dll API is documented as thread-safe — a single client handle
// may be used concurrently from multiple threads. The raw HANDLE is `!Send`
// because the type system doesn't know that, so we declare it ourselves.
unsafe impl Send for WlanClient {}
unsafe impl Sync for WlanClient {}
impl WlanClient {
    fn open() -> Option<Self> {
        unsafe {
            let mut handle: HANDLE = ptr::null_mut();
            let mut negotiated = 0;
            let ok = WlanOpenHandle(
                WLAN_CLIENT_VERSION_2,
                ptr::null(),
                &mut negotiated,
                &mut handle,
            );
            if ok != 0 || handle.is_null() {
                return None;
            }
            Some(Self(handle))
        }
    }
    fn handle(&self) -> HANDLE {
        self.0
    }
}
impl Drop for WlanClient {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { WlanCloseHandle(self.0, ptr::null()) };
        }
    }
}

/// Process-wide cached WLAN client. The wlan service appears to invalidate
/// the per-client cache when `WlanCloseHandle` is called repeatedly (we get
/// ERROR_NOT_FOUND for queries that work fine in a single-shot CLI probe).
/// Keeping one client open for the lifetime of the Tauri process avoids
/// the open/close churn and makes the cache behave. `WlanClient` is
/// `Send + Sync` (the wlanapi.dll API is thread-safe).
static WLAN_CLIENT: OnceLock<WlanClient> = OnceLock::new();

fn shared_client() -> Option<&'static WlanClient> {
    if let Some(c) = WLAN_CLIENT.get() {
        return Some(c);
    }
    let c = WlanClient::open()?;
    WLAN_CLIENT.set(c).ok()?;
    Some(WLAN_CLIENT.get().unwrap())
}

/// Returns the first WiFi interface GUID, or `None` if the system has no
/// WiFi adapter. Picks the first one — most PCs have at most one; laptops
/// with multiple rarely exist.
fn first_interface(client: &WlanClient) -> Option<windows_sys::core::GUID> {
    unsafe {
        let mut list_ptr: *mut WLAN_INTERFACE_INFO_LIST = ptr::null_mut();
        let ok = WlanEnumInterfaces(client.handle(), ptr::null(), &mut list_ptr);
        if ok != 0 || list_ptr.is_null() {
            return None;
        }
        let count = (*list_ptr).dwNumberOfItems;
        let result = if count > 0 {
            let first = list_ptr.add(1) as *const u8;
            let guid_ptr = first as *const windows_sys::core::GUID;
            Some(*guid_ptr)
        } else {
            None
        };
        windows_sys::Win32::System::Memory::HeapFree(
            windows_sys::Win32::System::Memory::GetProcessHeap(),
            0,
            list_ptr as *const c_void,
        );
        result
    }
}

/// Visible network list. Shells out to `netsh wlan show networks mode=bssid`
/// which is reliable in long-lived Tauri processes (the wlanapi path
/// returns ERROR_NOT_FOUND / 1168 for the same query). The output looks
/// like:
///
/// ```text
/// SSID 1 : MyNetwork
///     Network type            : Infrastructure
///     Authentication          : WPA2-Personal
///     Encryption               : CCMP
///     BSSID 1                 : aa:bb:cc:dd:ee:ff
///          Signal             : 94%
///          ...
/// ```
///
/// `netsh` writes its output in whatever encoding the host's console
/// code page is set to. Most modern Windows installs land on UTF-8 but
/// some ARM64 / locale-specific installs end up at UTF-16LE, in which
/// case `String::from_utf8_lossy` would see `S\0S\0I\0D\0` and our
/// `strip_prefix("SSID")` would either miss (nulls in the middle) or
/// pick up `ssid` values laced with `\0` bytes. The symptom is the
/// chip showing "no connection" while the user is clearly connected.
/// `decode_netsh` sniffs for UTF-16LE first and falls back to UTF-8.
///
/// Ask the wlan driver to refresh its visible-network cache. Fire-and-forget:
/// `WlanScan` returns immediately and the scan runs asynchronously; the cache
/// is updated within ~1-2s. Errors are ignored — if the scan can't be
/// triggered, the next netsh read will just return the cached list.
fn trigger_scan() {
    let Some(client) = shared_client() else { return };
    let Some(guid) = first_interface(client) else { return };
    unsafe {
        let _ = WlanScan(
            client.handle(),
            &guid,
            ptr::null(),
            ptr::null(),
            ptr::null(),
        );
    }
}

/// alongside the scan so the chip and the modal agree on connection state.
/// Each entry is deduplicated by SSID, keeping the strongest BSSID.
pub fn scan_and_list() -> Option<Vec<WifiNetwork>> {
    // `netsh wlan show networks` only returns whatever the wlan service
    // already has in its cache — it doesn't trigger a scan itself. The
    // wlan service, in turn, only refreshes the cache opportunistically
    // (e.g. on connect/disconnect). Without an explicit scan, the list
    // stays at just the currently-connected network.
    //
    // We use `WlanScan` to ask the driver for a fresh scan. The driver
    // updates the visible-network cache within ~1-2s; we then read it
    // via `netsh` (which always works in this process, unlike the
    // read-side wlanapi opcodes).
    trigger_scan();
    std::thread::sleep(std::time::Duration::from_millis(2500));
    let text = netsh_text(&["wlan", "show", "networks", "mode=bssid"])?;
    let mut networks: Vec<WifiNetwork> = Vec::new();
    let mut current_ssid: Option<String> = None;
    if let Some(c) = netsh_current_connection() {
        current_ssid = Some(c.ssid);
    }
    // Saved-profile set: any SSID in `netsh wlan show profiles` is "known"
    // to Windows. Cheap to read in the same hot path.
    let known_ssids = netsh_known_ssids();

    let mut current_ssid_buf: Option<String> = None;
    let mut current_auth: Option<String> = None;
    // Track the strongest signal seen so far for the current SSID. The
    // netsh output lists each BSSID separately under one SSID block, so
    // we keep the best of them.
    let mut current_signal: u32 = 0;
    // Best WiFi generation seen across this SSID's BSSIDs (drives the
    // "4" / "5" / "6" / "7" badge in the modal row).
    let mut current_gen: Option<u8> = None;
    // The first `SSID N :` line introduces a new network. Sub-indented
    // fields (4 leading spaces) belong to that network until the next SSID.
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("SSID ") {
            // Flush the previous network (if any).
            if let Some(ssid) = current_ssid_buf.take() {
                if !ssid.is_empty() {
                    let connected = current_ssid.as_deref() == Some(&ssid);
                    let known = known_ssids.contains(&ssid);
                    let secured = current_auth
                        .as_deref()
                        .map(|a| {
                            let a = a.to_ascii_lowercase();
                            a.contains("wpa") || a.contains("wep") || a.contains("802.1x")
                        })
                        .unwrap_or(false);
                    networks.push(WifiNetwork {
                        ssid,
                        signal: current_signal.min(100),
                        secured,
                        auth: current_auth.clone(),
                        connected,
                        known,
                        gen: current_gen,
                    });
                }
            }
            // `SSID 1 : Foo Bar`  → take everything after the first colon.
            current_ssid_buf = rest
                .split_once(':')
                .map(|(_, v)| v.trim().to_string());
            current_auth = None;
            current_signal = 0;
            current_gen = None;
        } else if let Some(rest) = trimmed.strip_prefix("Authentication") {
            if let Some(v) = rest.split_once(':').map(|(_, v)| v.trim().to_string()) {
                // "Open" means no auth required → secured = false.
                if v.eq_ignore_ascii_case("Open") {
                    current_auth = None;
                } else {
                    current_auth = Some(v);
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("Signal") {
            if let Some(s) = rest
                .split_once(':')
                .and_then(|(_, v)| v.trim().trim_end_matches('%').parse::<u32>().ok())
            {
                if s > current_signal {
                    current_signal = s;
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("Radio type") {
            // Map "802.11n" / "802.11ac" / "802.11ax" / "802.11be" to a
            // generation number. "802.11a/b/g" (legacy) maps to 3.
            // Take the max across BSSIDs so the row shows what the
            // network is *capable* of, not what the user is currently
            // associated with.
            if let Some((_, v)) = rest.split_once(':') {
                let g: u8 = match v.trim() {
                    "802.11b" | "802.11g" | "802.11a" => 3,
                    "802.11n" => 4,
                    "802.11ac" => 5,
                    "802.11ax" => 6,
                    "802.11be" => 7,
                    _ => 0,
                };
                if g > 0 && current_gen.map_or(true, |cur| g > cur) {
                    current_gen = Some(g);
                }
            }
        }
    }
    // Flush the last network.
    if let Some(ssid) = current_ssid_buf.take() {
        if !ssid.is_empty() {
            let connected = current_ssid.as_deref() == Some(&ssid);
            let known = known_ssids.contains(&ssid);
            let secured = current_auth
                .as_deref()
                .map(|a| {
                    let a = a.to_ascii_lowercase();
                    a.contains("wpa") || a.contains("wep") || a.contains("802.1x")
                })
                .unwrap_or(false);
            networks.push(WifiNetwork {
                ssid,
                signal: current_signal.min(100),
                secured,
                auth: current_auth.clone(),
                connected,
                known,
                gen: current_gen,
            });
        }
    }
    // Deduplicate by SSID, keeping the strongest signal.
    networks.sort_by(|a, b| b.signal.cmp(&a.signal));
    networks.dedup_by(|a, b| a.ssid == b.ssid);
    // Sort: connected → known → strongest signal.
    networks.sort_by(|a, b| {
        b.connected
            .cmp(&a.connected)
            .then_with(|| b.known.cmp(&a.known))
            .then_with(|| b.signal.cmp(&a.signal))
    });
    Some(networks)
}

/// Query the user's saved WiFi profiles (a profile is created the first
/// time you connect to a network, so this is the "known" set).
fn netsh_known_ssids() -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Some(text) = netsh_text(&["wlan", "show", "profiles"]) else {
        return out;
    };
    for line in text.lines() {
        let trimmed = line.trim();
        // "All User Profile     : Foo Bar" or "Profiles on interface Wi-Fi:"
        // followed by indented "Foo Bar".
        if let Some(rest) = trimmed.strip_prefix("All User Profile") {
            if let Some((_, v)) = rest.split_once(':') {
                let name = v.trim();
                if !name.is_empty() && name != " profiles" {
                    out.insert(name.to_string());
                }
            }
        }
    }
    out
}

/// Cheap call for the chip's event-driven reads. `None` means "no
/// WiFi adapter at all" — the UI should hide the chip in that case.
///
/// The wlanapi path is supposed to be the primary route, but in long-lived
/// Tauri processes the wlan service returns `ERROR_NOT_FOUND` (1168) for
/// `WlanGetAvailableNetworkList` even when `netsh` reports an active
/// connection. As a stopgap, we shell out to `netsh wlan show interfaces`
/// which always works. Cost is ~200ms per call; reads happen on window
/// focus / modal open, so the overhead is negligible.
pub fn current() -> Option<WifiConnection> {
    netsh_current_connection()
}

/// Decode the raw bytes from `netsh` into a UTF-8 String. Detects UTF-16LE
/// (some Windows / ARM64 installs emit this when the console code page
/// is set to UTF-16) and falls back to UTF-8 lossy otherwise.
///
/// Heuristic: if the bytes start with the UTF-16LE BOM (`FF FE`), or
/// they look like "ASCII chars with a null between each" (every odd
/// byte is 0 in the first ~256 bytes), decode as UTF-16LE. Otherwise
/// treat as UTF-8. The ASCII-with-nulls test catches the case where
/// Trim `netsh wlan show interfaces` output to just the primary
/// (first) interface block. Multi-radio adapters (e.g.Qualcomm
/// FastConnect 6900 DBS) report two interfaces — `Wi-Fi` (primary)
/// and `Wi-Fi 3` (secondary) — and our parser walks every line in
/// sequence. If the secondary interface is disconnected, its
/// `State    : disconnected` line overwrites the primary's
/// `State    : connected` and the chip shows "not connected".
///
/// The interface blocks are separated by a blank line and each
/// starts with `Name :`. The preamble before the first block
/// (`There is N interface on the system:`) doesn't contain any field
/// lines we'd match against, so it's safe to include.
fn primary_interface_block(text: &str) -> &str {
    let mut count = 0usize;
    let mut cut_byte = text.len();
    for (i, line) in text.lines().enumerate() {
        if line.trim_start().starts_with("Name ") && line.contains(':') {
            count += 1;
            if count == 2 {
                // Sum the byte lengths of all lines before `i`, plus
                // the newlines that `.lines()` consumed. This gives
                // us a stable byte offset into `text`.
                cut_byte = text
                    .lines()
                    .take(i)
                    .map(|l| l.len() + 1) // +1 for the '\n' .lines() ate
                    .sum();
                break;
            }
        }
    }
    &text[..cut_byte]
}

/// Run `netsh <args>` with `CREATE_NO_WINDOW` and return the raw output,
/// or `None` on spawn failure / non-zero exit. Every netsh read in this
/// module collapses to one of these two helpers.
fn netsh(args: &[&str]) -> Option<Output> {
    Command::new("netsh")
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .ok()
}
fn netsh_text(args: &[&str]) -> Option<String> {
    let out = netsh(args)?;
    if !out.status.success() {
        return None;
    }
    Some(decode_netsh(&out.stdout))
}

/// `netsh` doesn't emit a BOM but is still UTF-16LE (which it does on
/// some Windows builds).
fn decode_netsh(bytes: &[u8]) -> String {
    let utf16le = bytes.starts_with(&[0xFF, 0xFE])
        || (bytes.len() >= 16 && {
            // Count "ASCII + null" pairs in the first 64 bytes (32 chars).
            // If the majority are paired, it's UTF-16LE with no BOM.
            let window = &bytes[..bytes.len().min(64)];
            let pairs = window
                .chunks_exact(2)
                .filter(|c| c[1] == 0 && (0x20..=0x7E).contains(&c[0]) || c[0] == 0x0D || c[0] == 0x0A)
                .count();
            // At least 60% of pairs are "ASCII char + NUL" or line ending.
            pairs * 2 >= (window.len() * 60) / 100
        });
    if utf16le {
        // Strip BOM if present, then decode.
        let stripped = bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes);
        let wide: Vec<u16> = stripped
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&wide)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn netsh_current_connection() -> Option<WifiConnection> {
    let output = netsh(&["wlan", "show", "interfaces"])?;
    if !output.status.success() {
        return None;
    }
    let decoded = decode_netsh(&output.stdout);
    let text = primary_interface_block(&decoded);
    let mut state: Option<String> = None;
    let mut ssid: Option<String> = None;
    let mut signal: Option<u32> = None;
    let mut auth: Option<String> = None;
    // `Radio status` spans two lines when HW/SW differ:
    //   Radio status           : Hardware On
    //                            Software Off
    // The radio is on only when BOTH are on — any `Off` means off.
    // Collect the first line's value plus any continuation lines
    // (indented, no colon) that follow it.
    let mut radio_values: Vec<String> = Vec::new();
    let mut in_radio = false;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if let Some(rest) = line.strip_prefix("Radio status") {
            in_radio = true;
            if let Some(v) = rest.split(':').nth(1) {
                radio_values.push(v.trim().to_string());
            }
            continue;
        }
        if in_radio {
            if line.is_empty() {
                in_radio = false;
                continue;
            }
            if line.contains(':') {
                // Next key — end of the radio block; fall through
                // to normal parsing below.
                in_radio = false;
            } else {
                // Continuation line, e.g. "Software Off".
                radio_values.push(line.to_string());
                continue;
            }
        }
        if let Some(rest) = line.strip_prefix("State") {
            state = rest.split(':').nth(1).map(|s| s.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("SSID") {
            ssid = rest.split(':').nth(1).map(|s| s.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Signal") {
            signal = rest
                .split(':')
                .nth(1)
                .and_then(|s| s.trim().trim_end_matches('%').parse().ok());
        } else if let Some(rest) = line.strip_prefix("Authentication") {
            auth = rest.split(':').nth(1).map(|s| s.trim().to_string());
        }
    }
    let radio_on = if radio_values.iter().any(|v| v.contains("Off")) {
        Some(false)
    } else if radio_values.iter().any(|v| v.contains("On")) {
        Some(true)
    } else {
        None
    };
    // Connected implies the radio is on even if the `Radio status`
    // line was missing. Radio explicitly off → still return `Some`
    // so the UI can show a WifiX chip. `None` only when we can't
    // tell an adapter exists at all (chip stays hidden).
    let connected = state.as_deref() == Some("connected");
    let radio_on_bool = if connected { true } else { match radio_on {
        Some(v) => v,
        None => return None,
    } };
    let (ssid, signal) = if connected {
        (
            ssid.unwrap_or_default(),
            signal.unwrap_or(0).min(100),
        )
    } else {
        (String::new(), 0)
    };
    let secured = auth
        .as_deref()
        .map(|a| a.to_ascii_lowercase().contains("wpa") || a.contains("802.1X") || a == "WEP")
        .unwrap_or(false);
    Some(WifiConnection {
        ssid,
        signal,
        secured,
        connected,
        radio_on: radio_on_bool,
    })
}

/// Connect to a WiFi network by SSID. Works for:
///   - Open networks (no auth).
///   - Networks with a saved Windows profile (the password was already
///     entered the first time the user connected; `netsh wlan connect`
///     just tells Windows to use it).
///
/// For a secured network WITHOUT a saved profile, this returns
/// `Err("profile required")` — the UI should fall back to opening
/// Windows WiFi settings so the user can enter the password there.
pub fn connect(ssid: &str) -> Result<(), String> {
    if ssid.is_empty() {
        return Err("empty SSID".into());
    }
    let output = netsh(&["wlan", "connect", &format!("name={ssid}")])
        .ok_or_else(|| "could not launch netsh".to_string())?;
    if output.status.success() {
        return Ok(());
    }
    // netsh reports failure as either an error string in stdout or an
    // exit code with a human-readable message. The most common case for
    // a "secured but unknown network" is "There is no wireless network
    // profile for this connection" or similar.
    let mut msg = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if msg.is_empty() {
        msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
    }
    // Trim the leading "There is no wireless network..." wrapper so the
    // UI gets a clean reason.
    if let Some(stripped) = msg.strip_prefix("There is no wireless network ") {
        msg = stripped.to_string();
    }
    if msg.is_empty() {
        msg = format!("connect failed (exit {:?})", output.status.code());
    }
    Err(msg)
}

/// Disconnect from the current WiFi network.
pub fn disconnect() -> Result<(), String> {
    let output = netsh(&["wlan", "disconnect"]).ok_or_else(|| "could not launch netsh".to_string())?;
    if output.status.success() {
        return Ok(());
    }
    // "There is no wireless network interface on the system." is a fine
    // "not connected" outcome — treat as success.
    let out = String::from_utf8_lossy(&output.stdout);
    if out.to_lowercase().contains("not connected") {
        return Ok(());
    }
    Err(out.trim().to_string())
}

/// Turn the WiFi radio on or off, via the shared `Windows.Devices.Radios`
/// helper (the same API Windows' own Quick Settings toggle uses). Can't
/// override a physical hardware kill switch if the machine has one —
/// Windows reports that as a denied request, surfaced here as an `Err`.
pub fn set_radio(on: bool) -> Result<(), String> {
    crate::radio::set_radio(windows::Devices::Radios::RadioKind::WiFi, on)
}

/// Delete a saved WiFi profile ("forget" the network). No-op when no
/// profile exists for the SSID — forgetting is idempotent.
pub fn forget(ssid: &str) -> Result<(), String> {
    if ssid.is_empty() {
        return Err("empty SSID".into());
    }
    let output = netsh(&["wlan", "delete", "profile", &format!("name={ssid}")])
        .ok_or_else(|| "could not launch netsh".to_string())?;
    if output.status.success() {
        return Ok(());
    }
    // "Profile ... is not found on any interface." — already forgotten.
    let out = String::from_utf8_lossy(&output.stdout);
    if out.to_lowercase().contains("not found") {
        return Ok(());
    }
    let msg = out.trim().to_string();
    Err(if msg.is_empty() {
        format!("forget failed (exit {:?})", output.status.code())
    } else {
        msg
    })
}

/// Connect to a secured network that needs a fresh password. We build a
/// temporary profile XML, register it with `netsh wlan add profile`, then
/// `netsh wlan connect` to that profile. The profile sticks around after
/// connect — that's the point: next time the user opens the picker, the
/// SSID is in the "Saved" set.
pub fn connect_with_password(
    ssid: &str,
    password: &str,
    auth: &str,
) -> Result<(), String> {
    if ssid.is_empty() {
        return Err("empty SSID".into());
    }
    if password.is_empty() {
        return Err("empty password".into());
    }

    // Map our auth-string to the profile XML's <authentication>. Only
    // Personal / PSK networks take a single password. Anything else
    // (Enterprise, OWE) needs a different flow that the user can
    // complete in the Windows Wi-Fi settings.
    let auth_xml = match auth.to_ascii_lowercase().as_str() {
        "wpa2-personal" | "wpa2psk" => "WPA2PSK",
        "wpa3-personal" | "wpa3sae" => "WPA3SAE",
        "wpa-personal" | "wpapsk" => "WPAPSK",
        "wep" => "shared",
        _ => {
            return Err(format!(
                "auth '{}' not supported in-app; open Windows Wi-Fi settings",
                auth
            ));
        }
    };
    let encryption = match auth_xml {
        "WPA3SAE" | "WPA2PSK" | "WPAPSK" => "AES",
        "shared" => "WEP",
        _ => "AES",
    };

    // SSID hex encoding (each byte → two hex chars). Windows stores the
    // SSID both in hex (canonical) and as the human-readable name.
    let mut ssid_hex = String::with_capacity(ssid.len() * 2);
    for b in ssid.as_bytes() {
        ssid_hex.push_str(&format!("{:02X}", b));
    }

    // Escape XML special chars in the password and the human-readable SSID.
    // (Hex form is safe — it's only hex digits.)
    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    let xml = format!(
        r#"<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>{name}</name>
    <SSIDConfig>
        <SSID>
            <hex>{hex}</hex>
            <name>{name}</name>
        </SSID>
    </SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>auto</connectionMode>
    <MSM>
        <security>
            <authEncryption>
                <authentication>{auth}</authentication>
                <encryption>{enc}</encryption>
                <useOneX>false</useOneX>
            </authEncryption>
            <sharedKey>
                <keyType>passPhrase</keyType>
                <protected>false</protected>
                <keyMaterial>{pw}</keyMaterial>
            </sharedKey>
        </security>
    </MSM>
</WLANProfile>
"#,
        name = xml_escape(ssid),
        hex = ssid_hex,
        auth = auth_xml,
        enc = encryption,
        pw = xml_escape(password),
    );

    // Write the profile to a temp file. Use a unique suffix so
    // concurrent calls don't collide.
    let path = std::env::temp_dir()
        .join(format!("moonblast-wifi-{}.xml", rand_suffix()));
    if let Err(e) = std::fs::write(&path, xml.as_bytes()) {
        return Err(format!("could not write profile xml: {e}"));
    }

    // Register the profile. netsh expects `filename=`; quoting the
    // path handles spaces.
    let add = netsh(&[
        "wlan",
        "add",
        "profile",
        &format!("filename=\"{}\"", path.display()),
    ])
    .ok_or_else(|| "could not launch netsh".to_string())?;
    if !add.status.success() {
        let _ = std::fs::remove_file(&path);
        return Err(format!(
            "could not register profile: {}",
            String::from_utf8_lossy(&add.stdout).trim()
        ));
    }

    // Now actually connect. The profile is now discoverable by name.
    let connect =
        netsh(&["wlan", "connect", &format!("name={ssid}")])
            .ok_or_else(|| "could not launch netsh".to_string())?;
    let _ = std::fs::remove_file(&path);
    if connect.status.success() {
        return Ok(());
    }
    // netsh reported failure. The most common case is wrong password,
    // which it surfaces as a generic "Connection request was not
    // completed" message. We don't try to interpret the message —
    // the UI shows it as-is.
    let mut msg = String::from_utf8_lossy(&connect.stdout).trim().to_string();
    if msg.is_empty() {
        msg = String::from_utf8_lossy(&connect.stderr).trim().to_string();
    }
    if msg.is_empty() {
        msg = format!("connect failed (exit {:?})", connect.status.code());
    }
    Err(msg)
}

/// Random 16-char hex suffix for temp file names. Not cryptographic —
/// just enough to avoid collisions between concurrent calls.
fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}", nanos & 0xFFFFFFFFFFFFFFFF)
}

