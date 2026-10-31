// The system dictation of Windows, run by PowerShell with `-Command`.
//
// It is text and not a file on disk so that it needs nothing from the package: Windows ships
// PowerShell, and .NET ships `System.Speech`. The recognizers come from the language packs of
// Windows, so a language that has none is reported, never guessed.
//
// The caller sets `$File`, `$Language` and `$Check` in front of this text, because `-Command`
// does not bind named parameters well. `$Check` answers the number of installed recognizers;
// otherwise `$File` is read and the answer is `{ "text": ... }`, or `{ "error": code, "message": ... }`.

export const WINDOWS_SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech

function Answer($value) { [Console]::Out.Write(($value | ConvertTo-Json -Compress)) }
function Refuse($code, $message) { Answer @{ error = $code; message = $message }; exit 2 }

try {
  $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
} catch {
  Refuse "missing" "System.Speech is unavailable."
}
if ($Check) { Answer @{ recognizers = @($installed).Count }; exit 0 }
if (@($installed).Count -eq 0) { Refuse "missing" "Windows has no speech recognizer installed." }

$wanted = if ($Language -eq "automatic") { [Globalization.CultureInfo]::CurrentUICulture } else {
  try { [Globalization.CultureInfo]::GetCultureInfo(($Language -replace "^jw$", "jv")) } catch { $null }
}
$match = $null
if ($null -ne $wanted) {
  $match = @($installed) | Where-Object { $_.Culture.Name -ieq $wanted.Name } | Select-Object -First 1
  if ($null -eq $match) {
    $match = @($installed) | Where-Object { $_.Culture.TwoLetterISOLanguageName -ieq $wanted.TwoLetterISOLanguageName } | Select-Object -First 1
  }
}
if ($null -eq $match) { Refuse "language" "Windows has no recognizer for this language." }
if (-not (Test-Path -LiteralPath $File)) { Refuse "usage" "The recording is gone." }

$engine = $null
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $match
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToWaveFile($File)
  $parts = New-Object System.Collections.Generic.List[string]
  while ($true) {
    $result = $engine.Recognize()
    if ($null -eq $result) { break }
    $parts.Add($result.Text)
  }
} catch {
  if ($null -ne $engine) { $engine.Dispose() }
  Refuse "recognize" $_.Exception.Message
}
$engine.Dispose()
$text = ($parts -join " ").Trim()
if ($text -eq "") { Refuse "empty" "Nothing was recognized." }
Answer @{ text = $text }
`;
