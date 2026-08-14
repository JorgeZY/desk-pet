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

$modelArchive = Join-Path $downloads 'vits-melo-tts-zh_en.tar.bz2'
$dataArchive = Join-Path $downloads 'espeak-ng-data.tar.bz2'
$modelExtracted = Join-Path $staging 'vits-melo-tts-zh_en'
$dataExtracted = Join-Path $staging 'espeak-ng-data'

$modelUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2'
$dataUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.bz2'

function Test-TtsModelReady {
  (Test-Path -LiteralPath (Join-Path $target 'model.onnx')) -and
    (Test-Path -LiteralPath (Join-Path $target 'lexicon.txt')) -and
    (Test-Path -LiteralPath (Join-Path $target 'tokens.txt')) -and
    (Test-Path -LiteralPath $dataTarget) -and
    ((Get-ChildItem -LiteralPath $dataTarget -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
}

if (-not $Force -and (Test-TtsModelReady)) {
  Write-Host 'VITS Melo Chinese-English TTS model is already installed.'
  exit 0
}

New-Item -ItemType Directory -Force -Path $speechModels | Out-Null
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

function Get-Archive([string]$Url, [string]$Archive) {
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
      Write-Host "Downloading $Url (attempt $($attempt + 1))..."
      Invoke-WebRequest -Uri $Url -OutFile $Archive
      return
    } catch {
      if ($attempt -eq 2) { throw }
      Write-Host "Download failed, retrying: $($_.Exception.Message)"
      Start-Sleep -Seconds 3
    }
  }
}

try {
  if (-not $Force -and (Test-Path -LiteralPath (Join-Path $target 'model.onnx'))) {
    Write-Host 'Reusing cached VITS Melo model archive files.'
  } else {
    Get-Archive $modelUrl $modelArchive
  }
  if (-not $Force -and (Test-Path -LiteralPath $dataTarget) -and
      ((Get-ChildItem -LiteralPath $dataTarget -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)) {
    Write-Host 'Reusing cached espeak-ng data.'
  } else {
    Get-Archive $dataUrl $dataArchive
  }

  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null

  if (Test-Path -LiteralPath $modelArchive) {
    tar -xjf $modelArchive -C $staging
    if ($LASTEXITCODE -ne 0) {
      throw "tar failed with exit code $LASTEXITCODE"
    }
    # The archive is expected to extract to ./vits-melo-tts-zh_en, but accept
    # any staging subdirectory that contains the three required files.
    if (-not (Test-Path -LiteralPath (Join-Path $modelExtracted 'model.onnx'))) {
      $found = Get-ChildItem -LiteralPath $staging -Directory |
        Where-Object {
          (Test-Path -LiteralPath (Join-Path $_.FullName 'model.onnx')) -and
          (Test-Path -LiteralPath (Join-Path $_.FullName 'lexicon.txt')) -and
          (Test-Path -LiteralPath (Join-Path $_.FullName 'tokens.txt'))
        } | Select-Object -First 1
      if ($null -eq $found) {
        throw 'TTS archive is missing model.onnx, lexicon.txt, or tokens.txt.'
      }
      $script:modelExtracted = $found.FullName
    }
    if (-not (Test-Path -LiteralPath (Join-Path $script:modelExtracted 'model.onnx')) -or
        -not (Test-Path -LiteralPath (Join-Path $script:modelExtracted 'lexicon.txt')) -or
        -not (Test-Path -LiteralPath (Join-Path $script:modelExtracted 'tokens.txt'))) {
      throw 'TTS archive is missing model.onnx, lexicon.txt, or tokens.txt.'
    }
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
    Move-Item -LiteralPath $script:modelExtracted -Destination $target
  }

  if (Test-Path -LiteralPath $dataArchive) {
    tar -xjf $dataArchive -C $staging
    if ($LASTEXITCODE -ne 0) {
      throw "tar failed with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath $dataExtracted)) {
      $found = Get-ChildItem -LiteralPath $staging -Directory |
        Where-Object { $_.Name -match 'espeak' } |
        Select-Object -First 1
      if ($null -eq $found) {
        throw 'espeak-ng-data archive is missing its data directory.'
      }
      $script:dataExtracted = $found.FullName
    }
    if (Test-Path -LiteralPath $dataTarget) {
      Remove-Item -LiteralPath $dataTarget -Recurse -Force
    }
    Move-Item -LiteralPath $script:dataExtracted -Destination $dataTarget
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
