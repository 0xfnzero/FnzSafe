#[cfg(target_os = "macos")]
use std::sync::Mutex;

#[cfg(target_os = "macos")]
static SECURE_EVENT_INPUT_OWNED: Mutex<bool> = Mutex::new(false);

#[cfg(target_os = "macos")]
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn EnableSecureEventInput() -> i32;
    fn DisableSecureEventInput() -> i32;
}

#[cfg(target_os = "macos")]
fn set_macos_secure_keyboard_input(enabled: bool) -> Result<bool, String> {
    let mut owned = SECURE_EVENT_INPUT_OWNED
        .lock()
        .map_err(|_| "secure keyboard input state is unavailable".to_string())?;
    if *owned == enabled {
        return Ok(*owned);
    }

    let status = unsafe {
        if enabled {
            EnableSecureEventInput()
        } else {
            DisableSecureEventInput()
        }
    };
    if status != 0 {
        return Err(format!(
            "failed to {} secure keyboard input (OSStatus {status})",
            if enabled { "enable" } else { "disable" }
        ));
    }
    *owned = enabled;
    Ok(*owned)
}

#[tauri::command]
pub(crate) fn set_secure_keyboard_input(
    webview: crate::DesktopWebview,
    enabled: bool,
) -> Result<bool, String> {
    if webview.label() != "main" {
        return Err("secure keyboard input is restricted to the main interface".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        set_macos_secure_keyboard_input(enabled)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Ok(false)
    }
}
