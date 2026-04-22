#!/usr/bin/env node
'use strict';
// ── Seed Demo Orders into RDS ──────────────────────────────────────────────
// Usage: node tools/seed-orders.js
// Requires .env with DATABASE_URL set.
// Reads pet photos from public/images/ and converts to base64 data URLs.
// ──────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const connStr = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');
if (!connStr) { console.error('DATABASE_URL not set in .env'); process.exit(1); }

const pool = new Pool({
  connectionString: connStr,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000,
});

// ── Helper: read image, resize to fit under 500KB, return base64 data URL ──
async function imageToBase64(filePath) {
  const meta = await sharp(filePath).metadata();

  // For wide sprite sheets (12-frame strips), extract the first frame first
  let input = sharp(filePath);
  if (meta.width > meta.height * 3) {
    const frameW = Math.round(meta.width / 12);
    input = sharp(filePath).extract({
      left: 0, top: 0, width: frameW, height: meta.height,
    });
  }

  const buf = await input
    .resize(400, 600, { fit: 'cover', position: 'center' })
    .jpeg({ quality: 75 })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

// ── Demo orders ─────────────────────────────────────────────────────────────
function orderId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const rand = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * 26)]).join('');
  return `PLF-${Date.now()}-${rand}`;
}

const DEMO_ORDERS = [
  {
    pet_first_name: 'Luna',       pet_last_name: 'Whiskers',
    dl_number: 'P8472910',        dob: '03/15/20',
    exp_date: '04/13/30',         iss_date: '04/13/26',
    addr_line1: '742 Meow Lane',  addr_line2: 'Catville, CA 90210',
    sex: 'F', height: '10"', weight: '9', eyes: 'GRN',
    pack_count: 2, total: '$29.99', chip_size: 'mini', add_on: 'car_decal',
    shipping_option: 'priority',  status: 'paid',
    customer_name: 'Sarah Johnson', customer_email: 'sarah.j@email.com',
    ship_addr_line1: '123 Oak Street', ship_city: 'Portland',
    ship_state: 'OR', ship_zip: '97201',
    photoFile: 'Station 1 sprite.png',  // Cat sprite
  },
  {
    pet_first_name: 'Max',        pet_last_name: 'Woofington',
    dl_number: 'P3391847',        dob: '07/22/19',
    exp_date: '07/22/29',         iss_date: '07/22/25',
    addr_line1: '88 Bark Blvd',   addr_line2: 'Dogtown, TX 75001',
    sex: 'M', height: '24"', weight: '65', eyes: 'BRN',
    pack_count: 1, total: '$16.99', chip_size: 'classic', add_on: null,
    shipping_option: 'standard',  status: 'shipped',
    customer_name: 'Mike Chen', customer_email: 'mike.chen@email.com',
    ship_addr_line1: '456 Elm Avenue', ship_city: 'Austin',
    ship_state: 'TX', ship_zip: '73301',
    tracking_number: '9400111899223395909204',
    photoFile: 'Station 3 sprite.png',  // Bulldog sprite
  },
  {
    pet_first_name: 'Oliver',     pet_last_name: 'Pawsley',
    dl_number: 'P5529031',        dob: '11/03/21',
    exp_date: '11/03/31',         iss_date: '11/03/26',
    addr_line1: '12 Whisker Way', addr_line2: 'Furton, NY 10001',
    sex: 'M', height: '12"', weight: '11', eyes: 'BLU',
    pack_count: 2, total: '$29.99', chip_size: 'mini', add_on: null,
    shipping_option: 'stamp',     status: 'pending',
    customer_name: 'Emma Davis', customer_email: 'emma.d@email.com',
    ship_addr_line1: '789 Pine Road', ship_city: 'Brooklyn',
    ship_state: 'NY', ship_zip: '11201',
    photoFile: 'Station 5 sprite.png',  // Rabbit sprite
  },
  {
    pet_first_name: 'Coco',       pet_last_name: 'Feathers',
    dl_number: 'P7710294',        dob: '01/30/22',
    exp_date: '01/30/32',         iss_date: '01/30/26',
    addr_line1: '55 Wing St',     addr_line2: 'Birdsville, FL 33101',
    sex: 'F', height: '14"', weight: '2', eyes: 'BLK',
    pack_count: 1, total: '$16.99', chip_size: 'mini', add_on: 'car_decal',
    shipping_option: 'priority',  status: 'complete',
    customer_name: 'Alex Rivera', customer_email: 'alex.r@email.com',
    ship_addr_line1: '321 Palm Drive', ship_city: 'Miami',
    ship_state: 'FL', ship_zip: '33101',
    tracking_number: '9261290100130435082878',
    stripe_payment_id: 'cs_test_a1B2c3D4e5F6',
    photoFile: 'Station 2 sprite.png',  // Cockatoo sprite
  },
  {
    pet_first_name: 'Biscuit',    pet_last_name: 'Splashworth',
    dl_number: 'P9948372',        dob: '05/14/23',
    exp_date: '05/14/33',         iss_date: '05/14/26',
    addr_line1: '7 River Rd',     addr_line2: 'Otterdam, WA 98101',
    sex: 'M', height: '30"', weight: '18', eyes: 'BRN',
    pack_count: 2, total: '$34.98', chip_size: 'classic', add_on: 'car_decal',
    shipping_option: 'standard',  status: 'paid',
    customer_name: 'Jordan Kim', customer_email: 'j.kim@email.com',
    ship_addr_line1: '64 Harbor Lane', ship_city: 'Seattle',
    ship_state: 'WA', ship_zip: '98101',
    stripe_payment_id: 'cs_test_x7Y8z9A0b1C2',
    photoFile: 'Station 4 sprite.png',  // Otter sprite
  },
];

async function seed() {
  console.log('Seeding demo orders...\n');
  const imagesDir = path.join(__dirname, '..', 'public', 'images');

  for (const o of DEMO_ORDERS) {
    const oid = orderId();
    const photoPath = path.join(imagesDir, o.photoFile);

    let photoUrl = null;
    try {
      photoUrl = await imageToBase64(photoPath);
      console.log(`  Photo: ${o.photoFile} -> ${(photoUrl.length / 1024).toFixed(0)}KB base64`);
    } catch (err) {
      console.warn(`  Warning: could not process ${o.photoFile}: ${err.message}`);
    }

    const signature = `${o.pet_first_name} ${o.pet_last_name}`;

    await pool.query(`
      INSERT INTO pet_orders (
        order_id, status, pet_first_name, pet_last_name,
        dl_number, dob, exp_date, iss_date,
        addr_line1, addr_line2, sex, height, weight, eyes,
        lic_class, restrict, signature,
        pack_count, total, chip_size, add_on, shipping_option,
        photo_url,
        customer_name, customer_email,
        ship_addr_line1, ship_city, ship_state, ship_zip, ship_country,
        stripe_payment_id, tracking_number
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14,
        $15, $16, $17,
        $18, $19, $20, $21, $22,
        $23,
        $24, $25,
        $26, $27, $28, $29, $30,
        $31, $32
      )
    `, [
      oid, o.status, o.pet_first_name, o.pet_last_name,
      o.dl_number, o.dob, o.exp_date, o.iss_date,
      o.addr_line1, o.addr_line2, o.sex, o.height, o.weight, o.eyes,
      'A', 'ALL', signature,
      o.pack_count, o.total, o.chip_size, o.add_on, o.shipping_option,
      photoUrl,
      o.customer_name, o.customer_email,
      o.ship_addr_line1, o.ship_city, o.ship_state, o.ship_zip, 'US',
      o.stripe_payment_id || null, o.tracking_number || null,
    ]);

    console.log(`  ✓ ${o.pet_first_name} ${o.pet_last_name} (${oid}) — ${o.status}\n`);
  }

  console.log(`Done! Seeded ${DEMO_ORDERS.length} demo orders.`);
  await pool.end();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
