param(
  [Parameter(Mandatory = $true)]
  [string]$ModelRoot,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$speechModels = Join-Path $ModelRoot 'speech'
$downloads = Join-Path $ModelRoot '.downloads'
$target = Join-Path $speechModels 'vits-melo-tts-zh_en'
$dataTarget = Join-Path $speechModels 'espeak-ng-data'
$staging = Join-Path $speechModels '.tts-model-download'

# Primary source: official GitHub release archives.
$modelArchive = Join-Path $downloads 'vits-melo-tts-zh_en.tar.bz2'
$dataArchive = Join-Path $downloads 'espeak-ng-data.tar.bz2'
$modelUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2'
$dataUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.bz2'

# Fallback source: Hugging Face mirror (hf-mirror.com), same files, China-friendly.
$hfModelFiles = @(
  @{ Name = 'model.onnx'; Url = 'https://hf-mirror.com/csukuangfj/vits-melo-tts-zh_en/resolve/main/model.onnx'; MinBytes = 100MB },
  @{ Name = 'lexicon.txt'; Url = 'https://hf-mirror.com/csukuangfj/vits-melo-tts-zh_en/resolve/main/lexicon.txt'; MinBytes = 1MB },
  @{ Name = 'tokens.txt'; Url = 'https://hf-mirror.com/csukuangfj/vits-melo-tts-zh_en/resolve/main/tokens.txt'; MinBytes = 100 }
)
# Minimal espeak-ng data set validated to initialize the melo zh_en frontend:
# phontab/phonindex/phondata plus English/Chinese dictionaries and intonations.
$hfEspeakFiles = @(
  'phondata', 'phonindex', 'phontab', 'en_dict', 'cmn_dict', 'yue_dict', 'intonations'
)

function Test-TtsModelReady {
  (Test-Path -LiteralPath (Join-Path $target 'model.onnx')) -and
    (Test-Path -LiteralPath (Join-Path $target 'lexicon.txt')) -and
    (Test-Path -LiteralPath (Join-Path $target 'tokens.txt')) -and
    (Test-Path -LiteralPath $dataTarget) -and
    ((Get-ChildItem -LiteralPath $dataTarget -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
}

function Test-CachedModel {
  (Test-Path -LiteralPath (Join-Path $target 'model.onnx')) -and
    ((Get-Item -LiteralPath (Join-Path $target 'model.onnx')).Length -gt 100MB) -and
    (Test-Path -LiteralPath (Join-Path $target 'lexicon.txt')) -and
    ((Get-Item -LiteralPath (Join-Path $target 'lexicon.txt')).Length -gt 1MB) -and
    (Test-Path -LiteralPath (Join-Path $target 'tokens.txt')) -and
    ((Get-Item -LiteralPath (Join-Path $target 'tokens.txt')).Length -gt 100)
}

if (-not $Force -and (Test-TtsModelReady)) {
  Write-Host 'VITS Melo Chinese-English TTS model is already installed.'
  exit 0
}

New-Item -ItemType Directory -Force -Path $speechModels | Out-Null
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

function Get-WithRetry([string]$Url, [string]$OutFile, [int]$Attempts = 3, [int]$TimeoutSec = 600, [long]$MinBytes = 0) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    try {
      Write-Host "Downloading $Url (attempt $($attempt + 1))..."
      Invoke-WebRequest -Uri $Url -OutFile $OutFile -TimeoutSec $TimeoutSec
      if ((Test-Path -LiteralPath $OutFile) -and
          (Get-Item -LiteralPath $OutFile).Length -ge $MinBytes) {
        return
      }
      throw "Downloaded file is too small ($MinBytes bytes expected)."
    } catch {
      if ($attempt -eq ($Attempts - 1)) { throw }
      Write-Host "Download failed, retrying: $($_.Exception.Message)"
      Start-Sleep -Seconds 3
    }
  }
}

function Expand-ArchiveInto([string]$Archive, [string]$Staging, [string]$Target, [string]$Kind) {
  New-Item -ItemType Directory -Force -Path $Staging | Out-Null
  tar -xjf $Archive -C $Staging
  if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE"
  }
  $required = if ($Kind -eq 'model') { @('model.onnx', 'lexicon.txt', 'tokens.txt') } else { @('phondata', 'phontab') }
  $extracted = Get-ChildItem -LiteralPath $Staging -Directory |
    Where-Object {
      $dir = $_.FullName
      ($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dir $_)) }).Count -eq 0
    } | Select-Object -First 1
  if ($null -eq $extracted) {
    throw "$Kind archive is missing its expected files."
  }
  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
  }
  Move-Item -LiteralPath $extracted.FullName -Destination $Target
}

function Install-ModelFromHfMirror {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($file in $hfModelFiles) {
    Get-WithRetry $file.Url (Join-Path $target $file.Name) 3 1800 $file.MinBytes
  }
  if (-not (Test-Path -LiteralPath (Join-Path $target 'model.onnx')) -or
      -not (Test-Path -LiteralPath (Join-Path $target 'lexicon.txt')) -or
      -not (Test-Path -LiteralPath (Join-Path $target 'tokens.txt'))) {
    throw 'TTS model is incomplete after the mirror download.'
  }
}

function Install-EspeakFromHfMirror {
  New-Item -ItemType Directory -Force -Path $dataTarget | Out-Null
  foreach ($name in $hfEspeakFiles) {
    Get-WithRetry "https://hf-mirror.com/csukuangfj/kokoro-multi-lang-v1_0/resolve/main/espeak-ng-data/$name" (Join-Path $dataTarget $name) 3 300 100
  }
}

try {
  if (-not $Force -and (Test-CachedModel)) {
    Write-Host 'Reusing cached VITS Melo model files.'
  } else {
    try {
      Get-WithRetry $modelUrl $modelArchive 2 450 100MB
      Expand-ArchiveInto $modelArchive $staging $target 'model'
    } catch {
      Write-Host "GitHub download unavailable, falling back to the HF mirror: $($_.Exception.Message)"
      Remove-Item -LiteralPath $modelArchive -Force -ErrorAction SilentlyContinue
      Install-ModelFromHfMirror
    }
  }

  if (-not $Force -and (Test-Path -LiteralPath $dataTarget) -and
      ((Get-ChildItem -LiteralPath $dataTarget -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)) {
    Write-Host 'Reusing cached espeak-ng data.'
  } else {
    try {
      Get-WithRetry $dataUrl $dataArchive 2 300 1MB
      Expand-ArchiveInto $dataArchive $staging $dataTarget 'espeak-ng-data'
    } catch {
      Write-Host "GitHub download unavailable, falling back to the HF mirror: $($_.Exception.Message)"
      Remove-Item -LiteralPath $dataArchive -Force -ErrorAction SilentlyContinue
      Install-EspeakFromHfMirror
    }
  }

  if (-not (Test-TtsModelReady)) {
    throw 'TTS model or espeak-ng data is incomplete after download.'
  }
} finally {
  Remove-Item -LiteralPath $modelArchive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $dataArchive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "VITS Melo TTS model is ready: $target"
