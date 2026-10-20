# PST Explorer: Outlook worker for the consolidated PST export (src/pstexport.js).
# It drives Outlook through COM: moving an item between two PST stores is a MAPI
# copy of all its properties (dates, read state, categories, flags, RTF, S/MIME,
# recurrences, contacts...), which is what makes the export lossless.
# The sources are always disposable working copies, never the original backups.
#
# Protocol: one JSON command per line on stdin, one JSON reply per line on stdout.
#   start      {profile}                        attach to Outlook (started with <profile> if closed)
#   addStore   {key, path}                      attach a PST (created if missing)
#   move       {src, items:[{nid, dest, folder, cls}], buckets}
#              moves items of store <src> to <dest> (store key) under the folder
#              path <folder> (array of names); dest null = choose the bucket by date
#   listItems  {src}                            every item of a store: {path, cls, nids}
#   removeStore{key}
#   quit                                        closes Outlook and ends
param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$PR_RECORD_KEY = 'http://schemas.microsoft.com/mapi/proptag/0x0FF90102'
$PR_DELIVERY = 'http://schemas.microsoft.com/mapi/proptag/0x0E060040'
$ol = $null
$ns = $null
$startedHere = $false
$stores = @{}       # key -> @{ store; id; prefix }
$folderCache = @{}  # "dest|a/b/c" -> folder

function Reply($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }
function Hex($bytes) { ($bytes | ForEach-Object { $_.ToString('X2') }) -join '' }
function Release($o) { if ($o) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } }

# Stores are looked up through the folder list: a damaged store in the profile
# makes Namespace.Stores enumeration fail, but not this.
function Find-Store($path) {
  for ($i = 1; $i -le $ns.Folders.Count; $i++) {
    try {
      $f = $ns.Folders.Item($i)
      if ($f.Store.FilePath -ieq $path) { return $f.Store }
    } catch { }
  }
  return $null
}

function Add-Store($key, $path) {
  $s = Find-Store $path
  if (-not $s) {
    if (Test-Path -LiteralPath $path) { $ns.AddStore($path) } else { $ns.AddStoreEx($path, 2) } # 2 = olStoreUnicode
    $s = Find-Store $path
  }
  if (-not $s) { throw "Outlook did not open $path" }
  $rk = $s.PropertyAccessor.GetProperty($PR_RECORD_KEY)
  # EntryID of an item of a PST: 4 flag bytes + record key of the store + NID (little endian)
  $stores[$key] = @{ store = $s; id = $s.StoreID; prefix = '00000000' + (Hex $rk); path = $path }
  return $s
}

# Container class of the source folder -> OlDefaultFolders type of the new folder
function Folder-Type($cls) {
  switch -Regex ($cls) {
    '^IPF\.Appointment' { return 9 }
    '^IPF\.Contact' { return 10 }
    '^IPF\.Journal' { return 11 }
    '^IPF\.StickyNote' { return 12 }
    '^IPF\.Task' { return 13 }
    default { return 6 }
  }
}

function Get-Folder($dest, $names, $cls) {
  $ck = "$dest|" + ($names -join [char]1)
  if ($folderCache.ContainsKey($ck)) { return $folderCache[$ck] }
  $f = $stores[$dest].store.GetRootFolder()
  $path = @()
  foreach ($n in $names) {
    $path += $n
    $k = "$dest|" + ($path -join [char]1)
    if ($folderCache.ContainsKey($k)) { $f = $folderCache[$k]; continue }
    $child = $null
    try { $child = $f.Folders.Item($n) } catch { }
    if (-not $child) {
      $type = if ($path.Count -eq $names.Count) { Folder-Type $cls } else { 6 }
      $child = $f.Folders.Add($n, $type)
    }
    $folderCache[$k] = $child
    $f = $child
  }
  return $f
}

function Item-Year($item) {
  try { $d = $item.PropertyAccessor.GetProperty($PR_DELIVERY); if ($d) { return ([datetime]$d).Year } } catch { }
  try { return $item.CreationTime.Year } catch { return $null }
}

function Bucket-For($year, $buckets) {
  if ($null -eq $year) { return $buckets[-1].key }
  foreach ($b in $buckets) { if ($year -ge $b.from -and $year -le $b.to) { return $b.key } }
  if ($year -lt $buckets[0].from) { return $buckets[0].key }
  return $buckets[-1].key
}

function Move-Items($cmd) {
  $src = $stores[$cmd.src]
  $out = New-Object System.Collections.ArrayList
  foreach ($it in $cmd.items) {
    $nid = [uint32]$it.nid
    $eid = $src.prefix + (Hex ([BitConverter]::GetBytes($nid)))
    $item = $null
    try {
      try { $item = $ns.GetItemFromID($eid, $src.id) } catch { [void]$out.Add(@{ nid = $it.nid; ok = $false; notFound = $true }); continue }
      $dest = $it.dest
      if (-not $dest) { $dest = Bucket-For (Item-Year $item) $cmd.buckets }
      $folder = Get-Folder $dest @($it.folder) $it.cls
      $moved = $item.Move($folder)
      Release $moved
      [void]$out.Add(@{ nid = $it.nid; ok = $true; dest = $dest })
    } catch {
      [void]$out.Add(@{ nid = $it.nid; ok = $false; error = $_.Exception.Message })
    } finally { Release $item }
  }
  return , $out.ToArray()
}

function List-Items($key) {
  $src = $stores[$key]
  $pl = $src.prefix.Length
  $out = New-Object System.Collections.ArrayList
  $walk = {
    param($folder, $path)
    $nids = New-Object System.Collections.ArrayList
    $t = $folder.GetTable()
    $t.Columns.RemoveAll()
    [void]$t.Columns.Add('EntryID')
    while (-not $t.EndOfTable) {
      $e = [string]$t.GetNextRow().Item(1)
      if ($e.Length -eq $pl + 8 -and $e.StartsWith($src.prefix, 'OrdinalIgnoreCase')) {
        $b = [byte[]]::new(4)
        for ($i = 0; $i -lt 4; $i++) { $b[$i] = [Convert]::ToByte($e.Substring($pl + 2 * $i, 2), 16) }
        [void]$nids.Add([BitConverter]::ToUInt32($b, 0))
      }
    }
    $cls = @('IPF.Note', 'IPF.Appointment', 'IPF.Contact', 'IPF.Task', 'IPF.Journal', 'IPF.StickyNote')[[int]$folder.DefaultItemType]
    if ($nids.Count) { [void]$out.Add(@{ path = $path; cls = $cls; nids = ($nids -join ',') }) }
    foreach ($c in $folder.Folders) { & $walk $c ($path + @([string]$c.Name)) }
  }
  & $walk $src.store.GetRootFolder() @()
  return , $out.ToArray()
}

# Detaches every PST it attached; closes Outlook only if it was closed before
function Close-Session {
  foreach ($k in @($folderCache.Keys)) { Release $folderCache[$k] }
  $folderCache.Clear()
  foreach ($k in @($stores.Keys)) { try { $ns.RemoveStore($stores[$k].store.GetRootFolder()) } catch { } }
  $stores.Clear()
  if ($ol -and $startedHere) { try { $ol.Quit() } catch { } }
  Release $ns; Release $ol
}

while ($true) {
  $line = [Console]::In.ReadLine()
  # the export process ended (closed or interrupted)
  if ($null -eq $line) { Close-Session; break }
  if (-not $line.Trim()) { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.cmd) {
      'start' {
        # an open Outlook is reused (its session and profile); otherwise it starts with <profile>
        $startedHere = -not (Get-Process OUTLOOK -ErrorAction SilentlyContinue)
        $ol = New-Object -ComObject Outlook.Application
        $ns = $ol.GetNamespace('MAPI')
        if ($startedHere) { $ns.Logon($cmd.profile, [Type]::Missing, $false, $false) }
        Reply @{ ok = $true; version = [string]$ol.Version; profile = [string]$ns.CurrentProfileName; startedHere = $startedHere }
      }
      'addStore' {
        $s = Add-Store $cmd.key $cmd.path
        Reply @{ ok = $true; name = [string]$s.DisplayName; prefix = $stores[$cmd.key].prefix }
      }
      'move' { Reply @{ ok = $true; results = (Move-Items $cmd) } }
      'listItems' { Reply @{ ok = $true; folders = (List-Items $cmd.src) } }
      'removeStore' {
        $s = $stores[$cmd.key]
        if ($s) {
          foreach ($k in @($folderCache.Keys)) { if ($k.StartsWith("$($cmd.key)|")) { Release $folderCache[$k]; $folderCache.Remove($k) } }
          $ns.RemoveStore($s.store.GetRootFolder())
          $stores.Remove($cmd.key)
        }
        Reply @{ ok = $true }
      }
      'quit' {
        Close-Session
        Reply @{ ok = $true }
        exit 0
      }
      default { Reply @{ ok = $false; error = "unknown command $($cmd.cmd)" } }
    }
  } catch {
    Reply @{ ok = $false; error = $_.Exception.Message }
  }
}
