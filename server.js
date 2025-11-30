const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Auth middleware
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    req.user = result.rows[0];
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      dbTime: dbResult.rows[0].now
    });
  } catch (error) {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// =============================================================================
// AUTH ROUTES
// =============================================================================

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, familyId } = req.body;
    
    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const result = await pool.query(
      `INSERT INTO users (id, email, password_hash, name, family_id, tier, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, email, name, tier`,
      [uuidv4(), email, hashedPassword, name, familyId || null, 4]
    );
    
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ user, token });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.tier,
        familyId: user.family_id
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user
app.get('/api/auth/me', authenticate, (req, res) => {
  const { password_hash, ...user } = req.user;
  res.json(user);
});

// =============================================================================
// FAMILY ROUTES
// =============================================================================

// Get user's family
app.get('/api/families/mine', authenticate, async (req, res) => {
  try {
    if (!req.user.family_id) {
      return res.json(null);
    }
    
    const result = await pool.query(
      'SELECT * FROM families WHERE id = $1',
      [req.user.family_id]
    );
    
    res.json(result.rows[0] || null);
  } catch (error) {
    console.error('Get family error:', error);
    res.status(500).json({ error: 'Failed to fetch family' });
  }
});

// Get family members
app.get('/api/families/:familyId/members', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, tier, created_at 
       FROM users WHERE family_id = $1 
       ORDER BY tier, name`,
      [req.params.familyId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// =============================================================================
// ASSET ROUTES
// =============================================================================

// Get all assets for user's family
app.get('/api/assets', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, 
        (SELECT json_build_object(
          'id', r.id,
          'user_name', u.name,
          'start_date', r.start_date,
          'end_date', r.end_date
        ) FROM reservations r 
        JOIN users u ON r.user_id = u.id
        WHERE r.asset_id = a.id 
        AND r.status = 'active'
        AND NOW() BETWEEN r.start_date AND r.end_date
        LIMIT 1) as current_reservation
       FROM assets a 
       WHERE a.family_id = $1
       ORDER BY a.type, a.name`,
      [req.user.family_id]
    );
    
    const assets = result.rows.map(asset => ({
      ...asset,
      status: asset.current_reservation ? 'occupied' : 'available',
      specs: asset.metadata || {}
    }));
    
    res.json(assets);
  } catch (error) {
    console.error('Get assets error:', error);
    res.status(500).json({ error: 'Failed to fetch assets' });
  }
});

// Get single asset
app.get('/api/assets/:id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM assets WHERE id = $1 AND family_id = $2',
      [req.params.id, req.user.family_id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get asset error:', error);
    res.status(500).json({ error: 'Failed to fetch asset' });
  }
});

// Create asset (admin only)
app.post('/api/assets', authenticate, async (req, res) => {
  try {
    if (req.user.tier > 1) {
      return res.status(403).json({ error: 'Only tier 1 members can create assets' });
    }
    
    const { name, type, location, imageUrl, metadata } = req.body;
    
    const result = await pool.query(
      `INSERT INTO assets (id, family_id, name, type, location, image_url, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING *`,
      [uuidv4(), req.user.family_id, name, type, location, imageUrl, metadata]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create asset error:', error);
    res.status(500).json({ error: 'Failed to create asset' });
  }
});

// =============================================================================
// RESERVATION ROUTES
// =============================================================================

// Get all reservations
app.get('/api/reservations', authenticate, async (req, res) => {
  try {
    const { assetId, status, upcoming } = req.query;
    
    let query = `
      SELECT r.*, a.name as asset_name, a.type as asset_type, u.name as user_name
      FROM reservations r
      JOIN assets a ON r.asset_id = a.id
      JOIN users u ON r.user_id = u.id
      WHERE a.family_id = $1
    `;
    const params = [req.user.family_id];
    
    if (assetId) {
      params.push(assetId);
      query += ` AND r.asset_id = $${params.length}`;
    }
    
    if (status) {
      params.push(status);
      query += ` AND r.status = $${params.length}`;
    }
    
    if (upcoming === 'true') {
      query += ` AND r.start_date >= NOW()`;
    }
    
    query += ` ORDER BY r.start_date ASC`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Get reservations error:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

// Get user's reservations
app.get('/api/reservations/mine', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, a.name as asset_name, a.type as asset_type
       FROM reservations r
       JOIN assets a ON r.asset_id = a.id
       WHERE r.user_id = $1
       ORDER BY r.start_date DESC`,
      [req.user.id]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Get my reservations error:', error);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

// Create reservation
app.post('/api/reservations', authenticate, async (req, res) => {
  try {
    const { assetId, startDate, endDate, notes, metadata } = req.body;
    
    // Check asset exists and belongs to family
    const assetResult = await pool.query(
      'SELECT * FROM assets WHERE id = $1 AND family_id = $2',
      [assetId, req.user.family_id]
    );
    
    if (assetResult.rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    // Check for conflicts
    const conflictResult = await pool.query(
      `SELECT id FROM reservations 
       WHERE asset_id = $1 
       AND status != 'cancelled'
       AND (start_date, end_date) OVERLAPS ($2::timestamp, $3::timestamp)`,
      [assetId, startDate, endDate]
    );
    
    if (conflictResult.rows.length > 0) {
      return res.status(409).json({ error: 'Time slot conflicts with existing reservation' });
    }
    
    // Check tier restrictions (example: tier 4 can only book 7 days ahead)
    const asset = assetResult.rows[0];
    const daysAhead = Math.ceil((new Date(startDate) - new Date()) / (1000 * 60 * 60 * 24));
    const maxDaysAhead = [365, 180, 90, 30][req.user.tier - 1] || 30;
    
    if (daysAhead > maxDaysAhead) {
      return res.status(403).json({ 
        error: `Tier ${req.user.tier} members can only book ${maxDaysAhead} days in advance` 
      });
    }
    
    // Create reservation
    const result = await pool.query(
      `INSERT INTO reservations (id, asset_id, user_id, start_date, end_date, status, notes, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, NOW())
       RETURNING *`,
      [uuidv4(), assetId, req.user.id, startDate, endDate, notes, metadata]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create reservation error:', error);
    res.status(500).json({ error: 'Failed to create reservation' });
  }
});

// Cancel reservation
app.patch('/api/reservations/:id/cancel', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE reservations 
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reservation not found or not authorized' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Cancel reservation error:', error);
    res.status(500).json({ error: 'Failed to cancel reservation' });
  }
});

// =============================================================================
// CALENDAR ROUTES
// =============================================================================

// Get calendar events for date range
app.get('/api/calendar', authenticate, async (req, res) => {
  try {
    const { start, end, assetId } = req.query;
    
    let query = `
      SELECT r.*, a.name as asset_name, a.type as asset_type, u.name as user_name
      FROM reservations r
      JOIN assets a ON r.asset_id = a.id
      JOIN users u ON r.user_id = u.id
      WHERE a.family_id = $1
      AND r.status != 'cancelled'
      AND r.start_date <= $3
      AND r.end_date >= $2
    `;
    const params = [req.user.family_id, start, end];
    
    if (assetId) {
      params.push(assetId);
      query += ` AND r.asset_id = $${params.length}`;
    }
    
    query += ` ORDER BY r.start_date`;
    
    const result = await pool.query(query, params);
    
    // Format as calendar events
    const events = result.rows.map(r => ({
      id: r.id,
      title: `${r.asset_name} - ${r.user_name}`,
      start: r.start_date,
      end: r.end_date,
      assetId: r.asset_id,
      assetType: r.asset_type,
      userId: r.user_id,
      status: r.status
    }));
    
    res.json(events);
  } catch (error) {
    console.error('Get calendar error:', error);
    res.status(500).json({ error: 'Failed to fetch calendar' });
  }
});

// =============================================================================
// STATS ROUTES
// =============================================================================

app.get('/api/stats', authenticate, async (req, res) => {
  try {
    const familyId = req.user.family_id;
    
    // Get various stats
    const [assets, reservations, members, upcoming] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM assets WHERE family_id = $1', [familyId]),
      pool.query(
        `SELECT COUNT(*) FROM reservations r 
         JOIN assets a ON r.asset_id = a.id 
         WHERE a.family_id = $1 
         AND r.created_at >= date_trunc('month', NOW())`,
        [familyId]
      ),
      pool.query('SELECT COUNT(*) FROM users WHERE family_id = $1', [familyId]),
      pool.query(
        `SELECT COUNT(*) FROM reservations r
         JOIN assets a ON r.asset_id = a.id
         WHERE a.family_id = $1
         AND r.start_date > NOW()
         AND r.status = 'confirmed'`,
        [familyId]
      )
    ]);
    
    res.json({
      totalAssets: parseInt(assets.rows[0].count),
      monthlyReservations: parseInt(reservations.rows[0].count),
      familyMembers: parseInt(members.rows[0].count),
      upcomingReservations: parseInt(upcoming.rows[0].count)
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// =============================================================================
// AIRPORTS & PORTS (for booking flows)
// =============================================================================

app.get('/api/airports', (req, res) => {
  res.json([
    { code: 'PTY', name: 'Tocumen International', city: 'Panama City', country: 'Panama' },
    { code: 'SJO', name: 'Juan Santamaría International', city: 'San José', country: 'Costa Rica' },
    { code: 'BOG', name: 'El Dorado International', city: 'Bogotá', country: 'Colombia' },
    { code: 'MDE', name: 'José María Córdova International', city: 'Medellín', country: 'Colombia' },
    { code: 'CTG', name: 'Rafael Núñez International', city: 'Cartagena', country: 'Colombia' },
    { code: 'MIA', name: 'Miami International', city: 'Miami', country: 'USA' },
    { code: 'FLL', name: 'Fort Lauderdale-Hollywood', city: 'Fort Lauderdale', country: 'USA' },
    { code: 'GUA', name: 'La Aurora International', city: 'Guatemala City', country: 'Guatemala' }
  ]);
});

app.get('/api/ports', (req, res) => {
  res.json([
    { code: 'FLM', name: 'Flamenco Marina', city: 'Panama City', country: 'Panama' },
    { code: 'BLB', name: 'Balboa Yacht Club', city: 'Panama City', country: 'Panama' },
    { code: 'SBL', name: 'Shelter Bay Marina', city: 'Colón', country: 'Panama' },
    { code: 'BDT', name: 'Bocas Marina', city: 'Bocas del Toro', country: 'Panama' },
    { code: 'PVR', name: 'Puerto Velero', city: 'Barranquilla', country: 'Colombia' },
    { code: 'CTG', name: 'Club Náutico', city: 'Cartagena', country: 'Colombia' }
  ]);
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  console.log(`
🚀 ReservePTY API Server
========================
Port: ${PORT}
Environment: ${process.env.NODE_ENV || 'development'}
Database: ${process.env.DATABASE_URL ? 'Configured' : 'Not configured'}

Endpoints:
  GET  /api/health
  POST /api/auth/register
  POST /api/auth/login
  GET  /api/auth/me
  GET  /api/assets
  GET  /api/reservations
  POST /api/reservations
  GET  /api/calendar
  GET  /api/stats
  `);
});

module.exports = app;
