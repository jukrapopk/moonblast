//! WiFi access via the Win32 WLAN API (`wlanapi.dll`).
//!
//! No UWP manifest, no permissions grant — `WlanOpenHandle` works for any
//! process the user runs interactively. Returns `None` from the public
//! commands when no WiFi adapter is present (desktops, VMs) so the UI can
//! simply skip the chip, mirroring the battery behaviour.
//!
//! `WlanEnumInterfaces` + `WlanQueryInterface` give us the current
//! connection cheaply (called from the chip's 30s poll). The visible-network
//! list is requested on demand from the picker modal — `WlanScan` first
//! (~1s) then `WlanGetAvailableNetworkList` (~100ms), so opening the modal
//! shows fresh data without making the chip update expensive.

#![cfg(windows)]

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::ptr;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::NetworkManagement::WiFi::{
    WlanCloseHandle, WlanEnumInterfaces, WlanGetAvailableNetworkList, WlanOpenHandle,
    WlanScan, DOT11_SSID, WLAN_AVAILABLE_NETWORK, WLAN_AVAILABLE_NETWORK_CONNECTED,
    WLAN_AVAILABLE_NETWORK_HAS_PROFILE, WLAN_AVAILABLE_NETWORK_LIST, WLAN_INTERFACE_INFO_LIST,
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

/// Decode a `DOT11_SSID` into a UTF-8 string. Falls back to the raw bytes
/// (lossily) if it isn't valid UTF-8 — WiFi SSIDs are nominally UTF-8 but
/// some routers put garbage in them.
fn ssid_to_string(ssid: &DOT11_SSID) -> String {
    let len = ssid.uSSIDLength as usize;
    let bytes = &ssid.ucSSID[..len.min(ssid.ucSSID.len())];
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| {
        String::from_utf8_lossy(bytes).into_owned()
    })
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

/// Visible network list. `WlanScan` is fire-and-forget — the result list
/// reflects whatever's currently cached plus anything that arrives within
/// the next ~1s. We request a fresh scan first to get a complete picture.
pub fn scan_and_list() -> Option<Vec<WifiNetwork>> {
    let client = shared_client()?;
    let guid = first_interface(client)?;
    unsafe {
        // Best-effort fresh scan. Errors here are non-fatal — the cached
        // list is still useful.
        let _ = WlanScan(
            client.handle(),
            &guid,
            ptr::null(),
            ptr::null(),
            ptr::null(),
        );
        let mut list_ptr: *mut WLAN_AVAILABLE_NETWORK_LIST = ptr::null_mut();
        let ok = WlanGetAvailableNetworkList(
            client.handle(),
            &guid,
            0, // no flags: only currently visible
            ptr::null(),
            &mut list_ptr,
        );
        if ok != 0 || list_ptr.is_null() {
            return None;
        }
        let header = list_ptr as *const u32;
        let count = *header;
        // Layout after dwNumberOfItems / dwIndex: array of WLAN_AVAILABLE_NETWORK.
        // Each entry has a 256-wchar profile name, a DOT11_SSID, then assorted
        // u32 fields. We need dot11Ssid, wlanSignalQuality, and the
        // bSecurityEnabled / bNetworkConnectable / dwFlags flags.
        let base = (list_ptr as *const u8).add(8);
        // Offsets within WLAN_AVAILABLE_NETWORK:
        //   0   : strProfileName [u16; 256]   = 512 bytes
        //   512 : DOT11_SSID                   = 4 + 32 = 36 bytes
        //   548 : DOT11_BSS_TYPE dot11BssType  = 4 bytes
        //   552 : u32 uNumberOfBssids
        //   556 : bNetworkConnectable (BOOL)   = 4 bytes
        //   560 : wlanNotConnectableReason
        //   564 : u32 uNumberOfPhyTypes
        //   568 : [DOT11_PHY_TYPE; 8]          = 32 bytes
        //   600 : wlanSignalQuality (u32)      = 4 bytes  (offset 600)
        //   604 : bSecurityEnabled (BOOL)
        //   608 : dot11DefaultAuthAlgorithm
        //   612 : dot11DefaultCipherAlgorithm
        //   616 : dwFlags (u32)
        //   620 : dwReserved
        const SIGNAL_OFFSET: usize = 600;
        const SECURITY_OFFSET: usize = 604;
        const FLAGS_OFFSET: usize = 616;
        let stride = std::mem::size_of::<WLAN_AVAILABLE_NETWORK>();
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count as usize {
            let entry = base.add(i * stride);
            let ssid = *(entry as *const DOT11_SSID);
            let signal = (*(entry.add(SIGNAL_OFFSET) as *const u32)).min(100);
            let secured = *(entry.add(SECURITY_OFFSET) as *const u32) != 0;
            let flags = *(entry.add(FLAGS_OFFSET) as *const u32);
            let connected = (flags & WLAN_AVAILABLE_NETWORK_CONNECTED) != 0;
            let known = (flags & WLAN_AVAILABLE_NETWORK_HAS_PROFILE) != 0;
            let name = ssid_to_string(&ssid);
            if name.is_empty() {
                continue; // hidden network — skip from the picker
            }
            out.push(WifiNetwork {
                ssid: name,
                signal,
                secured,
                connected,
                known,
            });
        }
        windows_sys::Win32::System::Memory::HeapFree(
            windows_sys::Win32::System::Memory::GetProcessHeap(),
            0,
            list_ptr as *const c_void,
        );
        // Deduplicate by SSID, keeping the strongest signal entry.
        out.sort_by(|a, b| b.signal.cmp(&a.signal));
        out.dedup_by(|a, b| a.ssid == b.ssid);
        // Sort: connected first, then known profiles, then strongest signal.
        out.sort_by(|a, b| {
            b.connected
                .cmp(&a.connected)
                .then_with(|| b.known.cmp(&a.known))
                .then_with(|| b.signal.cmp(&a.signal))
        });
        Some(out)
    }
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
