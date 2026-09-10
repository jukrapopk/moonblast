// Quick probe to verify the wlanapi path Moonblast uses.
// Run from src-tauri/: cargo run --example probe_wifi
#![cfg(windows)]

use std::ffi::c_void;
use std::ptr;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::NetworkManagement::WiFi::{
    WlanCloseHandle, WlanEnumInterfaces, WlanGetAvailableNetworkList, WlanOpenHandle,
    WlanQueryInterface, WlanScan, DOT11_SSID, WLAN_ASSOCIATION_ATTRIBUTES,
    WLAN_AVAILABLE_NETWORK_LIST, WLAN_INTERFACE_INFO_LIST,
};

fn main() {
    unsafe {
        let mut handle: HANDLE = ptr::null_mut();
        let mut ver = 0u32;
        let ok = WlanOpenHandle(2, ptr::null(), &mut ver, &mut handle);
        println!("WlanOpenHandle: ok={} handle={:?} ver={}", ok, handle, ver);
        if ok != 0 || handle.is_null() {
            return;
        }

        let mut list: *mut WLAN_INTERFACE_INFO_LIST = ptr::null_mut();
        let ok = WlanEnumInterfaces(handle, ptr::null(), &mut list);
        println!("WlanEnumInterfaces: ok={} ptr={:?}", ok, list);
        if ok != 0 || list.is_null() {
            WlanCloseHandle(handle, ptr::null());
            return;
        }

        let count = *(list as *const u32);
        let idx = *((list as *const u32).add(1));
        println!("  dwNumberOfItems={} dwIndex={}", count, idx);

        if count > 0 {
            let first = (list as *const u8).add(8);
            let bytes: [u8; 32] = ptr::read_unaligned(first as *const [u8; 32]);
            println!("  first interface bytes (GUID region): {:02x?}", &bytes[..16]);

            let guid_ptr = first as *const windows_sys::core::GUID;
            let mut data_size: u32 = 0;
            let mut data_ptr: *mut c_void = ptr::null_mut();
            let mut value_type: i32 = 0;
            let ok = WlanQueryInterface(
                handle,
                guid_ptr,
                7,
                ptr::null(),
                &mut data_size,
                &mut data_ptr,
                &mut value_type,
            );
            println!(
                "WlanQueryInterface: ok={} dataSize={} valueType={}",
                ok, data_size, value_type
            );
            if ok == 0 && !data_ptr.is_null() && data_size >= 8 {
                let state = *(data_ptr as *const u32);
                println!("  state={} (1=connected)", state);
                if state == 1 && data_size >= 604 {
                    // Verify the new offset works.
                    let assoc_ptr = data_ptr.add(520);
                    let assoc: WLAN_ASSOCIATION_ATTRIBUTES = ptr::read_unaligned(assoc_ptr as *const WLAN_ASSOCIATION_ATTRIBUTES);
                    let len = (assoc.dot11Ssid.uSSIDLength as usize).min(32);
                    let name = String::from_utf8_lossy(&assoc.dot11Ssid.ucSSID[..len]);
                    let sig = assoc.wlanSignalQuality.min(100);
                    println!("  fixed-offset read: SSID='{}' signal={}", name, sig);
                }
            }

            let _ = WlanScan(handle, guid_ptr, ptr::null(), ptr::null(), ptr::null());
            let mut avail: *mut WLAN_AVAILABLE_NETWORK_LIST = ptr::null_mut();
            let ok =
                WlanGetAvailableNetworkList(handle, guid_ptr, 0, ptr::null(), &mut avail);
            println!("WlanGetAvailableNetworkList: ok={} ptr={:?}", ok, avail);
            if ok == 0 && !avail.is_null() {
                use windows_sys::Win32::NetworkManagement::WiFi::{
                    WLAN_AVAILABLE_NETWORK, WLAN_AVAILABLE_NETWORK_CONNECTED,
                    WLAN_AVAILABLE_NETWORK_HAS_PROFILE,
                };
                let count = *(avail as *const u32);
                println!("  count={}", count);
                let base = (avail as *const u8).add(8);
                let stride = std::mem::size_of::<WLAN_AVAILABLE_NETWORK>();
                // Dump first 4 entries to verify the offsets in wifi.rs.
                for i in 0..count.min(4) as usize {
                    let entry = base.add(i * stride) as *const WLAN_AVAILABLE_NETWORK;
                    let e = ptr::read_unaligned(entry);
                    let len = (e.dot11Ssid.uSSIDLength as usize).min(32);
                    let name = String::from_utf8_lossy(&e.dot11Ssid.ucSSID[..len]);
                    let flags = e.dwFlags;
                    let connected = (flags & WLAN_AVAILABLE_NETWORK_CONNECTED) != 0;
                    let known = (flags & WLAN_AVAILABLE_NETWORK_HAS_PROFILE) != 0;
                    println!(
                        "  [{}] '{}' signal={} connected={} known={}",
                        i, name, e.wlanSignalQuality, connected, known
                    );
                }
            }
        }

        WlanCloseHandle(handle, ptr::null());
    }
}
