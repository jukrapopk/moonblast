//! Windows system volume + per-app mixer via Core Audio (MMDevice API).
//!
//! `windows-sys` 0.59 ships the MMDevice constants but no COM interfaces
//! (same situation as `IApplicationActivationManager` in lib.rs), so every
//! interface below is a hand-declared vtable — only layout matters, and only
//! up to the last method we actually call. Unused trailing slots are `usize`
//! placeholders.
//!
//! All entry points are synchronous COM calls wrapped in `spawn_blocking` by
//! the Tauri commands in lib.rs, so the UI never freezes. No elevation is
//! needed for any of this (per-user audio policy).

use serde::Serialize;
use std::ffi::c_void;
use std::ptr::null_mut;
use windows_sys::core::GUID;

type HRESULT = i32;

// --- IDs -----------------------------------------------------------------
// Well-known Core Audio IDs (mmdeviceapi.h / policyconfig.h / propkey.h).
const CLSID_MM_DEVICE_ENUMERATOR: GUID =
    GUID::from_u128(0xbcde0395_e52f_467c_8e3d_c4579291692e);
const IID_IMM_DEVICE_ENUMERATOR: GUID =
    GUID::from_u128(0xa95664d2_9614_4f35_a746_de8db63617e6);
const IID_IAUDIO_ENDPOINT_VOLUME: GUID =
    GUID::from_u128(0x5cdf2c82_841e_4546_9722_0cf74078229a);
const IID_IAUDIO_SESSION_MANAGER2: GUID =
    GUID::from_u128(0x77aa99a0_1bd6_484f_8bc7_2c654c9a9b6f);
const IID_ISIMPLE_AUDIO_VOLUME: GUID =
    GUID::from_u128(0x87ce5498_68d6_44e5_9215_6da47ef883d8);
const CLSID_POLICY_CONFIG: GUID =
    GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
const IID_IPOLICY_CONFIG: GUID =
    GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);

const E_RENDER: i32 = 0; // EDataFlow::eRender
const E_MULTIMEDIA: i32 = 1; // ERole::eMultimedia
const DEVICE_STATE_ACTIVE: u32 = 1;
const STGM_READ: u32 = 0;
const VT_LPWSTR: u16 = 31;
/// `PKEY_Device_FriendlyName` = {A45C254E-DF1C-4EFD-8020-67D146A850E0}, pid 14
/// (functiondiscoverykeys_devpkey.h).
const PKEY_FRIENDLY_FMTID: GUID =
    GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0);
/// AudioSessionState::AudioSessionStateExpired — skip these sessions.
const SESSION_STATE_EXPIRED: i32 = 2;

// --- vtable declarations ---------------------------------------------------

#[repr(C)]
struct IUnknownVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

#[repr(C)]
struct EnumeratorVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    enum_audio_endpoints:
        unsafe extern "system" fn(*mut c_void, i32, u32, *mut *mut c_void) -> HRESULT,
    get_default_audio_endpoint:
        unsafe extern "system" fn(*mut c_void, i32, i32, *mut *mut c_void) -> HRESULT,
    get_device: usize,
    register_callback: usize,
    unregister_callback: usize,
}

#[repr(C)]
struct CollectionVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
    item: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> HRESULT,
}

#[repr(C)]
struct DeviceVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    activate: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        u32,
        *const c_void,
        *mut *mut c_void,
    ) -> HRESULT,
    open_property_store:
        unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> HRESULT,
    get_id: unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> HRESULT,
    get_state: usize,
}

#[repr(C)]
struct PropertyKey {
    fmtid: GUID,
    pid: u32,
}

/// Minimal `PROPVARIANT` — 16 bytes: `vt` + 6 reserved + an 8-byte union.
/// We only ever read `VT_LPWSTR`, whose pointer sits at offset 8.
#[repr(C)]
struct PropVar {
    vt: u16,
    _reserved: [u16; 3],
    ptr: *const u16,
}

#[repr(C)]
struct PropertyStoreVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_count: usize,
    get_at: usize,
    get_value:
        unsafe extern "system" fn(*mut c_void, *const PropertyKey, *mut PropVar) -> HRESULT,
    set_value: usize,
    commit: usize,
}

#[repr(C)]
struct EndpointVolumeVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    register_notify: usize,
    unregister_notify: usize,
    get_channel_count: usize,
    set_master_level: usize,
    set_master_scalar:
        unsafe extern "system" fn(*mut c_void, f32, *const GUID) -> HRESULT,
    get_master_level: usize,
    get_master_scalar: unsafe extern "system" fn(*mut c_void, *mut f32) -> HRESULT,
    set_channel_level: usize,
    set_channel_scalar: usize,
    get_channel_level: usize,
    get_channel_scalar: usize,
    set_mute: unsafe extern "system" fn(*mut c_void, i32, *const GUID) -> HRESULT,
    get_mute: unsafe extern "system" fn(*mut c_void, *mut i32) -> HRESULT,
}

#[repr(C)]
struct SessionManagerVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_session_control: usize,
    get_simple_volume: usize,
    get_session_enumerator:
        unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
}

#[repr(C)]
struct SessionEnumeratorVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_count: unsafe extern "system" fn(*mut c_void, *mut i32) -> HRESULT,
    get_session:
        unsafe extern "system" fn(*mut c_void, i32, *mut *mut c_void) -> HRESULT,
}

#[repr(C)]
struct SessionControl2Vtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_state: unsafe extern "system" fn(*mut c_void, *mut i32) -> HRESULT,
    get_display_name: usize,
    set_display_name: usize,
    get_icon_path: usize,
    set_icon_path: usize,
    get_grouping: usize,
    set_grouping: usize,
    register_notify: usize,
    unregister_notify: usize,
    get_session_id: usize,
    get_instance_id:
        unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> HRESULT,
    get_process_id: unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
    is_system_sounds: unsafe extern "system" fn(*mut c_void, *mut i32) -> HRESULT,
}

#[repr(C)]
struct SimpleVolumeVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    set_master_volume:
        unsafe extern "system" fn(*mut c_void, f32, *const GUID) -> HRESULT,
    get_master_volume: unsafe extern "system" fn(*mut c_void, *mut f32) -> HRESULT,
    set_mute: unsafe extern "system" fn(*mut c_void, i32, *const GUID) -> HRESULT,
    get_mute: unsafe extern "system" fn(*mut c_void, *mut i32) -> HRESULT,
}

/// Undocumented `IPolicyConfig` — the API the Sound control panel itself uses
/// to change the default endpoint. Per-user, no elevation.
#[repr(C)]
struct PolicyConfigVtbl {
    query_interface: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *mut *mut c_void,
    ) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    _0: usize,
    _1: usize,
    _2: usize,
    _3: usize,
    _4: usize,
    _5: usize,
    _6: usize,
    _7: usize,
    _8: usize,
    _9: usize,
    set_default_endpoint:
        unsafe extern "system" fn(*mut c_void, *const u16, i32) -> HRESULT,
}

// --- helpers ---------------------------------------------------------------

/// COM pointer that Releases on drop, so early `?` returns can't leak.
struct ComPtr(*mut c_void);

impl ComPtr {
    fn vtbl<T>(&self) -> *const T {
        unsafe { *(self.0 as *mut *const T) }
    }
}

impl Drop for ComPtr {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let vtbl = *(self.0 as *mut *const IUnknownVtbl);
                ((*vtbl).release)(self.0);
            }
        }
    }
}

fn com_init() {
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        // May report "already initialized" on a pooled Tauri thread; fine.
        let _ = CoInitializeEx(null_mut(), COINIT_MULTITHREADED as u32);
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn from_wide(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
}

/// Read a `CoTaskMemAlloc`'d wide string, then free it.
unsafe fn take_wide(ptr: *mut u16) -> String {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    let s = from_wide(ptr);
    if !ptr.is_null() {
        CoTaskMemFree(ptr as *const c_void);
    }
    s
}

fn create_enumerator() -> Result<ComPtr, String> {
    use windows_sys::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    com_init();
    let mut out: *mut c_void = null_mut();
    let hr = unsafe {
        CoCreateInstance(
            &CLSID_MM_DEVICE_ENUMERATOR,
            null_mut(),
            CLSCTX_ALL,
            &IID_IMM_DEVICE_ENUMERATOR,
            &mut out,
        )
    };
    if hr < 0 || out.is_null() {
        return Err(format!("audio device enumerator unavailable (0x{hr:08X})"));
    }
    Ok(ComPtr(out))
}

fn default_device(en: &ComPtr) -> Result<ComPtr, String> {
    let mut out: *mut c_void = null_mut();
    let hr = unsafe {
        ((*en.vtbl::<EnumeratorVtbl>()).get_default_audio_endpoint)(
            en.0,
            E_RENDER,
            E_MULTIMEDIA,
            &mut out,
        )
    };
    if hr < 0 || out.is_null() {
        return Err(format!("no default audio device (0x{hr:08X})"));
    }
    Ok(ComPtr(out))
}

fn device_id(dev: &ComPtr) -> Result<String, String> {
    let mut id: *mut u16 = null_mut();
    let hr = unsafe { ((*dev.vtbl::<DeviceVtbl>()).get_id)(dev.0, &mut id) };
    if hr < 0 {
        return Err(format!("could not read device id (0x{hr:08X})"));
    }
    Ok(unsafe { take_wide(id) })
}

fn device_friendly_name(dev: &ComPtr) -> String {
    unsafe {
        let vtbl = dev.vtbl::<DeviceVtbl>();
        let mut store: *mut c_void = null_mut();
        if ((*vtbl).open_property_store)(dev.0, STGM_READ, &mut store) < 0
            || store.is_null()
        {
            return String::new();
        }
        let store = ComPtr(store);
        let key = PropertyKey {
            fmtid: PKEY_FRIENDLY_FMTID,
            pid: 14,
        };
        let mut pv: PropVar = std::mem::zeroed();
        if ((*store.vtbl::<PropertyStoreVtbl>()).get_value)(store.0, &key, &mut pv) < 0 {
            return String::new();
        }
        let name = if pv.vt == VT_LPWSTR {
            from_wide(pv.ptr)
        } else {
            String::new()
        };
        use windows_sys::Win32::System::Com::StructuredStorage::PropVariantClear;
        let _ = PropVariantClear(&mut pv as *mut PropVar as *mut _);
        name
    }
}

/// `IAudioEndpointVolume` for the default render endpoint (the main mixer).
fn default_endpoint_volume() -> Result<ComPtr, String> {
    use windows_sys::Win32::System::Com::CLSCTX_ALL;
    let en = create_enumerator()?;
    let dev = default_device(&en)?;
    let mut out: *mut c_void = null_mut();
    let hr = unsafe {
        ((*dev.vtbl::<DeviceVtbl>()).activate)(
            dev.0,
            &IID_IAUDIO_ENDPOINT_VOLUME,
            CLSCTX_ALL,
            null_mut(),
            &mut out,
        )
    };
    if hr < 0 || out.is_null() {
        return Err(format!("could not open master volume (0x{hr:08X})"));
    }
    Ok(ComPtr(out))
}

/// `IAudioSessionManager2` for the default render endpoint (the apps mixer).
fn default_session_manager() -> Result<ComPtr, String> {
    use windows_sys::Win32::System::Com::CLSCTX_ALL;
    let en = create_enumerator()?;
    let dev = default_device(&en)?;
    let mut out: *mut c_void = null_mut();
    let hr = unsafe {
        ((*dev.vtbl::<DeviceVtbl>()).activate)(
            dev.0,
            &IID_IAUDIO_SESSION_MANAGER2,
            CLSCTX_ALL,
            null_mut(),
            &mut out,
        )
    };
    if hr < 0 || out.is_null() {
        return Err(format!("could not open session manager (0x{hr:08X})"));
    }
    Ok(ComPtr(out))
}

/// `ISimpleAudioVolume` for one session control object.
fn session_volume(ctl: &ComPtr) -> Result<ComPtr, String> {
    unsafe {
        let vtbl = *(ctl.0 as *mut *const IUnknownVtbl);
        let mut out: *mut c_void = null_mut();
        let hr = ((*vtbl).query_interface)(ctl.0, &IID_ISIMPLE_AUDIO_VOLUME, &mut out);
        if hr < 0 || out.is_null() {
            return Err(format!("session has no volume control (0x{hr:08X})"));
        }
        Ok(ComPtr(out))
    }
}

/// File name of a process image (`chrome.exe`), or empty when unreadable.
fn process_file_name(pid: u32) -> String {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW};
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            return String::new();
        }
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

// --- public shapes ---------------------------------------------------------

#[derive(Serialize)]
pub struct AudioDevice {
    /// MMDevice id (`{0.0.0.00000000}.{guid}`) — the set-default key.
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceList {
    pub devices: Vec<AudioDevice>,
    pub default_id: String,
}

#[derive(Serialize)]
pub struct AudioMaster {
    /// 0–100.
    pub volume: u8,
    pub muted: bool,
}

#[derive(Serialize)]
pub struct AudioSession {
    /// Lowercased exe name — stable key for set-volume/mute.
    pub id: String,
    /// Display name (`chrome.exe`).
    pub name: String,
    /// 0–100.
    pub volume: u8,
    pub muted: bool,
}

fn scalar_to_pct(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 100.0).round() as u8
}

// --- public entry points (called from Tauri commands via spawn_blocking) ---

pub fn devices() -> Result<AudioDeviceList, String> {
    let en = create_enumerator()?;
    let default_id = default_device(&en)
        .and_then(|d| device_id(&d))
        .unwrap_or_default();
    let mut coll: *mut c_void = null_mut();
    let hr = unsafe {
        ((*en.vtbl::<EnumeratorVtbl>()).enum_audio_endpoints)(
            en.0,
            E_RENDER,
            DEVICE_STATE_ACTIVE,
            &mut coll,
        )
    };
    if hr < 0 || coll.is_null() {
        return Err(format!("could not list audio devices (0x{hr:08X})"));
    }
    let coll = ComPtr(coll);
    let mut count = 0u32;
    unsafe {
        ((*coll.vtbl::<CollectionVtbl>()).get_count)(coll.0, &mut count);
    }
    let mut out = Vec::new();
    for i in 0..count {
        let mut dev: *mut c_void = null_mut();
        let hr =
            unsafe { ((*coll.vtbl::<CollectionVtbl>()).item)(coll.0, i, &mut dev) };
        if hr < 0 || dev.is_null() {
            continue;
        }
        let dev = ComPtr(dev);
        let Ok(id) = device_id(&dev) else {
            continue;
        };
        let mut name = device_friendly_name(&dev);
        if name.is_empty() {
            name = id.clone();
        }
        out.push(AudioDevice {
            is_default: id == default_id,
            id,
            name,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(AudioDeviceList {
        devices: out,
        default_id,
    })
}

pub fn set_default_device(id: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    com_init();
    let mut raw: *mut c_void = null_mut();
    let hr = unsafe {
        CoCreateInstance(
            &CLSID_POLICY_CONFIG,
            null_mut(),
            CLSCTX_ALL,
            &IID_IPOLICY_CONFIG,
            &mut raw,
        )
    };
    if hr < 0 || raw.is_null() {
        return Err(format!("audio policy config unavailable (0x{hr:08X})"));
    }
    let cfg = ComPtr(raw);
    let wide = to_wide(id);
    // Set every role (console / multimedia / communications), like the Sound
    // control panel's "Set as Default Device" does.
    unsafe {
        let vtbl = cfg.vtbl::<PolicyConfigVtbl>();
        for role in [0, 1, 2] {
            let hr = ((*vtbl).set_default_endpoint)(cfg.0, wide.as_ptr(), role);
            if hr < 0 {
                return Err(format!("could not set default device (0x{hr:08X})"));
            }
        }
    }
    Ok(())
}

pub fn master() -> Result<AudioMaster, String> {
    let ep = default_endpoint_volume()?;
    unsafe {
        let vtbl = ep.vtbl::<EndpointVolumeVtbl>();
        let mut level = 0.0f32;
        if ((*vtbl).get_master_scalar)(ep.0, &mut level) < 0 {
            return Err("could not read master volume".to_string());
        }
        let mut mute = 0i32;
        if ((*vtbl).get_mute)(ep.0, &mut mute) < 0 {
            return Err("could not read master mute".to_string());
        }
        Ok(AudioMaster {
            volume: scalar_to_pct(level),
            muted: mute != 0,
        })
    }
}

pub fn set_master_volume(volume: u8) -> Result<(), String> {
    let ep = default_endpoint_volume()?;
    let hr = unsafe {
        ((*ep.vtbl::<EndpointVolumeVtbl>()).set_master_scalar)(
            ep.0,
            (volume.min(100) as f32) / 100.0,
            null_mut(),
        )
    };
    if hr < 0 {
        return Err(format!("could not set master volume (0x{hr:08X})"));
    }
    Ok(())
}

pub fn set_master_mute(muted: bool) -> Result<(), String> {
    let ep = default_endpoint_volume()?;
    let hr = unsafe {
        ((*ep.vtbl::<EndpointVolumeVtbl>()).set_mute)(
            ep.0,
            i32::from(muted),
            null_mut(),
        )
    };
    if hr < 0 {
        return Err(format!("could not set master mute (0x{hr:08X})"));
    }
    Ok(())
}

/// One live session on the default device (pre-grouping).
struct RawSession {
    exe: String,
    volume: u8,
    muted: bool,
}

fn raw_sessions() -> Result<Vec<RawSession>, String> {
    let mgr = default_session_manager()?;
    let mut raw: *mut c_void = null_mut();
    let hr = unsafe {
        ((*mgr.vtbl::<SessionManagerVtbl>()).get_session_enumerator)(mgr.0, &mut raw)
    };
    if hr < 0 || raw.is_null() {
        return Err(format!("could not list audio sessions (0x{hr:08X})"));
    }
    let en = ComPtr(raw);
    let mut count = 0i32;
    unsafe {
        ((*en.vtbl::<SessionEnumeratorVtbl>()).get_count)(en.0, &mut count);
    }
    let mut out = Vec::new();
    for i in 0..count {
        let mut ctl: *mut c_void = null_mut();
        if unsafe { ((*en.vtbl::<SessionEnumeratorVtbl>()).get_session)(en.0, i, &mut ctl) }
            < 0
            || ctl.is_null()
        {
            continue;
        }
        let ctl = ComPtr(ctl);
        // IAudioSessionControl methods live on the same object; the
        // Control2 vtable starts with the identical prefix.
        let vtbl = ctl.vtbl::<SessionControl2Vtbl>();
        let mut state = 0i32;
        if unsafe { ((*vtbl).get_state)(ctl.0, &mut state) } < 0
            || state == SESSION_STATE_EXPIRED
        {
            continue;
        }
        let mut system = 0i32;
        if unsafe { ((*vtbl).is_system_sounds)(ctl.0, &mut system) } < 0 || system != 0 {
            continue;
        }
        let mut pid = 0u32;
        if unsafe { ((*vtbl).get_process_id)(ctl.0, &mut pid) } < 0 || pid == 0 {
            continue;
        }
        let exe = process_file_name(pid);
        if exe.is_empty() {
            continue;
        }
        let Ok(vol) = session_volume(&ctl) else {
            continue;
        };
        let vvtbl = vol.vtbl::<SimpleVolumeVtbl>();
        let (mut level, mut mute) = (0.0f32, 0i32);
        unsafe {
            if ((*vvtbl).get_master_volume)(vol.0, &mut level) < 0 {
                continue;
            }
            let _ = ((*vvtbl).get_mute)(vol.0, &mut mute);
        }
        out.push(RawSession {
            exe,
            volume: scalar_to_pct(level),
            muted: mute != 0,
        });
    }
    Ok(out)
}

/// Sessions grouped by exe (like the Windows mixer — one row per app).
/// First-seen session wins for the displayed level; sets apply to all of
/// the app's sessions.
pub fn sessions() -> Result<Vec<AudioSession>, String> {
    let mut grouped: Vec<AudioSession> = Vec::new();
    for raw in raw_sessions()? {
        let id = raw.exe.to_lowercase();
        if grouped.iter().any(|s| s.id == id) {
            continue;
        }
        grouped.push(AudioSession {
            id,
            name: raw.exe,
            volume: raw.volume,
            muted: raw.muted,
        });
    }
    grouped.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(grouped)
}

/// Apply `f` to every live session of one app (matched by exe key).
fn for_each_app_session(id: &str, f: impl Fn(&ComPtr) -> ()) -> Result<usize, String> {
    let mgr = default_session_manager()?;
    let mut raw: *mut c_void = null_mut();
    unsafe {
        ((*mgr.vtbl::<SessionManagerVtbl>()).get_session_enumerator)(mgr.0, &mut raw);
    }
    if raw.is_null() {
        return Err("could not list audio sessions".to_string());
    }
    let en = ComPtr(raw);
    let mut count = 0i32;
    unsafe {
        ((*en.vtbl::<SessionEnumeratorVtbl>()).get_count)(en.0, &mut count);
    }
    let mut n = 0;
    for i in 0..count {
        let mut ctl: *mut c_void = null_mut();
        if unsafe { ((*en.vtbl::<SessionEnumeratorVtbl>()).get_session)(en.0, i, &mut ctl) }
            < 0
            || ctl.is_null()
        {
            continue;
        }
        let ctl = ComPtr(ctl);
        let vtbl = ctl.vtbl::<SessionControl2Vtbl>();
        let mut state = 0i32;
        if unsafe { ((*vtbl).get_state)(ctl.0, &mut state) } < 0
            || state == SESSION_STATE_EXPIRED
        {
            continue;
        }
        let mut pid = 0u32;
        if unsafe { ((*vtbl).get_process_id)(ctl.0, &mut pid) } < 0 || pid == 0 {
            continue;
        }
        if process_file_name(pid).to_lowercase() != id {
            continue;
        }
        if let Ok(vol) = session_volume(&ctl) {
            f(&vol);
            n += 1;
        }
    }
    Ok(n)
}

pub fn set_session_volume(id: &str, volume: u8) -> Result<(), String> {
    let level = (volume.min(100) as f32) / 100.0;
    for_each_app_session(&id.to_lowercase(), |vol| unsafe {
        let _ = ((*vol.vtbl::<SimpleVolumeVtbl>()).set_master_volume)(
            vol.0,
            level,
            null_mut(),
        );
    })?;
    Ok(())
}

pub fn set_session_mute(id: &str, muted: bool) -> Result<(), String> {
    for_each_app_session(&id.to_lowercase(), |vol| unsafe {
        let _ = ((*vol.vtbl::<SimpleVolumeVtbl>()).set_mute)(
            vol.0,
            i32::from(muted),
            null_mut(),
        );
    })?;
    Ok(())
}

/// Reset every app mixer channel to max + unmuted. Returns sessions touched.
pub fn reset_sessions() -> Result<usize, String> {
    let mgr = default_session_manager()?;
    let mut raw: *mut c_void = null_mut();
    unsafe {
        ((*mgr.vtbl::<SessionManagerVtbl>()).get_session_enumerator)(mgr.0, &mut raw);
    }
    if raw.is_null() {
        return Err("could not list audio sessions".to_string());
    }
    let en = ComPtr(raw);
    let mut count = 0i32;
    unsafe {
        ((*en.vtbl::<SessionEnumeratorVtbl>()).get_count)(en.0, &mut count);
    }
    let mut n = 0;
    for i in 0..count {
        let mut ctl: *mut c_void = null_mut();
        if unsafe { ((*en.vtbl::<SessionEnumeratorVtbl>()).get_session)(en.0, i, &mut ctl) }
            < 0
            || ctl.is_null()
        {
            continue;
        }
        let ctl = ComPtr(ctl);
        let vtbl = ctl.vtbl::<SessionControl2Vtbl>();
        let mut state = 0i32;
        if unsafe { ((*vtbl).get_state)(ctl.0, &mut state) } < 0
            || state == SESSION_STATE_EXPIRED
        {
            continue;
        }
        let mut system = 0i32;
        if unsafe { ((*vtbl).is_system_sounds)(ctl.0, &mut system) } < 0 || system != 0 {
            continue;
        }
        if let Ok(vol) = session_volume(&ctl) {
            unsafe {
                let vvtbl = vol.vtbl::<SimpleVolumeVtbl>();
                let _ = ((*vvtbl).set_master_volume)(vol.0, 1.0, null_mut());
                let _ = ((*vvtbl).set_mute)(vol.0, 0, null_mut());
            }
            n += 1;
        }
    }
    Ok(n)
}
