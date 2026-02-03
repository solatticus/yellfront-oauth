require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3847;

// Trust nginx proxy (for rate limiting to see real IPs)
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// Rate limiting - 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Stricter limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts' },
});

app.use(express.json());

// In-memory state store (use Redis in production for multi-instance)
const pendingStates = new Map();

// Clean up expired states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingStates.entries()) {
    if (now - data.created > 10 * 60 * 1000) { // 10 min expiry
      pendingStates.delete(state);
    }
  }
}, 5 * 60 * 1000);

// OAuth2 client
function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Scopes for Gmail + Calendar + Contacts
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// Health check
app.get('/precombopulator/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start OAuth flow - generates auth URL with CSRF state
app.get('/precombopulator/auth', authLimiter, (req, res) => {
  const state = uuidv4();
  const returnUrl = req.query.return_url || process.env.DEFAULT_RETURN_URL || '/';

  pendingStates.set(state, {
    created: Date.now(),
    returnUrl,
    ip: req.ip,
  });

  const oauth2Client = getOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state,
    prompt: 'consent', // Force consent to get refresh_token
  });

  res.redirect(authUrl);
});

// OAuth callback - this is what Google redirects to
app.get('/precombopulator/yellfront', authLimiter, async (req, res) => {
  const { code, state, error } = req.query;

  // Google returned an error
  if (error) {
    console.error('OAuth error from Google:', error);
    return res.status(400).json({ error: `Google OAuth error: ${error}` });
  }

  // Missing required params
  if (!code || !state) {
    console.warn('Missing code or state in callback', { ip: req.ip });
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  // Validate state (CSRF protection)
  const pendingState = pendingStates.get(state);
  if (!pendingState) {
    console.warn('Invalid or expired state', { state, ip: req.ip });
    return res.status(400).json({ error: 'Invalid or expired state. Please try again.' });
  }

  // Remove used state
  pendingStates.delete(state);

  try {
    const oauth2Client = getOAuth2Client();

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    console.log('OAuth success:', {
      email: userInfo.email,
      hasRefreshToken: !!tokens.refresh_token,
    });

    // TODO: Store tokens in your database keyed by user email
    // For now, we'll return them (in production, redirect to dashboard with session)

    // Option 1: Return JSON (for API testing)
    if (req.query.format === 'json') {
      return res.json({
        success: true,
        user: {
          email: userInfo.email,
          name: userInfo.name,
          picture: userInfo.picture,
        },
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date,
        },
      });
    }

    // Option 2: Redirect to dashboard with success indicator
    const returnUrl = pendingState.returnUrl || '/';
    const separator = returnUrl.includes('?') ? '&' : '?';
    res.redirect(`${returnUrl}${separator}auth=success&email=${encodeURIComponent(userInfo.email)}`);

  } catch (err) {
    console.error('Token exchange failed:', err.message);
    return res.status(500).json({ error: 'Failed to exchange authorization code' });
  }
});

// Refresh token endpoint (for when access_token expires)
app.post('/precombopulator/refresh', authLimiter, async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'Missing refresh_token' });
  }

  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token });

    const { credentials } = await oauth2Client.refreshAccessToken();

    res.json({
      access_token: credentials.access_token,
      expiry_date: credentials.expiry_date,
    });
  } catch (err) {
    console.error('Token refresh failed:', err.message);
    return res.status(401).json({ error: 'Failed to refresh token' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Yellfront OAuth server running on port ${PORT}`);
  console.log(`Callback URL: ${process.env.GOOGLE_REDIRECT_URI}`);
});
