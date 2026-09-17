//! Shared WinRT `Windows.Devices.Radios` helper for anything that needs to
//! read or flip an individual radio's on/off state. `Radio::GetRadiosAsync`
//! enumerates every radio on the system (WiFi, Bluetooth, mobile broadband,
//! FM) through one API, keyed by `RadioKind` — this is the same API behind
//! Windows' own Quick Settings toggles, so it's reused by both `wifi.rs`
//! and `bluetooth.rs` instead of each shelling out to something different.

#![cfg(windows)]

use windows::core::Error as WinError;
use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};

pub fn win_err(e: WinError) -> String {
    e.message()
}

/// Ensure the calling thread has a WinRT apartment. Callers run on a
/// `spawn_blocking` worker thread, and WinRT calls need `RoInitialize` on
/// each such thread before any `Devices::*` call — the pool doesn't
/// guarantee the same thread across calls, and skipping this makes the
/// first call on a fresh thread fail with `CO_E_NOTINITIALIZED`.
/// Multithreaded (MTA) rather than STA: nothing here touches UI, and MTA
/// is a superset of what these APIs need. Errors (e.g. "already
/// initialized in a different mode") are ignored — either way COM/WinRT
/// is live on this thread afterward.
pub fn ensure_winrt() {
    use std::cell::Cell;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
    thread_local! {
        static INITED: Cell<bool> = const { Cell::new(false) };
    }
    INITED.with(|f| {
        if !f.get() {
            let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
            f.set(true);
        }
    });
}

/// Find the first radio of the given kind (most machines have at most one
/// of each; picking the first mirrors the existing "first interface/radio"
/// convention in `wifi.rs`/`bluetooth.rs`).
pub fn find_radio(kind: RadioKind) -> windows::core::Result<Option<Radio>> {
    ensure_winrt();
    let radios = Radio::GetRadiosAsync()?.get()?;
    let size = radios.Size()?;
    for i in 0..size {
        let radio = radios.GetAt(i)?;
        if radio.Kind()? == kind {
            return Ok(Some(radio));
        }
    }
    Ok(None)
}

/// Turn a radio of the given kind on or off. `Err` when no such radio
/// exists, or when Windows denies the request (e.g. a hardware kill
/// switch / airplane-mode policy blocking it).
pub fn set_radio(kind: RadioKind, on: bool) -> Result<(), String> {
    let radio = find_radio(kind)
        .map_err(win_err)?
        .ok_or_else(|| "No radio found".to_string())?;
    let state = if on { RadioState::On } else { RadioState::Off };
    let status = radio
        .SetStateAsync(state)
        .map_err(win_err)?
        .get()
        .map_err(win_err)?;
    if status == RadioAccessStatus::Allowed {
        Ok(())
    } else {
        Err(format!("Windows denied the request ({status:?})"))
    }
}
