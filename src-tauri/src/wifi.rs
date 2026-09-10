//! WiFi access for Moonblast.
//!
//! The wlanapi path (Win32 `WlanEnumInterfaces` / `WlanQueryInterface` /
//! `WlanGetAvailableNetworkList`) is the "proper" way to read WiFi state on
//! Windows. In a long-lived Tauri process it returns `ERROR_NOT_FOUND` (1168)
//! for read opcodes — the wlan service's per-client cache goes stale. The
//! writes (`WlanSetInterface`) work fine, so the radio on/off still uses
//! that path.
//!
//! For reads, we shell out to `netsh wlan ...`, which always works:
//! - `netsh wlan show interfaces`     → current connection (chip)
//! - `netsh wlan show networks`       → visible networks (modal scan)
//! - `netsh wlan connect name=...`    → join a network with a saved profile
//!   or an open network
//! - `netsh wlan disconnect`          → leave the current network
//! - `netsh interface set interface`  → enable / disable the radio
//!
//! No UWP manifest, no permissions grant needed. Returns `None` from the
//! public commands when no WiFi adapter is present so the UI can skip the
//! chip, mirroring the battery behaviour.

#![cfg(windows)]

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::ptr;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::NetworkManagement::WiFi::{
    WlanCloseHandle, WlanEnumInterfaces, WlanOpenHandle, WlanQueryInterface, WlanScan,
    WlanSetInterface, WLAN_INTERFACE_INFO_LIST,
};
// `WLAN_INTF_OPCODE` is `type WLAN_INTF_OPCODE = i32` in windows-sys 0.59, and
// the constants are also `i32` — just pass the integer directly.
// wlan_intf_opcode_current_connection = 7.

const WLAN_CLIENT_VERSION_2: u32 = 2;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiConnection {
    /// UTF-8 SSID (already validated as UTF-8 when stored).
    pub ssid: String,
    /// 0–100.
    pub signal: u32,
    /// True if the AP requires a password.
    pub secured: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiNetwork {
    pub ssid: String,
    /// 0–100.
    pub signal: u32,
    pub secured: bool,
    /// True if the current connection is to this network.
    pub connected: bool,
    /// True if Windows already has a saved profile for it (auto-join on sight).
    pub known: bool,
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
/// We keep the strongest BSSID per SSID. Saved profiles and the currently
/// connected network are flagged from the interfaces output (run
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

/// alongside the scan so the chip and the modal agree on connection state).
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
    let output = std::process::Command::new("netsh")
        .args(["wlan", "show", "networks", "mode=bssid"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
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
                        connected,
                        known,
                    });
                }
            }
            // `SSID 1 : Foo Bar`  → take everything after the first colon.
            current_ssid_buf = rest
                .split_once(':')
                .map(|(_, v)| v.trim().to_string());
            current_auth = None;
            current_signal = 0;
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
                connected,
                known,
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
    // Suppress the unused warning for the borrowed `current` until
    // the next refactor adds UI-side usage.
    let _ = current;
    Some(networks)
}

/// Query the user's saved WiFi profiles (a profile is created the first
/// time you connect to a network, so this is the "known" set).
fn netsh_known_ssids() -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Ok(output) = std::process::Command::new("netsh")
        .args(["wlan", "show", "profiles"])
        .creation_flags(0x0800_0000)
        .output()
    else {
        return out;
    };
    if !output.status.success() {
        return out;
    }
    let text = String::from_utf8_lossy(&output.stdout);
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

/// Cheap, allocation-light call for the chip's polling. `None` means "no
/// WiFi adapter at all" — the UI should hide the chip in that case.
///
/// The wlanapi path is supposed to be the primary route, but in long-lived
/// Tauri processes the wlan service returns `ERROR_NOT_FOUND` (1168) for
/// `WlanGetAvailableNetworkList` even when `netsh` reports an active
/// connection. As a stopgap, we shell out to `netsh wlan show interfaces`
/// which always works. Cost is ~200ms per call; the chip polls every 30s
/// so the overhead is negligible.
pub fn current() -> Option<WifiConnection> {
    netsh_current_connection()
}

fn netsh_current_connection() -> Option<WifiConnection> {
    let output = std::process::Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut state: Option<String> = None;
    let mut ssid: Option<String> = None;
    let mut signal: Option<u32> = None;
    let mut auth: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
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
    if state.as_deref() != Some("connected") {
        return None;
    }
    let ssid = ssid?;
    if ssid.is_empty() {
        return None;
    }
    let signal = signal.unwrap_or(0).min(100);
    let secured = auth
        .as_deref()
        .map(|a| a.to_ascii_lowercase().contains("wpa") || a.contains("802.1X") || a == "WEP")
        .unwrap_or(false);
    Some(WifiConnection { ssid, signal, secured })
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
    let output = std::process::Command::new("netsh")
        .args(["wlan", "connect", &format!("name={ssid}")])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
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
    let output = std::process::Command::new("netsh")
        .args(["wlan", "disconnect"])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
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

/// Current radio state — reads via wlanapi (which works for the
/// radio-state opcode, even when other opcodes return 1168).
pub fn radio_state() -> Option<bool> {
    let client = shared_client()?;
    let guid = first_interface(client)?;
    unsafe {
        let mut data_size: u32 = 0;
        let mut data_ptr: *mut c_void = ptr::null_mut();
        let mut value_type: i32 = 0;
        let ok = WlanQueryInterface(
            client.handle(),
            &guid,
            4, // wlan_intf_opcode_radio_state
            ptr::null(),
            &mut data_size,
            &mut data_ptr,
            &mut value_type,
        );
        if ok != 0 || data_ptr.is_null() || data_size < 4 {
            return None;
        }
        let v = *(data_ptr as *const u32);
        windows_sys::Win32::System::Memory::HeapFree(
            windows_sys::Win32::System::Memory::GetProcessHeap(),
            0,
            data_ptr as *const c_void,
        );
        // 1 = on, 2 = off, 0 = unknown. Treat unknown as "on" so the UI
        // shows the right state by default.
        if v == 2 {
            Some(false)
        } else {
            Some(true)
        }
    }
}

/// Enable / disable the WiFi radio. Tries wlanapi first, falls back to
/// netsh interface admin if that fails (e.g. on Windows editions where
/// `WlanSetInterface` returns "access denied" to non-administrative
/// users — `netsh interface set interface "Wi-Fi" admin=...` works
/// without elevation for the user's own adapter).
pub fn set_radio(enabled: bool) -> Result<(), String> {
    if let Some(client) = shared_client() {
        if let Some(guid) = first_interface(client) {
            let value: u32 = if enabled { 1 } else { 2 };
            unsafe {
                let ok = WlanSetInterface(
                    client.handle(),
                    &guid,
                    4, // wlan_intf_opcode_radio_state
                    std::mem::size_of::<u32>() as u32,
                    &value as *const u32 as *const c_void,
                    ptr::null(),
                );
                if ok == 0 {
                    return Ok(());
                }
            }
        }
    }
    // Fallback: disable the network adapter via netsh. "Wi-Fi" is the
    // default interface name; the user can rename it, but for the common
    // case this works.
    let admin = if enabled { "enable" } else { "disable" };
    let output = std::process::Command::new("netsh")
        .args(["interface", "set", "interface", "Wi-Fi", &format!("admin={admin}")])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if msg.is_empty() {
            format!("radio toggle failed (exit {:?})", output.status.code())
        } else {
            msg
        })
    }
}
