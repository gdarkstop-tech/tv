<#
  NOVA TV OS — Windows helper process.

  Started by NOVA (never by the remote) with:
    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File nova-helper.ps1

  Protocol: one JSON request per line on stdin  {"id":1,"op":"displays","args":{}}
            one JSON response per line on stdout {"id":1,"ok":true,"result":...}

  Only the operations in the switch below exist. There is intentionally no
  operation that runs arbitrary commands or scripts.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

$sourcePath = Join-Path $PSScriptRoot 'NovaNative.cs'
$cacheDir = $env:NOVA_HELPER_CACHE
$loaded = $false
if ($cacheDir) {
  try {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $sourcePath).Hash.Substring(0, 16)
    $dll = Join-Path $cacheDir ("NovaNative-" + $hash + ".dll")
    if (-not (Test-Path $dll)) {
      New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
      Add-Type -Path $sourcePath -OutputAssembly $dll -OutputType Library
    }
    Add-Type -Path $dll
    $loaded = $true
  } catch {
    $loaded = $false
  }
}
if (-not $loaded) { Add-Type -Path $sourcePath }

function Send-Response([int]$id, [bool]$ok, $result, [string]$err) {
  $obj = [ordered]@{ id = $id; ok = $ok }
  if ($ok) { $obj.result = $result } else { $obj.error = $err }
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 8
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-GpuList {
  $list = @()
  foreach ($g in (Get-CimInstance -ClassName Win32_VideoController)) {
    $list += [ordered]@{
      name = $g.Name
      vendor = $g.AdapterCompatibility
      driverVersion = $g.DriverVersion
      adapterRamBytes = $g.AdapterRAM
      videoProcessor = $g.VideoProcessor
      status = $g.Status
    }
  }
  return ,$list
}

function Get-SystemInfo {
  $cs = Get-CimInstance -ClassName Win32_ComputerSystem
  $os = Get-CimInstance -ClassName Win32_OperatingSystem
  $cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
  return [ordered]@{
    manufacturer = $cs.Manufacturer
    model = $cs.Model
    hypervisorPresent = $cs.HypervisorPresent
    osCaption = $os.Caption
    osVersion = $os.Version
    osBuild = $os.BuildNumber
    cpuName = $cpu.Name
    cpuCores = $cpu.NumberOfCores
    cpuLogical = $cpu.NumberOfLogicalProcessors
  }
}

function Get-ProcessStats([int]$processId) {
  $p = Get-Process -Id $processId -ErrorAction Stop
  return [ordered]@{ cpuSeconds = $p.CPU; workingSetBytes = $p.WorkingSet64 }
}

function Invoke-Op([string]$op, $a) {
  switch ($op) {
    'ping' { return 'pong' }
    'system' { return Get-SystemInfo }
    'gpus' { return Get-GpuList }
    'displays' { return ,([Nova.Displays]::Query()) }
    'ddcProbe' { return [Nova.Ddc]::Probe([string]$a.gdiName) }
    'ddcSet' {
      $code = [byte]$a.code
      $value = [uint32]$a.value
      return [Nova.Ddc]::Set([string]$a.gdiName, $code, $value)
    }
    'volumeGet' { return [Nova.Audio]::Get() }
    'volumeSet' { return [Nova.Audio]::Set([int]$a.level) }
    'muteSet' { return [Nova.Audio]::SetMute([bool]$a.muted) }
    'gpuUsage' { return [Nova.Gpu]::Sample() }
    'processStats' { return Get-ProcessStats ([int]$a.pid) }
    default { throw "unknown operation: $op" }
  }
}

Send-Response 0 $true 'ready' $null

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  if ($line.Length -gt 65536) { Send-Response -1 $false $null 'request too large'; continue }
  $id = -1
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = [int]$req.id
    $result = Invoke-Op ([string]$req.op) $req.args
    Send-Response $id $true $result $null
  } catch {
    Send-Response $id $false $null ($_.Exception.Message)
  }
}
