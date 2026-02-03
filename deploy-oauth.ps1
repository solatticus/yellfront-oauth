# deploy-oauth.ps1 - Update yellfront OAuth config from Google JSON
param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$JsonPath
)

if (-not (Test-Path $JsonPath)) {
    Write-Error "File not found: $JsonPath"
    exit 1
}

# Parse Google's JSON
$json = Get-Content $JsonPath -Raw | ConvertFrom-Json
$config = $json.web

if (-not $config) {
    Write-Error "Invalid Google OAuth JSON - missing 'web' key"
    exit 1
}

$clientId = $config.client_id
$clientSecret = $config.client_secret
$redirectUri = $config.redirect_uris[0]

Write-Host "Deploying OAuth config to relay..." -ForegroundColor Cyan
Write-Host "  Client ID: $clientId"
Write-Host "  Redirect:  $redirectUri"

# Build .env content
$envContent = @"
# Google OAuth credentials
GOOGLE_CLIENT_ID=$clientId
GOOGLE_CLIENT_SECRET=$clientSecret
GOOGLE_REDIRECT_URI=$redirectUri

# Server config
PORT=3847

# Where to redirect after successful auth
DEFAULT_RETURN_URL=https://flut.live/dashboard
"@

# Push to relay: pull latest code, update .env, restart
$envContent | ssh relay "cd /opt/yellfront-oauth && sudo git pull && sudo tee .env > /dev/null && sudo chmod 600 .env && sudo chown www-data:www-data .env"

if ($LASTEXITCODE -eq 0) {
    ssh relay "sudo systemctl restart yellfront"
    Write-Host ""
    Write-Host "Done! Testing health endpoint..." -ForegroundColor Green
    $health = Invoke-RestMethod -Uri "https://flut.live/precombopulator/health" -ErrorAction SilentlyContinue
    if ($health.status -eq "ok") {
        Write-Host "Service is healthy." -ForegroundColor Green
    } else {
        Write-Host "Warning: Health check failed" -ForegroundColor Yellow
    }
} else {
    Write-Error "Failed to update relay"
    exit 1
}
