//! Display resolution + refresh rate enumeration and dynamic mode change.
//!
//! Uses `EnumDisplaySettingsExW` with no flags (i.e. not `EDS_RAWMODE`) so
//! the list matches what Windows Settings shows — monitor-compatible
//! modes only, current orientation only. The driver returns each
//! width×height×refresh combination once per call; we deduplicate by
//! (width, height) and collect every distinct refresh rate.
//!
//! `ChangeDisplaySettingsExW` with **no flags** applies a *dynamic* mode
//! change: the new resolution sticks for this session and reverts at the
//! next sign-out / reboot / graphics-adapter restart. That matches our
//! UX (10-second Keep/Revert) — we don't want to silently mutate the
//! user's registry-persisted resolution just because they were
//! experimenting in Moonblast.
//!
//! The primary display is hardcoded for v1 (NULL device name → the
//! display the calling thread is bound to).

use std::sync::Mutex;

use windows_sys::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, EnumDisplaySettingsExW, DEVMODEW, ENUM_CURRENT_SETTINGS,
};

#[derive(serde::Serialize, Clone, Copy)]
pub struct DisplayMode {
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
}

#[derive(serde::Serialize)]
pub struct DisplayOption {
    pub width: u32,
    pub height: u32,
    pub refresh_rates: Vec<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDisplay {
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
}

/// Last applied (but uncommitted) mode change, plus the prior mode to
/// revert to when the user clicks Revert or the 10s auto-revert elapses.
/// Held in a Mutex so the frontend can call `apply_display_mode` then
/// later `revert_display_mode` from a different command.
static PENDING_REVERT: Mutex<Option<(DisplayMode, DisplayMode)>> = Mutex::new(None);

fn hr_ok(hr: i32) -> bool {
    hr == 0 || hr == 1
    // DISP_CHANGE_SUCCESSFUL = 0, DISP_CHANGE_RESTART = 1 — both are
    // success for the dynamic path.
}

fn current_display_raw() -> Option<DisplayMode> {
    unsafe {
        let mut dm: DEVMODEW = std::mem::zeroed();
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        let ok = EnumDisplaySettingsExW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut dm, 0);
        if ok == 0 {
            return None;
        }
        Some(DisplayMode {
            width: dm.dmPelsWidth,
            height: dm.dmPelsHeight,
            refresh_rate: dm.dmDisplayFrequency,
        })
    }
}

/// Enumerate every (width, height, refresh) the primary display reports as
/// monitor-compatible. Deduped by resolution; refresh rates are sorted
/// ascending.
pub fn display_modes() -> Vec<DisplayOption> {
    use std::collections::BTreeMap;
    let mut by_res: BTreeMap<(u32, u32), Vec<u32>> = BTreeMap::new();
    let mut i: u32 = 0;
    loop {
        let mut dm: DEVMODEW = unsafe { std::mem::zeroed() };
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        let ok = unsafe { EnumDisplaySettingsExW(std::ptr::null(), i, &mut dm, 0) };
        if ok == 0 {
            break;
        }
        // Skip degenerate entries (driver may report 0×0 in some slots).
        if dm.dmPelsWidth > 0 && dm.dmPelsHeight > 0 && dm.dmDisplayFrequency > 0 {
            by_res
                .entry((dm.dmPelsWidth, dm.dmPelsHeight))
                .or_default()
                .push(dm.dmDisplayFrequency);
        }
        i += 1;
    }
    by_res
        .into_iter()
        .map(|((width, height), mut rates)| {
            rates.sort_unstable();
            rates.dedup();
            DisplayOption { width, height, refresh_rates: rates }
        })
        .collect()
}

pub fn current_display() -> Result<CurrentDisplay, String> {
    let m = current_display_raw().ok_or_else(|| "Could not read current display".to_string())?;
    Ok(CurrentDisplay {
        width: m.width,
        height: m.height,
        refresh_rate: m.refresh_rate,
    })
}

/// Apply a new resolution + refresh dynamically (no registry write).
/// Records the prior mode so `revert_display_mode` can roll back.
pub fn apply_display_mode(width: u32, height: u32, refresh_rate: u32) -> Result<(), String> {
    let prior = current_display_raw()
        .ok_or_else(|| "Could not read current display".to_string())?;
    let hr = unsafe {
        let mut dm: DEVMODEW = std::mem::zeroed();
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        // DM_PELSWIDTH (0x00080000) | DM_PELSHEIGHT (0x00100000) | DM_DISPLAYFREQUENCY (0x00400000)
        dm.dmFields = 0x00580000;
        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmDisplayFrequency = refresh_rate;
        ChangeDisplaySettingsExW(
            std::ptr::null(),
            &dm,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    };
    if !hr_ok(hr) {
        return Err(format!("ChangeDisplaySettingsEx failed ({hr})"));
    }
    // Stash prior for revert. If a prior change was already pending and
    // uncommitted, drop it — we're committing now (Keep semantics).
    *PENDING_REVERT.lock().unwrap() = Some((
        DisplayMode { width, height, refresh_rate },
        prior,
    ));
    Ok(())
}

/// Roll back to the mode that was active before the last apply. Returns
/// `Ok(())` even if no pending change exists.
pub fn revert_display_mode() -> Result<(), String> {
    let pending = PENDING_REVERT.lock().unwrap().take();
    let Some((_current, prior)) = pending else {
        return Ok(());
    };
    let hr = unsafe {
        let mut dm: DEVMODEW = std::mem::zeroed();
        dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        dm.dmFields = 0x00580000;
        dm.dmPelsWidth = prior.width;
        dm.dmPelsHeight = prior.height;
        dm.dmDisplayFrequency = prior.refresh_rate;
        ChangeDisplaySettingsExW(
            std::ptr::null(),
            &dm,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    };
    if !hr_ok(hr) {
        return Err(format!("Revert failed ({hr})"));
    }
    Ok(())
}

/// Confirm the last applied mode — clears the pending revert so the 10s
/// auto-revert timer no longer fires.
pub fn keep_display_mode() -> Result<(), String> {
    let mut slot = PENDING_REVERT.lock().unwrap();
    // Keep the new mode but drop the prior so revert becomes a no-op.
    let current_opt = slot.as_ref().map(|(c, _)| *c);
    if let Some(current) = current_opt {
        *slot = Some((current, current));
    }
    Ok(())
}
