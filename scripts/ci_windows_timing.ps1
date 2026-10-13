# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

# EXPERIMENT: the same work as ci_install.ps1 followed by the python group of
# ci_script.ps1, split into phases that are timed one by one. The JavaScript
# dev build that the hatch build hook runs inside `uv pip install -e` is run
# here as explicit jlpm commands, and the hook is skipped.

$Env:YARN_ENABLE_GLOBAL_CACHE = "1"
$ErrorActionPreference = "stop"

function Invoke-Timed {
    param([string]$Name, [scriptblock]$Block)
    Write-Host "::group::$Name"
    $global:LASTEXITCODE = 0
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $Block
    $code = $LASTEXITCODE
    $sw.Stop()
    Write-Host "::endgroup::"
    $line = "TIMING {0,-24} {1,8:N1}s" -f $Name, $sw.Elapsed.TotalSeconds
    Write-Host $line
    Add-Content -Path $Env:GITHUB_STEP_SUMMARY -Value "    $line"
    if ($code -ne 0) { throw "$Name failed with exit code $code" }
}

Write-Host "::group::diagnostics"
Write-Host "TEMP=$Env:TEMP"
Write-Host "TMP=$Env:TMP"
Write-Host "YARN_GLOBAL_FOLDER=$Env:YARN_GLOBAL_FOLDER"
Write-Host "UV_CACHE_DIR=$Env:UV_CACHE_DIR"
Write-Host "NUMBER_OF_PROCESSORS=$Env:NUMBER_OF_PROCESSORS"
try {
    Get-MpComputerStatus | Select-Object AMRunningMode, AntivirusEnabled, RealTimeProtectionEnabled | Format-List
} catch {
    Write-Host "Get-MpComputerStatus failed: $_"
}
Get-Volume | Where-Object DriveLetter | Format-Table DriveLetter, FileSystem, DriveType, Size, SizeRemaining
Write-Host "::endgroup::"

New-Item -Path $Env:USERPROFILE\.jupyter -ItemType "directory" -Force | Out-Null

Invoke-Timed "pip install uv" { pip install -q --upgrade pip uv }

# The build requirements: jupyter-builder provides jlpm, and `jlpm integrity`
# calls `hatchling version`. The hatch build hook has both in its build environment.
Invoke-Timed "uv install build reqs" { uv pip install --system "hatchling>=1.21.1" "jupyter-builder>=1.1.1" }

# The editable build hook runs `jlpm install` then `jlpm run build`,
# and `build` is `integrity && build:all && cd dev_mode && build`.
Invoke-Timed "jlpm install" { jlpm install }
Invoke-Timed "jlpm integrity" { jlpm run integrity }
Invoke-Timed "jlpm build:all" { jlpm run build:all }
Push-Location dev_mode
Invoke-Timed "dev_mode build" { jlpm run build }
Pop-Location

$Env:SKIP_JUPYTER_BUILDER = "1"
Invoke-Timed "uv pip install -e" { uv pip install --system -e ".[test]" }
Remove-Item Env:\SKIP_JUPYTER_BUILDER

Invoke-Timed "server ext enable" { jupyter server extension enable jupyterlab }

Invoke-Timed "build_check" { python -c "from jupyterlab.commands import build_check; build_check()" }

$Env:JUPYTERLAB_DIR = "$Env:HOME/share/jupyter/lab/"
mkdir $Env:JUPYTERLAB_DIR -ea 0 | Out-Null

$Env:YARN_ENABLE_IMMUTABLE_INSTALLS = 1
Invoke-Timed "jupyter lab build" { jupyter lab build --debug --minimize=False }
Remove-Item Env:\YARN_ENABLE_IMMUTABLE_INSTALLS

Invoke-Timed "pytest" { python -m pytest -n 3 --dist loadgroup --durations=40 }

# Probes: one build at a time, in a fresh app directory under TEMP, the way
# the slow tests in test_jupyterlab.py build. They run after pytest so they do
# not change its timing.
Remove-Item Env:\JUPYTERLAB_DIR
Invoke-Timed "probe build minimize" { jupyter lab build --debug --app-dir "$Env:TEMP\probe-minimize" }
Invoke-Timed "probe build no minimize" { jupyter lab build --debug --minimize=False --app-dir "$Env:TEMP\probe-nominimize" }

if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }
