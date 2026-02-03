# Yellfront OAuth Proxy

Google OAuth2 callback handler for Gmail/Calendar dashboard.

## Setup

1. Copy `.env.example` to `.env` and fill in your Google credentials
2. `npm install`
3. `npm start`

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/precombopulator/health` | GET | Health check |
| `/precombopulator/auth` | GET | Start OAuth flow |
| `/precombopulator/yellfront` | GET | OAuth callback (Google redirects here) |
| `/precombopulator/refresh` | POST | Refresh access token |

## Nginx Config (for relay)

```nginx
location /precombopulator/ {
    proxy_pass http://127.0.0.1:3847;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Security

- CSRF protection via `state` parameter
- Rate limiting (20 auth requests / 15 min per IP)
- Helmet security headers
- No secrets in URLs or logs
