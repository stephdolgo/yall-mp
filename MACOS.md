# macOS support

Adds macOS support for watching video with subtitles. `--wid` is no longer
honoured on macOS — the OpenGL cocoa backend was the only one that supported it
and mpv removed it in 0.37, while the app requires 0.40+ — so the video cannot
be embedded in the app window. Instead mpv plays in its own window behind the
app, and everything here exists to make that look and behave like an embedded
player.

Windows and Linux are untouched. Everything below is behind
`process.platform === 'darwin'` / `isMacOs`, except the two items under
**Universal**.

## Universal

These are not macOS-specific and affect every platform.

- **Card exports downmix audio to stereo** (`-ac 2`). A 5.1 source failed the
  whole export — libopus rejects `5.1(side)` and lame cannot encode more than
  two channels. Found on macOS, not tested elsewhere, but the code path is
  shared.
- **`electron-resources/extensions/gender-german/`** is injected into the UI
  window if present and skipped silently if not. The format could potentially
  be used to allow add-ons generally.

## electron-main.ts

| added | what it's for |
|---|---|
| `refreshMacBackdrop()` | Paints the app window black and reveals the video where mpv is. Runs on every move and resize, since the rect is in screen coordinates. |
| `setMacVideoRect()` | Records where mpv reported itself, and tells the UI the video is visible. |
| `setUiDraggable()` | Turns the title-bar drag handle on and off, and dims it with a tooltip while off. |
| `macVideoRect`, `macBackdropClip`, `MAC_BACKDROP_INSET` | State for `refreshMacBackdrop()`. |
| `macVideoShown` | State for `setMacVideoRect()`. |
| `macDragCssKey`, `DRAG_HANDLE_ON_CSS`, `DRAG_HANDLE_OFF_CSS` | State for `setUiDraggable()`. |
| `uiDragUntil` | Lets `uiWindow` own its position mid-drag. |
| `uiWindow.on('move')` | Brings the app window along when the title bar is dragged. |
| Homebrew paths at `app.whenReady()` | Finder-launched apps get a minimal `PATH`, so mpv and audiowaveform read as missing. Adding the paths resolves it. |

Changed in place, macOS only:

- `mainWindow`, `uiWindow` and `videoWindow` are transparent with
  `hasShadow: false`.
- `draggable-host.html`'s backgrounds are cleared and its two views removed, so
  the window is purely a backdrop.
- `syncWindowGeometry()` skips hiding the video window, keeps window sizes in
  step during a drag, re-asserts video visibility, and forces a repaint.

## mpv-manager.ts

| added | what it's for |
|---|---|
| `applyGeometry()` | Sizes and positions mpv's window over the app's video area. |
| `currentGeometry()` | Cheap change detection for the above. |
| `geometryPoll` | Electron doesn't reliably emit move/resize for programmatic `setBounds()` here. |
| `'video-rect'` event | Reports where mpv landed, so the backdrop can reveal it. |

`--wid` is not passed on macOS. `--keepaspect-window=no` and
`--auto-window-resize=no` stop mpv resizing itself away from what we asked for.

## Deliberate limitations

- **No fullscreen.** It needs mpv and the UI to agree on a screen-filling
  geometry with no app window to anchor to.
- **No dragging until a video loads.** Before playback `uiWindow` is a child of
  `mainWindow`, and macOS moves child windows with their parent — so syncing the
  two feeds back on itself and the window walks off the screen. The app already
  reparents `uiWindow` to `videoWindow` when playback starts, which removes the
  parent relationship and ends the problem.

## Known issue

- **Maximising** can fit the video to the wrong rectangle. Dragging a window
  edge afterwards corrects it.