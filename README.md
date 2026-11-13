# The Pill

### Version 3.0.0 (Tauri)

A compact overlay that sits at the top of the screen on Windows. It gives quick access to system volume, music controls, weather, launchable apps, open apps, notifications, the date and time, and battery.

This is a rewrite of the Electron version for speed and low idle usage. The interface is deliberately plain: text only, with no icons or animations.

## Using the pill

- Hover over the thin bar at the top of the screen to open the pill. Click a button to open its panel.
- Click the date and time to open the **Pill Center**, with weather, volume, night light, battery saver, Windows Settings, power options and recent notifications.
- Right-click the pill to open **Pill settings**, where you choose what the bar shows and set the weather zip code.

| Shortcut | What it does |
|---|---|
| **Alt + W** | Hides or shows the idle bar. A hidden bar still opens when you hover over it. |
| **Alt + Space** | Opens the app switcher. Keep holding Alt and press Space to step through open apps, then release Alt to switch. Press Esc to cancel. |
| **Alt + Q** | Opens app search. Press Enter to open the first match. |
| **Volume keys** | Change the volume and show it on the pill instead of the Windows volume flyout. |

In the apps panel, right-click an app to add it to your favorites, and right-click a favorite to remove it.

## Building

You need [Rust](https://rustup.rs), Node.js, and the Visual Studio Build Tools with the C++ workload.

```sh
npm install
npm run dev     # run with a console for logs
npm run build   # build the installer into src-tauri/target/release/bundle/nsis
```

## How it is put together

- `ui/` is the web page: plain HTML, CSS and JavaScript with no build step. It only displays things and passes clicks on.
- `src-tauri/src/` is the Rust side, which does all the work through Windows APIs directly:

| File | Handles |
|---|---|
| `pill.rs` | Fitting the window to the pill and keeping it on top |
| `hotkeys.rs` | Global shortcuts, plus power events (battery changes, waking from sleep) |
| `worker.rs` | One background thread that runs Windows requests in order |
| `audio.rs` | System volume and the volume keys |
| `media.rs` | Music playing in any app |
| `notifications.rs` | Reading Windows notifications |
| `apps.rs` | Start menu apps and launching them |
| `windows_list.rs` | Open windows and switching to them |
| `switcher.rs` | The Alt+Space switcher |
| `nightlight.rs` | Night light on/off and strength |
| `power.rs` | Battery saver, lock, shut down and restart |
| `battery.rs` | Battery charge |
| `weather.rs` | Weather from weather.gov |

The installer adds The Pill to the apps that start when you sign in, and removes it when uninstalled.
