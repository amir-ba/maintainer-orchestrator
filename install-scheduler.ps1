# Scale https://github.com/telekom/scale
#
# Copyright (c) 2021 Egor Kirpichev and contributors, Deutsche Telekom AG
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter()]
    [string]$RepositoryPath,

    [Parameter()]
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'ScaleMaintainer\scale'),

    [Parameter()]
    [ValidateRange(1, 1440)]
    [int]$IntervalMinutes = 15,

    [Parameter()]
    [ValidateRange(1, 5)]
    [int]$MaxWorkers = 5,

    [Parameter()]
    [string]$HttpProxy = $env:http_proxy,

    [Parameter()]
    [switch]$Enable,

    [Parameter()]
    [switch]$Uninstall,

    [Parameter()]
    [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryPath) {
    $RepositoryPath = (Resolve-Path (Join-Path $PSScriptRoot '..\scale')).Path
}
$taskName = 'Scale Maintainer Watch'
$configPath = Join-Path $StateDirectory 'config.json'
$orchestratorPath = Join-Path $PSScriptRoot 'orchestrator.mjs'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$taskLogPath = Join-Path $StateDirectory 'logs\scheduler.log'
$taskExecutable = $env:ComSpec
if ($HttpProxy) {
    $taskProxyCommand = 'set "http_proxy={0}" & set "https_proxy={0}" & set "HTTP_PROXY={0}" & set "HTTPS_PROXY={0}" & ' -f $HttpProxy
}
else {
    $taskProxyCommand = ''
}
$taskArguments = '/d /v:on /c "echo === task start !date! !time! === >> ""{3}"" & {4}""{0}"" ""{1}"" --config ""{2}"" >> ""{3}"" 2>&1 & echo === task end !date! !time! exit=!errorlevel! === >> ""{3}"""' -f `
    $nodePath, $orchestratorPath, $configPath, $taskLogPath, $taskProxyCommand

$definition = [ordered]@{
    taskName = $taskName
    enabled = [bool]$Enable
    intervalMinutes = $IntervalMinutes
    multipleInstances = 'IgnoreNew'
    logonType = 'InteractiveToken'
    executable = $taskExecutable
    arguments = $taskArguments
    workingDirectory = $PSScriptRoot
    configPath = $configPath
}

if ($Uninstall) {
    if ($PSCmdlet.ShouldProcess($taskName, 'Unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}
elseif ($PSCmdlet.ShouldProcess($taskName, 'Register scheduled task')) {
    if (-not $WhatIfPreference) {
        New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $StateDirectory 'logs') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $StateDirectory 'workers') -Force | Out-Null

        $workspaceDirectory = Split-Path $RepositoryPath -Parent
        $config = [ordered]@{
            repositoryPath = $RepositoryPath
            stateDirectory = $StateDirectory
            worktreeRoot = (Join-Path $workspaceDirectory '.worktrees\scale-maintainer')
            projectOwner = 'amir-ba'
            projectNumber = 1
            httpProxy = $HttpProxy
            repository = 'telekom/scale'
            forkRepository = 'amir-ba/scale'
            maxWorkers = $MaxWorkers
            maxTriage = 10
            orchestratorModel = 'gpt-5.6-sol'
            workerModel = 'gpt-5.6-terra'
            fallbackModel = 'auto'
            maxAiCredits = 30
            workerTimeoutMs = 21600000
            heartbeatStaleMs = 300000
            maxAttempts = 3
            deniedShellCommands = @(
                'git push --force'
                'git push -f'
                'git reset --hard'
                'git clean'
                'git push upstream'
                'git push --tags'
                'git tag'
                'gh release'
                'yarn force-version'
                'lerna publish'
                'npx lerna publish'
                'npm publish'
                'yarn publish-telekom'
                'yarn prepare-neutral'
            )
            requiredChecks = @(
                'prettier',
                'tslint',
                'unit-tests',
                'e2e-tests',
                'visual-tests',
                'wrapper-build'
            )
        }
        $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText(
            $configPath,
            ($config | ConvertTo-Json -Depth 10),
            $utf8WithoutBom
        )

        $action = New-ScheduledTaskAction `
            -Execute $taskExecutable `
            -Argument $taskArguments `
            -WorkingDirectory $PSScriptRoot
        $trigger = New-ScheduledTaskTrigger `
            -Once `
            -At (Get-Date).AddMinutes(1) `
            -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
        $settings = New-ScheduledTaskSettingsSet `
            -MultipleInstances IgnoreNew `
            -StartWhenAvailable `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
        $principal = New-ScheduledTaskPrincipal `
            -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
            -LogonType Interactive `
            -RunLevel Limited
        $task = New-ScheduledTask `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal

        Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
        if (-not $Enable) {
            Disable-ScheduledTask -TaskName $taskName | Out-Null
        }
    }
}

if ($PassThru) {
    $definition | ConvertTo-Json -Compress
}