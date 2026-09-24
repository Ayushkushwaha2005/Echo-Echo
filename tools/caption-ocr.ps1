# Windows-only: OCR the GPS Map Camera caption bands with the built-in Windows.Media.Ocr engine.
# Used on 2026-09-25 to re-read every caption independently of the hand transcription.
# Input: a folder of caption-band PNGs (bottom 30% of each photo). Output: JSON of {file, text}.
#   powershell -File tools/caption-ocr.ps1 -dir <pngs> -out <json>
param([string]$dir, [string]$out)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$rows = @()
Get-ChildItem $dir -Filter *.png | Sort-Object Name | % {
  $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($_.FullName)) ([Windows.Storage.StorageFile])
  $s = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $d = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $b = Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $r = Await ($engine.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
  $rows += [pscustomobject]@{ file = $_.BaseName + '.jpg'; text = (($r.Lines | % { $_.Text }) -join ' | ') }
  $s.Dispose()
}
$rows | ConvertTo-Json | Set-Content -Encoding utf8 $out
"done $($rows.Count)"
