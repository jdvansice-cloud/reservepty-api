/**
 * Database Initialization Script
 * Run this once to set up the database schema
 * 
 * Usage: node scripts/init-db.js
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
  console.log('🔧 Initializing ReservePTY Database...\n');

  try {
    // Create tables
    console.log('📦 Creating tables...');
    
    await pool.query(`
      -- Families table
      CREATE TABLE IF NOT EXISTS families (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        family_id UUID REFERENCES families(id),
        tier INTEGER DEFAULT 4 CHECK (tier >= 1 AND tier <= 4),
        avatar_url VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Assets table
      CREATE TABLE IF NOT EXISTS assets (
        id UUID PRIMARY KEY,
        family_id UUID REFERENCES families(id) NOT NULL,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL CHECK (type IN ('plane', 'boat', 'home', 'vehicle')),
        location VARCHAR(255),
        image_url VARCHAR(500),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Reservations table
      CREATE TABLE IF NOT EXISTS reservations (
        id UUID PRIMARY KEY,
        asset_id UUID REFERENCES assets(id) NOT NULL,
        user_id UUID REFERENCES users(id) NOT NULL,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'active', 'completed', 'cancelled')),
        notes TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Maintenance tasks table
      CREATE TABLE IF NOT EXISTS maintenance_tasks (
        id UUID PRIMARY KEY,
        asset_id UUID REFERENCES assets(id) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        due_date TIMESTAMP,
        completed_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Usage logs table (for tracking hours, miles, etc.)
      CREATE TABLE IF NOT EXISTS usage_logs (
        id UUID PRIMARY KEY,
        asset_id UUID REFERENCES assets(id) NOT NULL,
        reservation_id UUID REFERENCES reservations(id),
        metric_type VARCHAR(50) NOT NULL,
        value DECIMAL(10, 2) NOT NULL,
        recorded_at TIMESTAMP DEFAULT NOW(),
        notes TEXT
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_users_family ON users(family_id);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_assets_family ON assets(family_id);
      CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
      CREATE INDEX IF NOT EXISTS idx_reservations_asset ON reservations(asset_id);
      CREATE INDEX IF NOT EXISTS idx_reservations_user ON reservations(user_id);
      CREATE INDEX IF NOT EXISTS idx_reservations_dates ON reservations(start_date, end_date);
      CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
    `);

    console.log('✅ Tables created successfully\n');

    // Check if demo data exists
    const existingFamily = await pool.query("SELECT id FROM families WHERE name = 'Mendoza Family Trust'");
    
    if (existingFamily.rows.length > 0) {
      console.log('ℹ️  Demo data already exists. Skipping seed data.\n');
    } else {
      console.log('🌱 Inserting demo data...');
      
      // Create demo family
      const familyId = uuidv4();
      await pool.query(
        'INSERT INTO families (id, name) VALUES ($1, $2)',
        [familyId, 'Mendoza Family Trust']
      );

      // Create demo users
      const hashedPassword = await bcrypt.hash('demo123', 10);
      
      const users = [
        { name: 'Carlos Mendoza', email: 'carlos@mendoza.family', tier: 1 },
        { name: 'Maria Mendoza', email: 'maria@mendoza.family', tier: 2 },
        { name: 'Ana Mendoza', email: 'ana@mendoza.family', tier: 3 },
        { name: 'Juan Mendoza', email: 'juan@mendoza.family', tier: 4 }
      ];

      const userIds = [];
      for (const user of users) {
        const userId = uuidv4();
        userIds.push(userId);
        await pool.query(
          'INSERT INTO users (id, email, password_hash, name, family_id, tier) VALUES ($1, $2, $3, $4, $5, $6)',
          [userId, user.email, hashedPassword, user.name, familyId, user.tier]
        );
      }

      // Create demo assets
      const assets = [
        {
          name: 'Citation CJ4',
          type: 'plane',
          location: 'PTY - Tocumen Intl',
          image_url: 'https://images.unsplash.com/photo-1540962351504-03099e0a754b?w=800',
          metadata: { cruiseSpeed: 451, range: '2,165 nm', passengers: 8, tailNumber: 'HP-001' }
        },
        {
          name: 'Azimut 55',
          type: 'boat',
          location: 'Flamenco Marina',
          image_url: 'https://images.unsplash.com/photo-1567899378494-47b22a2ae96a?w=800',
          metadata: { length: '55 ft', engineHours: 342, passengers: 12, hullId: 'AZM-055-PTY' }
        },
        {
          name: 'Boquete Mountain Retreat',
          type: 'home',
          location: 'Boquete, Chiriquí',
          image_url: 'https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=800',
          metadata: { bedrooms: 5, bathrooms: 4, sqft: 4200 }
        },
        {
          name: 'Bocas Beach Villa',
          type: 'home',
          location: 'Bocas del Toro',
          image_url: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=800',
          metadata: { bedrooms: 4, bathrooms: 3, sqft: 3100 }
        },
        {
          name: 'Range Rover Autobiography',
          type: 'vehicle',
          location: 'Punta Pacifica Garage',
          image_url: 'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=800',
          metadata: { year: 2024, seats: 5, plate: 'PTY-001' }
        }
      ];

      const assetIds = [];
      for (const asset of assets) {
        const assetId = uuidv4();
        assetIds.push(assetId);
        await pool.query(
          'INSERT INTO assets (id, family_id, name, type, location, image_url, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [assetId, familyId, asset.name, asset.type, asset.location, asset.image_url, asset.metadata]
        );
      }

      // Create demo reservations
      const today = new Date();
      const reservations = [
        {
          assetIndex: 2, // Boquete home
          userIndex: 1,  // Maria
          startOffset: -2,
          endOffset: 3,
          status: 'active'
        },
        {
          assetIndex: 0, // Plane
          userIndex: 0,  // Carlos
          startOffset: 7,
          endOffset: 7,
          status: 'confirmed',
          metadata: { departure: 'PTY', arrival: 'SJO' }
        },
        {
          assetIndex: 1, // Boat
          userIndex: 2,  // Ana
          startOffset: 14,
          endOffset: 16,
          status: 'confirmed'
        }
      ];

      for (const res of reservations) {
        const startDate = new Date(today);
        startDate.setDate(startDate.getDate() + res.startOffset);
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() + res.endOffset);
        
        await pool.query(
          'INSERT INTO reservations (id, asset_id, user_id, start_date, end_date, status, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [uuidv4(), assetIds[res.assetIndex], userIds[res.userIndex], startDate, endDate, res.status, res.metadata || {}]
        );
      }

      console.log('✅ Demo data inserted successfully\n');
      console.log('📧 Demo accounts created:');
      console.log('   Email: carlos@mendoza.family (Tier 1 - Admin)');
      console.log('   Email: maria@mendoza.family (Tier 2)');
      console.log('   Email: ana@mendoza.family (Tier 3)');
      console.log('   Email: juan@mendoza.family (Tier 4)');
      console.log('   Password for all: demo123\n');
    }

    console.log('🎉 Database initialization complete!\n');
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initDatabase();
