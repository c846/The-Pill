const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  powerMonitor,
  screen,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const loudness = require('loudness');

app.setName('The Pill');

const collapsedSize = { width: 480, height: 8 };
const expandedSize = { width: 480, height: 42 };
const settingsExpandedSize = { width: 480, height: 330 };
const musicExpandedSize = { width: 480, height: 240 };
const appsExpandedSize = { width: 480, height: 360 };
const notificationSize = { width: 480, height: 120 };
const appSwitcherSize = { width: 480, height: 58 };
let notificationProcess;
let appIsQuitting = false;
let launchableAppsCache;
let launchableAppsLoad;
let windowHelper;
let listedWindowHandles = new Set();
let watchingAppSwitcherRelease = false;

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

async function getBatteryStatus() {
  if (process.platform !== 'win32') {
    throw new Error('Battery status is only supported on Windows.');
  }

  const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$battery = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining
if ($null -eq $battery) {
  'null'
} else {
  $status = Get-CimInstance -Namespace root/WMI -ClassName BatteryStatus | Where-Object Active | Select-Object -First 1
  if ($null -eq $status) {
    throw 'Windows did not report battery charging status.'
  }
  ConvertTo-Json -InputObject ([pscustomobject]@{
    Percentage = [int]$battery.EstimatedChargeRemaining
    IsCharging = [bool]$status.Charging -and [bool]$status.PowerOnline
  }) -Compress
}
`);
  const battery = JSON.parse(output);
  if (battery === null) {
    return null;
  }
  if (
    !Number.isInteger(battery.Percentage)
    || battery.Percentage < 0
    || battery.Percentage > 100
    || typeof battery.IsCharging !== 'boolean'
  ) {
    throw new Error('Windows returned invalid battery status.');
  }
  return {
    percentage: battery.Percentage,
    isCharging: battery.IsCharging,
  };
}

async function loadLaunchableApps() {
  if (process.platform !== 'win32') {
    throw new Error('App launching is only supported on Windows.');
  }

  const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$apps = @(Get-StartApps |
  Where-Object { $_.Name -and $_.AppID } |
  Sort-Object Name, AppID |
  ForEach-Object {
    [pscustomobject]@{
      name = [string]$_.Name
      appId = [string]$_.AppID
    }
  })
ConvertTo-Json -InputObject $apps -Compress -Depth 3
`);
  const apps = JSON.parse(output);
  if (!Array.isArray(apps) || apps.some((app) => (
    !app
    || typeof app.name !== 'string'
    || typeof app.appId !== 'string'
    || !app.name
    || !app.appId
  ))) {
    throw new Error('Windows returned an invalid list of launchable apps.');
  }

  return apps;
}

function getLaunchableApps() {
  if (launchableAppsCache) {
    return Promise.resolve(launchableAppsCache);
  }
  if (!launchableAppsLoad) {
    launchableAppsLoad = loadLaunchableApps()
      .then((apps) => {
        launchableAppsCache = apps;
        return apps;
      })
      .catch((error) => {
        launchableAppsLoad = undefined;
        throw error;
      });
  }
  return launchableAppsLoad;
}

async function launchApp(appId) {
  if (process.platform !== 'win32') {
    throw new Error('App launching is only supported on Windows.');
  }
  if (typeof appId !== 'string' || !appId) {
    throw new Error('Invalid app launch request.');
  }

  const apps = await getLaunchableApps();
  if (!apps.some((app) => app.appId === appId)) {
    throw new Error('The requested app is no longer available.');
  }

  const request = Buffer.from(JSON.stringify({ appId })).toString('base64');
  await runPowerShell(`
$ErrorActionPreference = 'Stop'
$request = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${request}')) | ConvertFrom-Json
Start-Process -FilePath 'explorer.exe' -ArgumentList ('"shell:AppsFolder\\' + $request.appId + '"')
`);
}

function createWindowHelperScript() {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class PillWindowInfo {
  public long hwnd { get; set; }
  public string title { get; set; }
  public string appName { get; set; }
}

public static class PillWindows {
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);

  static readonly Dictionary<string, string> AppNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

  static string GetAppName(uint processId) {
    string path = null;
    IntPtr process = OpenProcess(0x1000, false, processId);
    if (process != IntPtr.Zero) {
      try {
        StringBuilder buffer = new StringBuilder(1024);
        uint size = (uint)buffer.Capacity;
        if (QueryFullProcessImageName(process, 0, buffer, ref size)) {
          path = buffer.ToString();
        }
      } finally {
        CloseHandle(process);
      }
    }
    if (path == null) {
      return null;
    }

    string name;
    if (AppNames.TryGetValue(path, out name)) {
      return name;
    }
    try {
      name = FileVersionInfo.GetVersionInfo(path).FileDescription;
    } catch {
      name = null;
    }
    if (String.IsNullOrWhiteSpace(name)) {
      name = Path.GetFileNameWithoutExtension(path);
    }
    name = name.Trim();
    AppNames[path] = name;
    return name;
  }

  public static PillWindowInfo[] List(uint excludedProcessId) {
    List<PillWindowInfo> windows = new List<PillWindowInfo>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) {
        return true;
      }
      int exStyle = GetWindowLong(hWnd, -20);
      bool isAppWindow = (exStyle & 0x40000) != 0;
      bool isToolWindow = (exStyle & 0x80) != 0;
      bool isNoActivate = (exStyle & 0x8000000) != 0;
      if (!isAppWindow && (isToolWindow || isNoActivate || GetWindow(hWnd, 4) != IntPtr.Zero)) {
        return true;
      }
      int cloaked;
      if (DwmGetWindowAttribute(hWnd, 14, out cloaked, 4) == 0 && cloaked != 0) {
        return true;
      }
      int titleLength = GetWindowTextLength(hWnd);
      if (titleLength == 0) {
        return true;
      }
      StringBuilder className = new StringBuilder(256);
      GetClassName(hWnd, className, className.Capacity);
      if (className.ToString() == "Progman") {
        return true;
      }
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      if (processId == excludedProcessId) {
        return true;
      }

      StringBuilder title = new StringBuilder(titleLength + 1);
      GetWindowText(hWnd, title, title.Capacity);
      string titleText = title.ToString().Trim();
      if (titleText.Length == 0) {
        return true;
      }
      // Store apps are hosted by ApplicationFrameHost, so their title is the useful name.
      string appName = className.ToString() == "ApplicationFrameWindow" ? null : GetAppName(processId);
      windows.Add(new PillWindowInfo {
        hwnd = hWnd.ToInt64(),
        title = titleText,
        appName = String.IsNullOrWhiteSpace(appName) ? titleText : appName,
      });
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }

  public static bool Activate(long handle) {
    IntPtr hWnd = new IntPtr(handle);
    if (!IsWindow(hWnd)) {
      return false;
    }
    if (IsIconic(hWnd)) {
      ShowWindow(hWnd, 9);
    }
    if (SetForegroundWindow(hWnd) && GetForegroundWindow() == hWnd) {
      return true;
    }
    // Windows only lets a process take the foreground after it receives input, so tap Alt first.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(hWnd);
    return GetForegroundWindow() == hWnd;
  }

  public static bool IsAltDown() {
    return (GetAsyncKeyState(0x12) & 0x8000) != 0;
  }
}
'@

$excludedProcessId = [uint32]${process.pid}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $parts = $line.Split(' ')
    switch ($parts[0]) {
      'list' { $result = @{ windows = [PillWindows]::List($excludedProcessId) } }
      'activate' { $result = @{ activated = [PillWindows]::Activate([long]$parts[1]) } }
      'alt' { $result = @{ altDown = [PillWindows]::IsAltDown() } }
      default { throw 'Unknown window helper request.' }
    }
  } catch {
    $result = @{ error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress -Depth 4))
  [Console]::Out.Flush()
}`;
}

function getWindowHelper() {
  if (windowHelper) {
    return windowHelper;
  }

  const encodedScript = Buffer.from(createWindowHelperScript(), 'utf16le').toString('base64');
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encodedScript,
  ], { windowsHide: true });
  const helper = { process: child, pending: [] };
  windowHelper = helper;

  const output = readline.createInterface({ input: child.stdout });
  output.on('line', (line) => {
    const request = helper.pending.shift();
    if (!request) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      request.reject(new Error('Could not parse the Windows window helper output.'));
      return;
    }
    if (message && typeof message.error === 'string') {
      request.reject(new Error(message.error));
    } else {
      request.resolve(message);
    }
  });

  const stopHelper = (error) => {
    if (windowHelper === helper) {
      windowHelper = undefined;
    }
    for (const request of helper.pending.splice(0)) {
      request.reject(error);
    }
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => {
    console.error('Windows window helper:', data.trim());
  });
  child.stdin.on('error', (error) => {
    console.error('Failed to write to the Windows window helper:', error);
  });
  child.on('error', (error) => {
    console.error('Failed to start the Windows window helper:', error);
    stopHelper(error);
  });
  child.on('close', (code) => {
    if (!appIsQuitting) {
      console.error(`Windows window helper exited with code ${code}.`);
    }
    stopHelper(new Error('The Windows window helper stopped.'));
  });
  return helper;
}

function requestWindowHelper(command) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('App switching is only supported on Windows.'));
  }

  const helper = getWindowHelper();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out while communicating with Windows.'));
      helper.process.kill();
    }, 10000);
    helper.pending.push({
      resolve: (message) => {
        clearTimeout(timeout);
        resolve(message);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    helper.process.stdin.write(`${command}\n`);
  });
}

async function getOpenWindows() {
  const { windows } = await requestWindowHelper('list');
  if (!Array.isArray(windows) || windows.some((openWindow) => (
    !openWindow
    || !Number.isSafeInteger(openWindow.hwnd)
    || typeof openWindow.title !== 'string'
    || typeof openWindow.appName !== 'string'
  ))) {
    throw new Error('Windows returned an invalid list of open apps.');
  }

  listedWindowHandles = new Set(windows.map((openWindow) => openWindow.hwnd));
  return windows.map(({ hwnd, title, appName }) => ({ hwnd, title, appName }));
}

async function activateWindow(hwnd) {
  if (!listedWindowHandles.has(hwnd)) {
    throw new Error('The requested app is no longer available.');
  }

  const { activated } = await requestWindowHelper(`activate ${hwnd}`);
  if (activated !== true) {
    throw new Error('Windows did not switch to the selected app.');
  }
}

async function isAltKeyDown() {
  const { altDown } = await requestWindowHelper('alt');
  return altDown === true;
}

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    width: collapsedSize.width,
    height: collapsedSize.height,
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
  const sendBatteryPowerSource = (isOnAc) => {
    if (!window.isDestroyed()) {
      window.webContents.send('pill:battery-power-source', isOnAc);
    }
  };
  const onAc = () => sendBatteryPowerSource(true);
  const onBattery = () => sendBatteryPowerSource(false);
  powerMonitor.on('on-ac', onAc);
  powerMonitor.on('on-battery', onBattery);
  window.once('closed', () => {
    powerMonitor.removeListener('on-ac', onAc);
    powerMonitor.removeListener('on-battery', onBattery);
  });

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
    const { bounds } = screen.getDisplayMatching(window.getBounds());
    window.setBounds({
      x: Math.round(bounds.x + (bounds.width - displayedSize.width) / 2),
      y: bounds.y,
      width: displayedSize.width,
      height: displayedSize.height,
    });
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
  ipcMain.handle('pill:set-settings-open', (event, isOpen) => {
    if (event.sender !== window.webContents || typeof isOpen !== 'boolean') {
      throw new Error('Unauthorized pill settings menu request');
    }

    setWindowSize(isOpen ? settingsExpandedSize : expandedSize);
  });
  ipcMain.handle('pill:set-apps-open', (event, isOpen) => {
    if (event.sender !== window.webContents || typeof isOpen !== 'boolean') {
      throw new Error('Unauthorized pill apps panel request');
    }

    setWindowSize(isOpen ? appsExpandedSize : expandedSize);
  });
  ipcMain.handle('pill:set-app-switcher-open', (event, isOpen) => {
    if (event.sender !== window.webContents || typeof isOpen !== 'boolean') {
      throw new Error('Unauthorized pill app switcher request');
    }

    setWindowSize(isOpen ? appSwitcherSize : expandedSize);
  });
  ipcMain.handle('pill:get-open-windows', (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized open apps request');
    }

    return getOpenWindows();
  });
  ipcMain.handle('pill:activate-window', (event, hwnd) => {
    if (event.sender !== window.webContents || !Number.isSafeInteger(hwnd)) {
      throw new Error('Invalid app switch request');
    }

    return activateWindow(hwnd);
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
  ipcMain.handle('pill:get-volume', (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized volume request');
    }

    return loudness.getVolume();
  });
  ipcMain.handle('pill:get-battery-status', (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized battery status request');
    }

    return getBatteryStatus();
  });
  ipcMain.handle('pill:get-launchable-apps', (event) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized launchable apps request');
    }

    return getLaunchableApps();
  });
  ipcMain.handle('pill:launch-app', (event, appId) => {
    if (event.sender !== window.webContents) {
      throw new Error('Unauthorized app launch request');
    }

    return launchApp(appId);
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
  if (!globalShortcut.register('Alt+Shift+W', () => sendShortcut('toggle-idle-visibility'))) {
    console.error('Could not register the Alt+Shift+W shortcut.');
  }
  if (!globalShortcut.register('Alt+Space', () => {
    if (notificationOpen || window.isDestroyed()) {
      return;
    }
    window.show();
    window.focus();
    sendShortcut('open-apps-search');
  })) {
    console.error('Could not register the Alt+Space shortcut.');
  }

  async function watchAppSwitcherRelease() {
    if (watchingAppSwitcherRelease) {
      return;
    }

    watchingAppSwitcherRelease = true;
    try {
      while (await isAltKeyDown()) {
        await new Promise((resolve) => { setTimeout(resolve, 30); });
      }
    } catch (error) {
      console.error('Failed to read the Alt key state:', error);
    } finally {
      watchingAppSwitcherRelease = false;
    }
    sendShortcut('app-switcher-release');
  }
  if (!globalShortcut.register('Alt+Shift+Q', () => {
    if (notificationOpen || window.isDestroyed()) {
      return;
    }
    window.show();
    window.focus();
    sendShortcut('app-switcher-next');
    watchAppSwitcherRelease();
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
    getLaunchableApps().catch((error) => {
      console.error('Failed to preload launchable apps:', error);
    });
    isAltKeyDown().catch((error) => {
      console.error('Failed to start the Windows window helper:', error);
    });
  }
  const window = createWindow();
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
  globalShortcut.unregisterAll();
  if (notificationProcess) {
    notificationProcess.kill();
    notificationProcess = undefined;
  }
  if (windowHelper) {
    windowHelper.process.kill();
    windowHelper = undefined;
  }
});