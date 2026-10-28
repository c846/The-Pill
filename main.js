const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const loudness = require('loudness');

const collapsedSize = { width: 480, height: 8 };
const expandedSize = { width: 480, height: 42 };
const appsExpandedSize = { width: 480, height: 460 };
const musicExpandedSize = { width: 480, height: 240 };
const notificationSize = { width: 480, height: 120 };
const installedApps = new Map();
const runningWindows = new Map();
let notificationProcess;
let tray;
let appIsQuitting = false;
let runningAppSelectionActive = false;
let windowActivationProcess;
let windowActivationReady;
let nextWindowActivationRequestId = 0;
const pendingWindowActivations = new Map();

const windowApi = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PillWindowApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}`;

function runPowerShell(script) {
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const process = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodedScript,
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      process.kill();
      reject(new Error('Timed out while communicating with Windows.'));
    }, 15000);

    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    process.stdout.on('data', (data) => { stdout += data; });
    process.stderr.on('data', (data) => { stderr += data; });
    process.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function createWindowActivationWorkerScript() {
  return `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$null = Add-Type -TypeDefinition @'
${windowApi}
'@
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    $hWnd = [IntPtr]([System.Convert]::ToInt64([string]$request.id, 16))
    if (-not [PillWindowApi]::IsWindow($hWnd)) { throw 'The selected window is no longer available.' }
    if ([PillWindowApi]::IsIconic($hWnd)) {
      [void][PillWindowApi]::ShowWindowAsync($hWnd, 9)
    }
    if (-not [PillWindowApi]::SetForegroundWindow($hWnd)) {
      throw 'Windows did not allow the selected app to become active.'
    }
    $response = @{ requestId = $request.requestId; success = $true }
  } catch {
    $response = @{ requestId = $request.requestId; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Compress))
  [Console]::Out.Flush()
}`;
}

function startWindowActivationWorker() {
  if (windowActivationProcess) {
    return windowActivationReady;
  }

  const encodedScript = Buffer.from(createWindowActivationWorkerScript(), 'utf16le').toString('base64');
  let resolveReady;
  let rejectReady;
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const settleStartupFailure = (error) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    clearTimeout(startupTimeout);
    rejectReady(error);
  };
  const worker = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encodedScript,
  ], { windowsHide: true });
  const startupTimeout = setTimeout(() => {
    settleStartupFailure(new Error('Timed out while starting the app activation worker.'));
    worker.kill();
  }, 10000);

  windowActivationProcess = worker;
  windowActivationReady = ready;
  const output = readline.createInterface({ input: worker.stdout });
  output.on('line', (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      console.error('Could not parse app activation worker output:', error);
      worker.kill();
      return;
    }

    if (response.ready === true) {
      if (!readySettled) {
        readySettled = true;
        clearTimeout(startupTimeout);
        resolveReady();
      }
      return;
    }

    const pending = pendingWindowActivations.get(response.requestId);
    if (!pending) {
      console.error('Received an unexpected app activation worker response.');
      worker.kill();
      return;
    }
    pendingWindowActivations.delete(response.requestId);
    if (typeof response.error === 'string') {
      pending.reject(new Error(response.error));
    } else if (response.success === true) {
      pending.resolve();
    } else {
      pending.reject(new Error('App activation worker returned an invalid response.'));
    }
  });
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (data) => {
    console.error('App activation worker:', data.trim());
  });
  worker.on('error', (error) => {
    settleStartupFailure(error);
  });
  worker.on('close', (code) => {
    settleStartupFailure(new Error(`App activation worker exited before starting (code ${code}).`));
    const error = new Error(`App activation worker exited (code ${code}).`);
    for (const pending of pendingWindowActivations.values()) {
      pending.reject(error);
    }
    pendingWindowActivations.clear();
    output.close();
    if (windowActivationProcess === worker) {
      windowActivationProcess = undefined;
      windowActivationReady = undefined;
    }
  });

  return ready;
}

async function requestWindowActivation(id) {
  await startWindowActivationWorker();
  const requestId = ++nextWindowActivationRequestId;
  const response = new Promise((resolve, reject) => {
    pendingWindowActivations.set(requestId, { resolve, reject });
  });
  const request = JSON.stringify({ requestId, id });
  if (!windowActivationProcess || !windowActivationProcess.stdin.writable) {
    pendingWindowActivations.delete(requestId);
    throw new Error('App activation worker is not available.');
  }
  windowActivationProcess.stdin.write(`${request}\n`, (error) => {
    if (error) {
      const pending = pendingWindowActivations.get(requestId);
      if (pending) {
        pendingWindowActivations.delete(requestId);
        pending.reject(error);
      }
    }
  });
  await response;
}

async function activateRunningWindowOnce(id) {
  await runPowerShell(createWindowScript(
    { id },
    `
  $hWnd = [IntPtr]([System.Convert]::ToInt64([string]$request.id, 16))
  if (-not [PillWindowApi]::IsWindow($hWnd)) { throw 'The selected window is no longer available.' }
  if ([PillWindowApi]::IsIconic($hWnd)) {
    [void][PillWindowApi]::ShowWindowAsync($hWnd, 9)
  }
  if (-not [PillWindowApi]::SetForegroundWindow($hWnd)) {
    throw 'Windows did not allow the selected app to become active.'
  }
`,
  ));
}

function createWindowScript(request, body) {
  const requestJson = Buffer.from(JSON.stringify(request)).toString('base64');
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -TypeDefinition @'
${windowApi}
'@
  $request = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${requestJson}')) | ConvertFrom-Json
  ${body}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
}

function createMediaScript(request, body) {
  const requestJson = Buffer.from(JSON.stringify(request)).toString('base64');
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
  function Wait-WinRt($operation, [Type]$resultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Length -eq 1 -and $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().FullName -eq 'Windows.Foundation.IAsyncOperation\`1'
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($resultType).Invoke($null, [object[]]@($operation))
    return $task.GetAwaiter().GetResult()
  }
  $request = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${requestJson}')) | ConvertFrom-Json
  ${body}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
}

function createNotificationListenerScript() {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $null = [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]
  $null = [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType=WindowsRuntime]
  function Wait-WinRt($operation, [Type]$resultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Length -eq 1 -and $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().FullName -eq 'Windows.Foundation.IAsyncOperation\`1'
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($resultType).Invoke($null, [object[]]@($operation))
    return $task.GetAwaiter().GetResult()
  }
  function Write-ListenerMessage($message) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $message -Compress -Depth 4))
    [Console]::Out.Flush()
  }
  function Get-NotificationKey($notification) {
    return '{0}:{1}' -f $notification.Id, $notification.CreationTime.UtcDateTime.Ticks
  }
  function Convert-Notification($notification) {
    $appName = [string]$notification.AppInfo.DisplayInfo.DisplayName
    if (-not $appName) { $appName = [string]$notification.AppInfo.AppUserModelId }
    if (-not $appName) { $appName = 'Windows' }

    $texts = @()
    $binding = $notification.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
    if ($binding) {
      foreach ($element in @($binding.GetTextElements())) {
        $text = [string]$element.Text
        if ($text) { $texts += $text }
      }
    }

    $title = if ($texts.Count -gt 0) { $texts[0] } else { $appName }
    $message = if ($texts.Count -gt 1) { $texts[1..($texts.Count - 1)] -join ' ' } else { '' }
    if ($title.Length -gt 240) { $title = $title.Substring(0, 240) }
    if ($message.Length -gt 900) { $message = $message.Substring(0, 900) }
    return @{
      appName = $appName
      title = $title
      message = $message
    }
  }

  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $access = $listener.GetAccessStatus().ToString()
  $lastAccess = $access
  Write-ListenerMessage @{ type = 'status'; access = $access }
  while ($access -ne 'Allowed') {
    Start-Sleep -Seconds 2
    $access = $listener.GetAccessStatus().ToString()
    if ($access -ne $lastAccess) {
      Write-ListenerMessage @{ type = 'status'; access = $access }
      $lastAccess = $access
    }
  }

  $notificationType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
  $knownNotifications = [System.Collections.Generic.HashSet[string]]::new()
  $notifications = Wait-WinRt ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $notificationType
  foreach ($notification in $notifications) {
    [void]$knownNotifications.Add((Get-NotificationKey $notification))
  }

  while ($true) {
    Start-Sleep -Milliseconds 800
    $notifications = Wait-WinRt ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $notificationType
    foreach ($notification in $notifications) {
      $key = Get-NotificationKey $notification
      if ($knownNotifications.Add($key)) {
        try {
          $payload = Convert-Notification $notification
          $payload.type = 'notification'
          Write-ListenerMessage $payload
        } catch {
          [Console]::Error.WriteLine('Could not read a Windows notification: ' + $_.Exception.Message)
        }
      }
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  Write-ListenerMessage @{ type = 'status'; access = 'Unavailable' }
  exit 1
}`;
}

async function getMediaSession() {
  if (process.platform !== 'win32') {
    throw new Error('Media controls are only supported on Windows.');
  }

  const output = await runPowerShell(createMediaScript(
    {},
    `
  $manager = Wait-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime])
  $sessions = @($manager.GetSessions())
  $session = $null
  foreach ($candidate in $sessions) {
    if ($candidate.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') {
      $session = $candidate
      break
    }
  }
  if (-not $session) { $session = $manager.GetCurrentSession() }
  if (-not $session) {
    ConvertTo-Json -InputObject @{ available = $false } -Compress
    exit 0
  }

  $media = Wait-WinRt ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime])
  $playback = $session.GetPlaybackInfo()
  $thumbnail = $null
  if ($media.Thumbnail) {
    try {
      $stream = Wait-WinRt ($media.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage, ContentType=WindowsRuntime])
      $streamMethod = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsStream' -and $_.GetParameters().Length -eq 1
      } | Select-Object -First 1
      $readableStream = $streamMethod.Invoke($null, [object[]]@($stream))
      $memory = [System.IO.MemoryStream]::new()
      $buffer = [byte[]]::new(81920)
      $totalBytes = 0
      while ($totalBytes -lt 5242880) {
        $bytesToRead = [Math]::Min($buffer.Length, 5242880 - $totalBytes)
        $bytesRead = $readableStream.Read($buffer, 0, $bytesToRead)
        if ($bytesRead -eq 0) { break }
        $memory.Write($buffer, 0, $bytesRead)
        $totalBytes += $bytesRead
      }

      $bytes = $memory.ToArray()
      $hasMoreBytes = $totalBytes -eq 5242880 -and $readableStream.ReadByte() -ne -1
      $contentType = 'image/jpeg'
      if ($bytes.Length -ge 8 -and $bytes[0] -eq 137 -and $bytes[1] -eq 80) {
        $contentType = 'image/png'
      } elseif ($bytes.Length -ge 12 -and [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4) -eq 'RIFF' -and [System.Text.Encoding]::ASCII.GetString($bytes, 8, 4) -eq 'WEBP') {
        $contentType = 'image/webp'
      } elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 71 -and $bytes[1] -eq 73 -and $bytes[2] -eq 70) {
        $contentType = 'image/gif'
      }
      if ($bytes.Length -gt 0 -and -not $hasMoreBytes) {
        $thumbnail = 'data:' + $contentType + ';base64,' + [System.Convert]::ToBase64String($bytes)
      }
      $readableStream.Dispose()
      $memory.Dispose()
    } catch {
      [Console]::Error.WriteLine('Could not read Windows media artwork: ' + $_.Exception.Message)
    }
  }
  ConvertTo-Json -InputObject @{
    available = $true
    sessionId = $session.SourceAppUserModelId
    title = $media.Title
    artist = $media.Artist
    album = $media.AlbumTitle
    playbackStatus = $playback.PlaybackStatus.ToString()
    thumbnail = $thumbnail
  } -Compress
`,
  ));
  return output ? JSON.parse(output) : { available: false };
}

async function controlMediaSession(sessionId, action) {
  if (process.platform !== 'win32') {
    throw new Error('Media controls are only supported on Windows.');
  }

  const output = await runPowerShell(createMediaScript(
    { sessionId, action },
    `
  $manager = Wait-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime])
  $session = $null
  foreach ($candidate in @($manager.GetSessions())) {
    if ($candidate.SourceAppUserModelId -eq $request.sessionId) {
      $session = $candidate
      break
    }
  }
  if (-not $session) { throw 'The selected media session is no longer available.' }

  switch ($request.action) {
    'toggle' { $result = Wait-WinRt ($session.TryTogglePlayPauseAsync()) ([bool]) }
    'previous' { $result = Wait-WinRt ($session.TrySkipPreviousAsync()) ([bool]) }
    'next' { $result = Wait-WinRt ($session.TrySkipNextAsync()) ([bool]) }
    default { throw 'Invalid media control action.' }
  }
  if (-not $result) { throw 'The media app did not accept the requested control.' }
  ConvertTo-Json -InputObject @{ success = $true } -Compress
`,
  ));
  if (!output) {
    throw new Error('Windows did not confirm the media control action.');
  }
}

async function getRunningWindows() {
  if (process.platform !== 'win32') {
    throw new Error('Running window management is only supported on Windows.');
  }

  const output = await runPowerShell(createWindowScript(
    { processId: process.pid },
    `
  $windows = [System.Collections.Generic.List[object]]::new()
  $foreground = [PillWindowApi]::GetForegroundWindow()
  $callback = [PillWindowApi+EnumWindowsProc] {
    param($hWnd, $lParam)
    if (-not [PillWindowApi]::IsWindowVisible($hWnd)) { return $true }
    $length = [PillWindowApi]::GetWindowTextLength($hWnd)
    if ($length -le 0) { return $true }
    [uint32]$ownerProcessId = 0
    [void][PillWindowApi]::GetWindowThreadProcessId($hWnd, [ref]$ownerProcessId)
    if ($ownerProcessId -eq $request.processId) { return $true }
    $title = [System.Text.StringBuilder]::new($length + 1)
    [void][PillWindowApi]::GetWindowText($hWnd, $title, $title.Capacity)
    $handle = $hWnd.ToInt64().ToString('X')
    [void]$windows.Add([pscustomobject]@{
      id = $handle
      title = $title.ToString()
      minimized = [PillWindowApi]::IsIconic($hWnd)
      active = ($hWnd -eq $foreground)
    })
    return $true
  }
  [void][PillWindowApi]::EnumWindows($callback, [IntPtr]::Zero)
  ConvertTo-Json -InputObject @($windows.ToArray()) -Compress
`,
  ));

  const windows = output ? JSON.parse(output) : [];
  runningWindows.clear();
  for (const window of windows) {
    runningWindows.set(window.id, true);
  }
  return windows;
}

async function toggleRunningWindow(id) {
  if (process.platform !== 'win32') {
    throw new Error('Running window management is only supported on Windows.');
  }
  if (!runningWindows.has(id)) {
    throw new Error('The selected window is no longer available.');
  }

  await runPowerShell(createWindowScript(
    { id },
    `
  $hWnd = [IntPtr]([System.Convert]::ToInt64([string]$request.id, 16))
  if (-not [PillWindowApi]::IsWindow($hWnd)) { throw 'The selected window is no longer available.' }
  if ([PillWindowApi]::IsIconic($hWnd) -or $hWnd -ne [PillWindowApi]::GetForegroundWindow()) {
    if ([PillWindowApi]::IsIconic($hWnd)) {
      [void][PillWindowApi]::ShowWindowAsync($hWnd, 9)
    }
    if (-not [PillWindowApi]::SetForegroundWindow($hWnd)) {
      throw 'Windows did not allow the selected app to become active.'
    }
  } else {
    [void][PillWindowApi]::ShowWindowAsync($hWnd, 6)
  }
`,
  ));
}

async function activateRunningWindow(id) {
  if (process.platform !== 'win32') {
    throw new Error('Running window management is only supported on Windows.');
  }
  if (!runningWindows.has(id)) {
    throw new Error('The selected window is no longer available.');
  }

  try {
    await requestWindowActivation(id);
  } catch (error) {
    console.error('App activation worker failed; retrying with one-shot activation:', error);
    try {
      await activateRunningWindowOnce(id);
    } catch (fallbackError) {
      throw new Error(
        `Could not activate the selected app using the worker or fallback: ${fallbackError.message}`,
        { cause: error },
      );
    }
  }
}

async function findStartMenuShortcuts(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const shortcuts = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      shortcuts.push(...await findStartMenuShortcuts(entryPath));
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.lnk') {
      shortcuts.push({
        name: path.basename(entry.name, path.extname(entry.name)),
        path: entryPath,
      });
    }
  }
  return shortcuts;
}

async function getInstalledApps() {
  if (process.platform !== 'win32') {
    throw new Error('App search is only supported on Windows.');
  }

  const directories = [
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const shortcuts = (await Promise.all(directories.map(findStartMenuShortcuts))).flat();
  shortcuts.sort((left, right) => left.name.localeCompare(right.name));

  installedApps.clear();
  return shortcuts.map((shortcut, index) => {
    const id = String(index);
    installedApps.set(id, shortcut.path);
    return { id, name: shortcut.name };
  });
}

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    width: collapsedSize.width,
    height: collapsedSize.height,
    icon: path.join(__dirname, 'the-pill-app-icon.png'),
    useContentSize: true,
    x: Math.round(bounds.x + (bounds.width - collapsedSize.width) / 2),
    y: bounds.y,
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  let currentSize = collapsedSize;
  let notificationOpen = false;

  function keepWindowOnTop() {
    if (window.isDestroyed()) {
      return;
    }

    window.setAlwaysOnTop(true, 'screen-saver');
    window.moveTop();
  }

  function setWindowSize(size) {
    currentSize = size;
    const displayedSize = notificationOpen ? notificationSize : size;
    window.setContentSize(displayedSize.width, displayedSize.height);
    keepWindowOnTop();
  }

  function setNotificationOpen(isOpen) {
    if (notificationOpen === isOpen) {
      return;
    }

    notificationOpen = isOpen;
    const displayedSize = notificationOpen ? notificationSize : currentSize;
    window.setContentSize(displayedSize.width, displayedSize.height);
    window.setIgnoreMouseEvents(!notificationOpen && currentSize === collapsedSize, { forward: true });
    keepWindowOnTop();
  }

  keepWindowOnTop();
  window.on('focus', keepWindowOnTop);
  window.on('blur', keepWindowOnTop);
  window.setIgnoreMouseEvents(true, { forward: true });
  ipcMain.on('pill:set-interactive', (event, interactive) => {
    if (event.sender === window.webContents && typeof interactive === 'boolean') {
      if (!notificationOpen) {
        window.setIgnoreMouseEvents(!interactive, { forward: true });
      }
      if (interactive || notificationOpen) {
        keepWindowOnTop();
      }
    }
  });
  ipcMain.handle('pill:set-expanded', (event, expanded) => {
    if (event.sender !== window.webContents || typeof expanded !== 'boolean') {
      throw new Error('Unauthorized pill size request');
    }

    const size = expanded ? expandedSize : collapsedSize;
    setWindowSize(size);
    if (!expanded && !notificationOpen) {
      window.setIgnoreMouseEvents(true, { forward: true });
    }
  });
  ipcMain.handle('pill:focus-window', (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized pill focus request');
    }
    window.setIgnoreMouseEvents(false);
    window.focus();
    window.webContents.focus();
  });
  ipcMain.handle('pill:set-notification-open', (event, isOpen) => {
    if (event.sender !== window.webContents || typeof isOpen !== 'boolean') {
      throw new Error('Invalid notification window request');
    }
    setNotificationOpen(isOpen);
  });
  ipcMain.handle('pill:open-notification-settings', async (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized notification settings request');
    }
    await shell.openExternal('ms-settings:privacy-notifications');
  });
  ipcMain.on('pill:set-apps-open', (event, isOpen) => {
    if (event.sender !== window.webContents || typeof isOpen !== 'boolean') {
      return;
    }

    const size = isOpen ? appsExpandedSize : expandedSize;
    setWindowSize(size);
  });
  ipcMain.on('pill:set-music-open', (event, isOpen) => {
    if (event.sender !== window.webContents || typeof isOpen !== 'boolean') {
      return;
    }

    const size = isOpen ? musicExpandedSize : expandedSize;
    setWindowSize(size);
  });
  ipcMain.handle('pill:get-media-session', async (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized media session request');
    }
    return getMediaSession();
  });
  ipcMain.handle('pill:control-media-session', async (event, sessionId, action) => {
    if (
      event.sender !== window.webContents
      || typeof sessionId !== 'string'
      || !['toggle', 'previous', 'next'].includes(action)
    ) {
      throw new Error('Invalid media control request');
    }
    await controlMediaSession(sessionId, action);
  });
  ipcMain.handle('pill:get-apps', async (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized app list request');
    }
    return getInstalledApps();
  });
  ipcMain.handle('pill:launch-app', async (event, id) => {
    if (event.sender !== window.webContents || typeof id !== 'string') {
      throw new Error('Invalid app launch request');
    }

    const shortcutPath = installedApps.get(id);
    if (!shortcutPath) {
      throw new Error('The selected app is not available.');
    }

    const error = await shell.openPath(shortcutPath);
    if (error) {
      throw new Error(`Could not launch the selected app: ${error}`);
    }
  });
  ipcMain.handle('pill:get-running-windows', async (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized running windows request');
    }
    return getRunningWindows();
  });
  ipcMain.handle('pill:toggle-running-window', async (event, id) => {
    if (
      event.sender !== window.webContents
      || typeof id !== 'string'
      || !/^[0-9A-Fa-f]+$/.test(id)
    ) {
      throw new Error('Invalid running window request');
    }
    await toggleRunningWindow(id);
  });
  ipcMain.handle('pill:activate-running-window', async (event, id) => {
    if (
      event.sender !== window.webContents
      || typeof id !== 'string'
      || !/^[0-9A-Fa-f]+$/.test(id)
    ) {
      throw new Error('Invalid running window request');
    }
    await activateRunningWindow(id);
  });
  ipcMain.on('pill:running-selection-ended', (event) => {
    if (event.sender === window.webContents) {
      runningAppSelectionActive = false;
    }
  });
  ipcMain.handle('pill:get-volume', (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized volume request');
    }

    return loudness.getVolume();
  });
  ipcMain.handle('pill:set-volume', (event, volume) => {
    if (
      event.sender !== window.webContents
      || typeof volume !== 'number'
      || !Number.isInteger(volume)
      || volume < 0
      || volume > 100
    ) {
      throw new Error('Invalid volume request');
    }

    return loudness.setVolume(volume);
  });

  window.loadFile(path.join(__dirname, 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.once('ready-to-show', () => startNotificationListener(window));

  const sendShortcut = (action, data) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('pill:shortcut', action, data);
    }
  };
  if (!globalShortcut.register('Alt+Space', () => sendShortcut('apps-menu'))) {
    console.error('Could not register the Alt+Space shortcut.');
  }
  if (!globalShortcut.register('Alt+Shift+W', () => sendShortcut('toggle-idle-visibility'))) {
    console.error('Could not register the Alt+Shift+W shortcut.');
  }
  if (!globalShortcut.register('Alt+Shift+Q', () => {
    if (runningAppSelectionActive) {
      sendShortcut('running-apps-cycle');
      return;
    }
    runningAppSelectionActive = true;
    const runningAppsPromise = getRunningWindows();
    sendShortcut('running-apps-start');
    runningAppsPromise.then((runningApps) => {
      sendShortcut('running-apps-loaded', runningApps);
    }).catch((error) => {
      console.error('Could not load running apps for keyboard selection:', error);
      sendShortcut('running-apps-error');
    });
  })) {
    console.error('Could not register the Alt+Shift+Q shortcut.');
  }
  return window;
}

function startNotificationListener(window) {
  if (process.platform !== 'win32') {
    window.webContents.send('pill:notification-listener-status', { access: 'Unavailable' });
    return;
  }

  const encodedScript = Buffer.from(createNotificationListenerScript(), 'utf16le').toString('base64');
  const listener = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encodedScript,
  ], { windowsHide: true });
  notificationProcess = listener;
  let listenerAccessStatus;

  const output = readline.createInterface({ input: listener.stdout });
  output.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error('Could not parse Windows notification listener output:', error);
      return;
    }

    if (message.type === 'status' && typeof message.access === 'string') {
      listenerAccessStatus = message.access;
      window.webContents.send('pill:notification-listener-status', { access: message.access });
      return;
    }
    if (
      message.type === 'notification'
      && typeof message.appName === 'string'
      && typeof message.title === 'string'
      && typeof message.message === 'string'
    ) {
      window.webContents.send('pill:notification', {
        appName: message.appName.slice(0, 200),
        title: message.title.slice(0, 240),
        message: message.message.slice(0, 900),
      });
    }
  });

  listener.stderr.setEncoding('utf8');
  listener.stderr.on('data', (data) => {
    console.error('Windows notification listener:', data.trim());
  });
  listener.on('error', (error) => {
    console.error('Failed to start Windows notification listener:', error);
    if (listenerAccessStatus !== 'Unavailable') {
      listenerAccessStatus = 'Unavailable';
      window.webContents.send('pill:notification-listener-status', { access: 'Unavailable' });
    }
  });
  listener.on('close', (code) => {
    if (notificationProcess === listener) {
      notificationProcess = undefined;
      if (!appIsQuitting && listenerAccessStatus !== 'Unavailable') {
        listenerAccessStatus = 'Unavailable';
        console.error(`Windows notification listener exited with code ${code}.`);
        window.webContents.send('pill:notification-listener-status', { access: 'Unavailable' });
      }
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    startWindowActivationWorker().catch((error) => {
      console.error('Could not start app activation worker:', error);
    });
  }
  const window = createWindow();
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'the-pill-app-icon.png'));
  if (trayIcon.isEmpty()) {
    throw new Error('Could not load the system tray icon.');
  }
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('The Pill');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show The Pill',
      click: () => {
        if (!window.isDestroyed()) {
          window.show();
          window.focus();
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit The Pill', click: () => app.quit() },
  ]));
  tray.on('click', () => {
    if (window.isDestroyed()) {
      return;
    }
    if (window.isVisible()) {
      window.hide();
    } else {
      window.show();
      window.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (notificationProcess) {
    notificationProcess.kill();
    notificationProcess = undefined;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  appIsQuitting = true;
  if (tray) {
    tray.destroy();
    tray = undefined;
  }
  globalShortcut.unregisterAll();
  if (windowActivationProcess) {
    windowActivationProcess.kill();
    windowActivationProcess = undefined;
    windowActivationReady = undefined;
  }
  if (notificationProcess) {
    notificationProcess.kill();
    notificationProcess = undefined;
  }
});