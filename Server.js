// ============================================
// CYBERGUARD AI - BACKEND SERVER
// ============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================
// MIDDLEWARE & SECURITY
// ============================================

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Simple rate limiting
const requests = new Map();
const RATE_LIMIT = 100;
const WINDOW_MS = 15 * 60 * 1000;

app.use('/api/', (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  
  if (!requests.has(ip)) {
    requests.set(ip, []);
  }
  
  const userRequests = requests.get(ip).filter(time => now - time < WINDOW_MS);
  
  if (userRequests.length >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  userRequests.push(now);
  requests.set(ip, userRequests);
  next();
});

// ============================================
// DATABASE HELPERS (JSON-based)
// ============================================

const DB_PATH = path.join(__dirname, '../database');

async function initDatabase() {
  try {
    await fs.mkdir(DB_PATH, { recursive: true });
    
    const files = {
      'users.json': [],
      'scans.json': [],
      'threats.json': [],
      'analytics.json': {
        totalScans: 0,
        scamsPrevented: 0,
        threatTypes: {},
        dailyStats: []
      }
    };

    for (const [filename, defaultData] of Object.entries(files)) {
      const filepath = path.join(DB_PATH, filename);
      try {
        await fs.access(filepath);
      } catch {
        await fs.writeFile(filepath, JSON.stringify(defaultData, null, 2));
      }
    }
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

async function readDB(filename) {
  try {
    const data = await fs.readFile(path.join(DB_PATH, filename), 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function writeDB(filename, data) {
  try {
    await fs.writeFile(path.join(DB_PATH, filename), JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

const { analyzeURL } = require('./utils/urlAnalyzer');
const { analyzeMessage } = require('./utils/messageAnalyzer');
const { analyzePassword } = require('./utils/passwordAnalyzer');
const { analyzeFile } = require('./utils/fileAnalyzer');

function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[<>]/g, '')
    .trim()
    .substring(0, 10000);
}

// ============================================
// API ROUTES
// ============================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

app.get('/api/analytics', async (req, res) => {
  try {
    const analytics = await readDB('analytics.json');
    const scans = await readDB('scans.json');
    
    const today = new Date().toDateString();
    const todayScans = scans.filter(scan => 
      new Date(scan.timestamp).toDateString() === today &&
      scan.result.riskLevel !== 'safe'
    );

    res.json({
      ...analytics,
      scamsPreventedToday: todayScans.length,
      recentScans: scans.slice(-10).reverse()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.post('/api/scan/url', async (req, res) => {
  try {
    const { url, userId } = req.body;
    const sanitizedURL = sanitizeInput(url);

    if (!sanitizedURL) {
      return res.status(400).json({ error: 'Invalid URL provided' });
    }

    const result = analyzeURL(sanitizedURL);
    
    const scans = await readDB('scans.json');
    scans.push({
      id: Date.now(),
      type: 'url',
      input: sanitizedURL,
      result,
      userId: userId || 'guest',
      timestamp: new Date().toISOString()
    });
    await writeDB('scans.json', scans);

    const analytics = await readDB('analytics.json');
    analytics.totalScans++;
    if (result.riskLevel !== 'safe') {
      analytics.scamsPrevented++;
    }
    analytics.threatTypes.url = (analytics.threatTypes.url || 0) + 1;
    await writeDB('analytics.json', analytics);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Scan failed' });
  }
});

app.post('/api/scan/message', async (req, res) => {
  try {
    const { message, userId, simpleMode } = req.body;
    const sanitizedMessage = sanitizeInput(message);

    if (!sanitizedMessage) {
      return res.status(400).json({ error: 'Invalid message provided' });
    }

    const result = analyzeMessage(sanitizedMessage, simpleMode);
    
    const scans = await readDB('scans.json');
    scans.push({
      id: Date.now(),
      type: 'message',
      input: sanitizedMessage.substring(0, 200),
      result,
      userId: userId || 'guest',
      timestamp: new Date().toISOString()
    });
    await writeDB('scans.json', scans);

    const analytics = await readDB('analytics.json');
    analytics.totalScans++;
    if (result.riskLevel !== 'safe') {
      analytics.scamsPrevented++;
    }
    analytics.threatTypes.message = (analytics.threatTypes.message || 0) + 1;
    await writeDB('analytics.json', analytics);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Analysis failed' });
  }
});

app.post('/api/scan/password', async (req, res) => {
  try {
    const { password, userId } = req.body;

    if (!password || password.length > 128) {
      return res.status(400).json({ error: 'Invalid password' });
    }

    const result = analyzePassword(password);
    
    const scans = await readDB('scans.json');
    scans.push({
      id: Date.now(),
      type: 'password',
      input: '[PROTECTED]',
      result: { strength: result.strength, score: result.score },
      userId: userId || 'guest',
      timestamp: new Date().toISOString()
    });
    await writeDB('scans.json', scans);

    const analytics = await readDB('analytics.json');
    analytics.totalScans++;
    analytics.threatTypes.password = (analytics.threatTypes.password || 0) + 1;
    await writeDB('analytics.json', analytics);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Analysis failed' });
  }
});

app.post('/api/scan/file', async (req, res) => {
  try {
    const { fileName, fileSize, fileType, userId } = req.body;

    if (!fileName) {
      return res.status(400).json({ error: 'Invalid file information' });
    }

    const result = analyzeFile(fileName, fileSize, fileType);
    
    const scans = await readDB('scans.json');
    scans.push({
      id: Date.now(),
      type: 'file',
      input: fileName,
      result,
      userId: userId || 'guest',
      timestamp: new Date().toISOString()
    });
    await writeDB('scans.json', scans);

    const analytics = await readDB('analytics.json');
    analytics.totalScans++;
    if (result.riskLevel !== 'safe') {
      analytics.scamsPrevented++;
    }
    analytics.threatTypes.file = (analytics.threatTypes.file || 0) + 1;
    await writeDB('analytics.json', analytics);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Analysis failed' });
  }
});

app.get('/api/user/:userId/score', async (req, res) => {
  try {
    const { userId } = req.params;
    const scans = await readDB('scans.json');
    
    const userScans = scans.filter(scan => scan.userId === userId);
    const totalScans = userScans.length;
    const safeActions = userScans.filter(scan => 
      scan.result.riskLevel === 'safe' || scan.result.strength === 'strong'
    ).length;

    let score = Math.min(100, Math.floor((safeActions / Math.max(totalScans, 1)) * 100) + totalScans * 2);
    
    let level = 'Beginner';
    if (score >= 80) level = 'Cyber Guardian';
    else if (score >= 60) level = 'Cyber Smart';
    else if (score >= 40) level = 'Safe';
    else if (score >= 20) level = 'Aware';

    res.json({
      score,
      level,
      totalScans,
      safeActions,
      recentScans: userScans.slice(-5).reverse()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate score' });
  }
});

app.get('/api/threats/live', async (req, res) => {
  try {
    const threats = [];
    const types = ['phishing', 'malware', 'weak-password', 'suspicious-link'];
    const locations = [
      { city: 'New York', lat: 40.7128, lon: -74.0060, country: 'USA' },
      { city: 'London', lat: 51.5074, lon: -0.1278, country: 'UK' },
      { city: 'Tokyo', lat: 35.6762, lon: 139.6503, country: 'Japan' },
      { city: 'Mumbai', lat: 19.0760, lon: 72.8777, country: 'India' },
      { city: 'Berlin', lat: 52.5200, lon: 13.4050, country: 'Germany' },
      { city: 'Sydney', lat: -33.8688, lon: 151.2093, country: 'Australia' },
      { city: 'São Paulo', lat: -23.5505, lon: -46.6333, country: 'Brazil' },
      { city: 'Dubai', lat: 25.2048, lon: 55.2708, country: 'UAE' },
    ];

    for (let i = 0; i < 15; i++) {
      const loc = locations[Math.floor(Math.random() * locations.length)];
      threats.push({
        id: Date.now() + i,
        type: types[Math.floor(Math.random() * types.length)],
        location: loc,
        timestamp: new Date().toISOString()
      });
    }

    res.json({ threats });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch threats' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const scans = await readDB('scans.json');
    const analytics = await readDB('analytics.json');

    const threatCounts = {};
    const riskLevels = { safe: 0, low: 0, medium: 0, high: 0, critical: 0 };

    scans.forEach(scan => {
      threatCounts[scan.type] = (threatCounts[scan.type] || 0) + 1;
      const risk = scan.result.riskLevel || 'safe';
      riskLevels[risk] = (riskLevels[risk] || 0) + 1;
    });

    res.json({
      totalScans: analytics.totalScans,
      scamsPrevented: analytics.scamsPrevented,
      threatCounts,
      riskLevels,
      recentActivity: scans.slice(-20).reverse()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║   🛡️  CYBERGUARD AI - SERVER ONLINE   ║
    ║                                       ║
    ║   Port: ${PORT}                       ║
    ║   Status: Protected                   ║
    ╚═══════════════════════════════════════╝
    `);
  });
});