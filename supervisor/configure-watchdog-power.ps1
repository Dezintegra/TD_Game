param(
    [ValidateNotNullOrEmpty()]
    [string]$TaskName = 'TD pipeline supervisor'
)

$ErrorActionPreference = 'Stop'

# Keep the station-specific launcher, trigger, principal and instance policy.
$task = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop
$settings = $task.Settings
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
Set-ScheduledTask -TaskPath '\' -TaskName $TaskName -Settings $settings -ErrorAction Stop | Out-Null

$saved = (Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop).Settings
if ($saved.DisallowStartIfOnBatteries -or $saved.StopIfGoingOnBatteries) {
    throw "Watchdog power settings were not saved for $TaskName"
}

Write-Output "${TaskName}: watchdog may start and continue on battery power"
