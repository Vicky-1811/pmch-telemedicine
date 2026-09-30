const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Persistent Disk Directory Setup
const dbDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'panimalar.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Master Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    department TEXT
  );

  CREATE TABLE IF NOT EXISTS doctors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    specialty TEXT NOT NULL,
    exp TEXT NOT NULL,
    fee INTEGER NOT NULL,
    unit TEXT NOT NULL,
    current_token INTEGER DEFAULT 101
  );

  CREATE TABLE IF NOT EXISTS medicines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    reorder_level INTEGER DEFAULT 20,
    reorder_qty INTEGER DEFAULT 100,
    requires_rx INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS medicine_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    medicine_id TEXT NOT NULL,
    batch_number TEXT NOT NULL,
    expiry_date DATE NOT NULL,
    unit_price REAL NOT NULL,
    current_stock INTEGER NOT NULL,
    barcode_data TEXT,
    status TEXT DEFAULT 'ACTIVE',
    FOREIGN KEY (medicine_id) REFERENCES medicines(id)
  );

  CREATE TABLE IF NOT EXISTS hospital_beds (
    bed_id TEXT PRIMARY KEY,
    ward_type TEXT NOT NULL,
    block TEXT NOT NULL,
    daily_rate REAL NOT NULL,
    status TEXT DEFAULT 'VACANT',
    assigned_uhid TEXT,
    admitted_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_number INTEGER NOT NULL,
    doctor_id TEXT,
    doctor_name TEXT,
    patient_name TEXT,
    patient_phone TEXT,
    uhid TEXT,
    payment_id TEXT,
    amount_paid REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE,
    uhid TEXT,
    total_amount REAL,
    items_json TEXT,
    status TEXT DEFAULT 'DISPATCHED',
    payment_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS prescriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rx_number TEXT UNIQUE,
    uhid TEXT,
    doctor_name TEXT,
    diagnosis TEXT,
    medications_json TEXT,
    qr_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lab_tests (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    price REAL NOT NULL,
    normal_range TEXT DEFAULT 'Normal'
  );

  CREATE TABLE IF NOT EXISTS lab_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE,
    uhid TEXT NOT NULL,
    test_id TEXT NOT NULL,
    test_name TEXT NOT NULL,
    doctor_name TEXT NOT NULL,
    result_val TEXT,
    flag TEXT DEFAULT 'PENDING',
    status TEXT DEFAULT 'SAMPLE_COLLECTED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS patient_insurance (
    uhid TEXT PRIMARY KEY,
    tpa_provider TEXT NOT NULL,
    policy_no TEXT NOT NULL,
    preauth_approval_limit REAL NOT NULL,
    coverage_percent INTEGER DEFAULT 80,
    status TEXT DEFAULT 'ACTIVE'
  );

  CREATE TABLE IF NOT EXISTS insurance_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT UNIQUE,
    uhid TEXT NOT NULL,
    bill_id TEXT NOT NULL,
    tpa_name TEXT NOT NULL,
    total_bill REAL NOT NULL,
    claimed_amount REAL NOT NULL,
    patient_copay REAL NOT NULL,
    claim_status TEXT DEFAULT 'PREAUTH_APPROVED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS discharge_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id TEXT UNIQUE,
    uhid TEXT NOT NULL,
    doctor_fee REAL,
    pharmacy_total REAL,
    lab_total REAL,
    bed_charges REAL,
    grand_total REAL,
    insurance_paid REAL DEFAULT 0,
    copay_paid REAL DEFAULT 0,
    tpa_ref TEXT DEFAULT 'N/A',
    payment_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ambulance_fleet (
    id TEXT PRIMARY KEY,
    vehicle_no TEXT NOT NULL,
    driver_name TEXT NOT NULL,
    driver_phone TEXT NOT NULL,
    status TEXT DEFAULT 'AVAILABLE',
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    target_destination TEXT,
    eta_mins INTEGER DEFAULT 0,
    patient_vitals_summary TEXT,
    triage_gcs INTEGER DEFAULT 15,
    triage_hr INTEGER DEFAULT 75,
    triage_spo2 INTEGER DEFAULT 98,
    trauma_category TEXT DEFAULT 'Non-Trauma'
  );

  CREATE TABLE IF NOT EXISTS notification_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    template_name TEXT NOT NULL,
    message_body TEXT NOT NULL,
    status TEXT DEFAULT 'DELIVERED',
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS abha_identities (
    uhid TEXT PRIMARY KEY,
    abha_number TEXT UNIQUE NOT NULL,
    abha_address TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    gender TEXT NOT NULL,
    mobile TEXT NOT NULL,
    linked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS abdm_consents (
    consent_id TEXT PRIMARY KEY,
    uhid TEXT NOT NULL,
    doctor_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    expiry_hours INTEGER DEFAULT 24,
    status TEXT DEFAULT 'GRANTED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe Migrations
const ambCols = db.prepare('PRAGMA table_info(ambulance_fleet)').all().map(c => c.name);
if (!ambCols.includes('triage_gcs')) db.exec('ALTER TABLE ambulance_fleet ADD COLUMN triage_gcs INTEGER DEFAULT 15;');
if (!ambCols.includes('triage_hr')) db.exec('ALTER TABLE ambulance_fleet ADD COLUMN triage_hr INTEGER DEFAULT 75;');
if (!ambCols.includes('triage_spo2')) db.exec('ALTER TABLE ambulance_fleet ADD COLUMN triage_spo2 INTEGER DEFAULT 98;');
if (!ambCols.includes('trauma_category')) db.exec("ALTER TABLE ambulance_fleet ADD COLUMN trauma_category TEXT DEFAULT 'Non-Trauma';");

const batchCols = db.prepare('PRAGMA table_info(medicine_batches)').all().map(c => c.name);
if (!batchCols.includes('barcode_data')) db.exec('ALTER TABLE medicine_batches ADD COLUMN barcode_data TEXT;');

const billCols = db.prepare('PRAGMA table_info(discharge_bills)').all().map(c => c.name);
if (!billCols.includes('insurance_paid')) db.exec('ALTER TABLE discharge_bills ADD COLUMN insurance_paid REAL DEFAULT 0');
if (!billCols.includes('copay_paid')) db.exec('ALTER TABLE discharge_bills ADD COLUMN copay_paid REAL DEFAULT 0');
if (!billCols.includes('tpa_ref')) db.exec("ALTER TABLE discharge_bills ADD COLUMN tpa_ref TEXT DEFAULT 'N/A'");

const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT;');

// Seed Users
const users = [
  ['usr-admin', 'admin', 'admin@panimalar.ac.in', 'admin123', 'ADMIN', 'Dr. Radhakrishnan (Medical Supt.)', 'Administration'],
  ['usr-doc', 'doctor', 'suresh.kumar@panimalar.ac.in', 'doctor123', 'DOCTOR', 'Dr. Suresh Kumar S.', 'General Medicine'],
  ['usr-patient', 'patient', 'kavitha.patient@gmail.com', 'patient123', 'PATIENT', 'Kavitha R.', 'Outpatient (UHID: PMCH-80097)']
];
const insUser = db.prepare('INSERT OR REPLACE INTO users VALUES (?, ?, ?, ?, ?, ?, ?)');
users.forEach(u => insUser.run(...u));

// Seed Doctors
const doctors = [
  ['pmch-101', 'Dr. Suresh Kumar S.', 'General Medicine', '16 yrs', 300, 'Unit 1 / OPD Block A', 101],
  ['pmch-102', 'Dr. Thangamani P.', 'General Surgery', '20 yrs', 400, 'Unit 2 / Surgical Block', 101],
  ['pmch-103', 'Dr. Gayathri Devi T.', 'Pathology & Diagnostics', '15 yrs', 250, 'Central Lab Block', 101]
];
const insDoc = db.prepare('INSERT OR REPLACE INTO doctors VALUES (?, ?, ?, ?, ?, ?, ?)');
doctors.forEach(d => insDoc.run(...d));

// Seed Medicines & Batches with Barcodes
const meds = [
  ['pmch-med-1', 'Paracetamol 650mg (Dolo)', 'Analgesic', 20, 100, 0],
  ['pmch-med-2', 'Azithromycin 500mg', 'Antibiotic', 15, 60, 1],
  ['pmch-med-3', 'Warfarin 5mg', 'Anticoagulant', 10, 40, 1],
  ['pmch-med-4', 'Aspirin 75mg', 'NSAID / Antiplatelet', 15, 50, 0]
];
const insMed = db.prepare('INSERT OR REPLACE INTO medicines VALUES (?, ?, ?, ?, ?, ?)');
meds.forEach(m => insMed.run(...m));

const batchCount = db.prepare('SELECT COUNT(*) as c FROM medicine_batches').get().c;
if (batchCount === 0) {
  const batches = [
    ['pmch-med-1', 'PMCH-DOLO-A1', '2026-11-15', 25.0, 20, '890103000101', 'ACTIVE'],
    ['pmch-med-1', 'PMCH-DOLO-B2', '2027-08-20', 25.0, 150, '890103000102', 'ACTIVE'],
    ['pmch-med-2', 'PMCH-AZI-901', '2026-12-01', 95.0, 10, '890103000201', 'ACTIVE'],
    ['pmch-med-3', 'PMCH-WARF-01', '2027-03-10', 45.0, 30, '890103000301', 'ACTIVE'],
    ['pmch-med-4', 'PMCH-ASP-102', '2027-04-15', 20.0, 80, '890103000401', 'ACTIVE']
  ];
  const insBatch = db.prepare('INSERT INTO medicine_batches (medicine_id, batch_number, expiry_date, unit_price, current_stock, barcode_data, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  batches.forEach(b => insBatch.run(...b));
}

// Seed Beds & Labs
const beds = [
  ['BED-ICU-01', 'Critical Care ICU', 'Trauma Tower - 1st Floor', 3500.0, 'OCCUPIED', 'PMCH-80097', '2026-09-27 08:30:00'],
  ['BED-ICU-02', 'Critical Care ICU', 'Trauma Tower - 1st Floor', 3500.0, 'VACANT', null, null],
  ['BED-GW-101', 'General Ward (Male)', 'Block B - 2nd Floor', 800.0, 'VACANT', null, null]
];
const insBed = db.prepare('INSERT OR REPLACE INTO hospital_beds VALUES (?, ?, ?, ?, ?, ?, ?)');
beds.forEach(b => insBed.run(...b));

const labs = [
  ['pmch-lab-1', 'Complete Blood Count (CBC)', 'Haematology', 350.0, 'Hb: 13-17 g/dL'],
  ['pmch-lab-2', 'Liver Function Test (LFT)', 'Biochemistry', 650.0, 'Normal']
];
const insLab = db.prepare('INSERT OR REPLACE INTO lab_tests (id, name, department, price, normal_range) VALUES (?, ?, ?, ?, ?)');
labs.forEach(l => insLab.run(...l));

db.prepare('INSERT OR REPLACE INTO patient_insurance VALUES (?, ?, ?, ?, ?, ?)').run(
  'PMCH-80097', 'Star Health & Allied Insurance', 'SH-PMCH-99214', 50000.0, 80, 'ACTIVE'
);

db.prepare('INSERT OR REPLACE INTO abha_identities VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(
  'PMCH-80097', '91-8009-7712-4411', 'kavitha.r@abdm', 'Kavitha R.', 'Female', '9876543210'
);

// Seed Ambulance Fleet
const fleet = [
  ['AMB-01', 'TN-02-AZ-9901', 'M. Murugan', '+91 94441 23456', 'DISPATCHED', 13.0450, 80.0880, 'PMCH Trauma Tower', 6, 'HR: 104 | SpO2: 94%', 14, 104, 94, 'Blunt Trauma'],
  ['AMB-02', 'TN-02-BC-4412', 'K. Saravanan', '+91 98840 98765', 'AVAILABLE', 13.0382, 80.1565, 'Porur Junction', 0, 'Standby - Mobile ICU', 15, 76, 99, 'Non-Trauma'],
  ['AMB-03', 'TN-02-CX-1088', 'P. Vinoth', '+91 97910 11223', 'MAINTENANCE', 13.0610, 80.0520, 'PMCH Garage Bay', 0, 'Vehicle Under Service / Offline', 15, 0, 0, 'Non-Trauma']
];
const insFleet = db.prepare('INSERT OR REPLACE INTO ambulance_fleet VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
fleet.forEach(f => insFleet.run(...f));

// Live GPS Simulation
setInterval(() => {
  const activeAmbulances = db.prepare("SELECT * FROM ambulance_fleet WHERE status = 'DISPATCHED'").all();
  activeAmbulances.forEach(amb => {
    const dLat = (13.0498 - amb.lat) * 0.05;
    const dLng = (80.0754 - amb.lng) * 0.05;
    const newLat = parseFloat((amb.lat + dLat).toFixed(6));
    const newLng = parseFloat((amb.lng + dLng).toFixed(6));
    const newEta = Math.max(1, amb.eta_mins - 1);

    db.prepare('UPDATE ambulance_fleet SET lat = ?, lng = ?, eta_mins = ? WHERE id = ?').run(newLat, newLng, newEta, amb.id);

    io.emit('ambulance-telemetry-update', {
      id: amb.id,
      vehicleNo: amb.vehicle_no,
      driverName: amb.driver_name,
      lat: newLat,
      lng: newLng,
      etaMins: newEta,
      status: amb.status,
      vitalsSummary: amb.patient_vitals_summary,
      triageGcs: amb.triage_gcs,
      triageHr: amb.triage_hr,
      triageSpo2: amb.triage_spo2,
      traumaCategory: amb.trauma_category
    });
  });
}, 3000);

// ICU Telemetry Broadcaster
setInterval(() => {
  const occupiedIcuBeds = db.prepare("SELECT * FROM hospital_beds WHERE ward_type LIKE '%ICU%' AND status = 'OCCUPIED'").all();
  occupiedIcuBeds.forEach(bed => {
    const hr = Math.floor(72 + Math.random() * 8);
    const spo2 = Math.floor(97 + Math.random() * 2);
    const sys = Math.floor(118 + Math.random() * 8);
    const dia = Math.floor(78 + Math.random() * 6);

    io.emit('telemetry-update', {
      bedId: bed.bed_id,
      uhid: bed.assigned_uhid,
      hr,
      spo2,
      bp: `${sys}/${dia} mmHg`,
      timestamp: new Date().toLocaleTimeString('en-IN')
    });
  });
}, 2500);

// WebRTC Signaling
io.on('connection', (sock) => {
  sock.on('join-video-room', (roomId) => {
    sock.join(roomId);
    sock.to(roomId).emit('peer-joined', sock.id);
  });
  sock.on('video-offer', ({ roomId, offer }) => sock.to(roomId).emit('video-offer', { offer, sender: sock.id }));
  sock.on('video-answer', ({ roomId, answer }) => sock.to(roomId).emit('video-answer', { answer, sender: sock.id }));
  sock.on('ice-candidate', ({ roomId, candidate }) => sock.to(roomId).emit('ice-candidate', { candidate, sender: sock.id }));
  sock.on('leave-video-room', (roomId) => {
    sock.leave(roomId);
    sock.to(roomId).emit('peer-left');
  });
});

app.post('/api/pmch/telemetry/trigger-code-blue', (req, res) => {
  const { bedId, uhid } = req.body;
  io.emit('code-blue-alert', {
    bedId: bedId || 'BED-ICU-01',
    uhid: uhid || 'PMCH-80097',
    spo2: 84,
    hr: 138,
    location: 'Trauma Tower - Critical Care ICU Bed 01',
    timestamp: new Date().toLocaleTimeString('en-IN')
  });
  res.json({ success: true });
});

// FEATURE 1: Paramedic Pre-Arrival En-Route Vitals Scribe & Emergency ICU Pre-Reservation
app.post('/api/pmch/ambulance/triage-update', (req, res) => {
  try {
    const { id, gcs, hr, spo2, traumaCategory, autoReserveIcu } = req.body;
    const numGcs = parseInt(gcs) || 15;
    const numHr = parseInt(hr) || 80;
    const numSpo2 = parseInt(spo2) || 98;
    const trauma = traumaCategory || 'Trauma Resuscitation';

    const vitalsSummary = `GCS: ${numGcs} | HR: ${numHr} | SpO2: ${numSpo2}% [${trauma}]`;

    db.prepare(`
      UPDATE ambulance_fleet 
      SET triage_gcs = ?, triage_hr = ?, triage_spo2 = ?, trauma_category = ?, patient_vitals_summary = ?
      WHERE id = ?
    `).run(numGcs, numHr, numSpo2, trauma, vitalsSummary, id);

    const isCritical = numSpo2 < 90 || numHr > 120 || numGcs < 9;
    let reservedBedId = null;

    if (autoReserveIcu || isCritical) {
      const vacantBed = db.prepare("SELECT bed_id FROM hospital_beds WHERE ward_type LIKE '%ICU%' AND status = 'VACANT' LIMIT 1").get();
      if (vacantBed) {
        reservedBedId = vacantBed.bed_id;
        db.prepare("UPDATE hospital_beds SET status = 'RESERVED', assigned_uhid = 'EN-ROUTE-PARAMEDIC', admitted_at = CURRENT_TIMESTAMP WHERE bed_id = ?").run(reservedBedId);
      }
    }

    const updated = db.prepare('SELECT * FROM ambulance_fleet WHERE id = ?').get(id);

    // Broadcast Real-time Code Red / Yellow Banner
    io.emit('trauma-triage-alert', {
      ambulanceId: id,
      vehicleNo: updated.vehicle_no,
      driverName: updated.driver_name,
      etaMins: updated.eta_mins,
      gcs: numGcs,
      hr: numHr,
      spo2: numSpo2,
      traumaCategory: trauma,
      isCritical,
      reservedBedId
    });

    io.emit('ambulance-telemetry-update', updated);
    res.json({ success: true, isCritical, reservedBedId, ambulance: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// FEATURE 3: GS1 / 2D Barcode Verification & FEFO Audit
app.post('/api/pmch/pharmacy/verify-barcode', (req, res) => {
  try {
    const { barcode } = req.body;
    const trimmed = (barcode || '').trim();

    // Match batch by scanned barcode or batch number
    const batch = db.prepare(`
      SELECT b.*, m.name as medicine_name 
      FROM medicine_batches b 
      JOIN medicines m ON b.medicine_id = m.id 
      WHERE b.barcode_data = ? OR b.batch_number = ?
    `).get(trimmed, trimmed);

    if (!batch) {
      return res.status(404).json({ success: false, message: `No active medicine found for barcode: ${trimmed}` });
    }

    // Check FEFO Compliance (is there an earlier expiring active batch for this drug?)
    const earliestBatch = db.prepare(`
      SELECT * FROM medicine_batches 
      WHERE medicine_id = ? AND current_stock > 0 AND expiry_date > DATE('now')
      ORDER BY expiry_date ASC LIMIT 1
    `).get(batch.medicine_id);

    const isFefoCompliant = earliestBatch ? earliestBatch.id === batch.id : true;

    res.json({
      success: true,
      scannedBatch: batch,
      isFefoCompliant,
      recommendedBatch: earliestBatch,
      message: isFefoCompliant 
        ? `✅ FEFO Validated: Batch ${batch.batch_number} is the earliest expiring stock.` 
        : `⚠️ FEFO VIOLATION: Batch ${earliestBatch.batch_number} expires earlier (${earliestBatch.expiry_date})! Dispense that first.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Queue Advancement
const handleQueueAdvance = (req, res) => {
  try {
    const doctorId = req.body?.doctorId || req.query?.doctorId || 'pmch-101';
    db.prepare('UPDATE doctors SET current_token = current_token + 1 WHERE id = ?').run(doctorId);
    const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId);

    if (!doc) return res.status(404).json({ success: false, error: 'Doctor not found' });

    io.emit('token-called', {
      tokenNumber: doc.current_token,
      doctorId: doc.id,
      doctorName: doc.name,
      specialty: doc.specialty,
      unit: doc.unit
    });

    const upcoming = db.prepare('SELECT * FROM appointments WHERE doctor_id = ? AND token_number = ?').get(doc.id, doc.current_token + 3);
    if (upcoming) {
      const waMsg = `Hello ${upcoming.patient_name}, ${doc.name} (${doc.unit}) is consulting Token #${doc.current_token}. Your Token #${upcoming.token_number} is up in ~12 mins. Please be seated in OPD lobby.`;
      db.prepare('INSERT INTO notification_logs (channel, recipient_phone, template_name, message_body) VALUES (?, ?, ?, ?)').run(
        'WHATSAPP', upcoming.patient_phone || '+91 98765 43210', 'WA_QUEUE_PROXIMITY_ALERT', waMsg
      );
      io.emit('whatsapp-dispatched', {
        type: 'QUEUE_PROXIMITY',
        patient: upcoming.patient_name,
        token: upcoming.token_number,
        phone: upcoming.patient_phone,
        message: waMsg,
        timestamp: new Date().toLocaleTimeString('en-IN')
      });
    }

    return res.json({ success: true, currentToken: doc.current_token, doctorName: doc.name, unit: doc.unit });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/pmch/queue/advance', handleQueueAdvance);
app.get('/api/pmch/queue/advance', handleQueueAdvance);

// Ambulance Fleet Management
app.get('/api/pmch/ambulance/fleet', (req, res) => {
  res.json(db.prepare('SELECT * FROM ambulance_fleet').all());
});

app.post('/api/pmch/ambulance/dispatch', (req, res) => {
  const { id, destination, vitals } = req.body;
  db.prepare("UPDATE ambulance_fleet SET status = 'DISPATCHED', target_destination = ?, eta_mins = 14, patient_vitals_summary = ? WHERE id = ?").run(
    destination || 'PMCH Emergency Bay', vitals || 'Triage: Code Yellow', id
  );
  const updated = db.prepare('SELECT * FROM ambulance_fleet WHERE id = ?').get(id);
  io.emit('ambulance-telemetry-update', updated);
  res.json({ success: true, ambulance: updated });
});

app.post('/api/pmch/ambulance/set-status', (req, res) => {
  try {
    const { id, status } = req.body;
    const targetStatus = status || 'MAINTENANCE';

    let vitalsMsg = 'Standby - Available';
    if (targetStatus === 'MAINTENANCE') vitalsMsg = 'Vehicle Under Service / Offline';
    if (targetStatus === 'OFFLINE') vitalsMsg = 'Decommissioned / Off-Duty';

    db.prepare(`
      UPDATE ambulance_fleet 
      SET status = ?, eta_mins = 0, patient_vitals_summary = ? 
      WHERE id = ?
    `).run(targetStatus, vitalsMsg, id);

    const updated = db.prepare('SELECT * FROM ambulance_fleet WHERE id = ?').get(id);
    io.emit('ambulance-telemetry-update', updated);
    res.json({ success: true, ambulance: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Notifications
app.post('/api/pmch/notifications/send', (req, res) => {
  try {
    const { channel, phone, templateName, messageBody } = req.body;
    db.prepare('INSERT INTO notification_logs (channel, recipient_phone, template_name, message_body) VALUES (?, ?, ?, ?)').run(
      channel || 'WHATSAPP', phone || '+91 98765 43210', templateName || 'GENERAL_TRANSACTIONAL', messageBody
    );
    io.emit('whatsapp-dispatched', {
      type: templateName,
      phone,
      message: messageBody,
      timestamp: new Date().toLocaleTimeString('en-IN')
    });
    res.json({ success: true, message: 'Dispatched via WhatsApp Business Gateway' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/pmch/notifications/recent', (req, res) => {
  res.json(db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 15').all());
});

// Payment Gateways
app.post('/api/pmch/payment/generate-upi-qr', async (req, res) => {
  try {
    const { amount, purpose } = req.body;
    const txnRef = 'PMCH-TXN-' + Math.floor(100000 + Math.random() * 900000);
    const upiUri = `upi://pay?pa=billing.pmch@indianbank&pn=Panimalar+Medical+Hospital&am=${parseFloat(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(purpose || 'PMCH Bill')}`;
    const qrDataUrl = await QRCode.toDataURL(upiUri, { width: 260, margin: 2 });
    res.json({ success: true, txnRef, amount: parseFloat(amount), qrDataUrl, upiUri, expiresInSeconds: 180 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Email OTP Authentication
const emailOtpStore = new Map();
app.post('/api/pmch/auth/send-email-otp', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required.' });
  const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email.trim());
  if (!user) return res.status(404).json({ error: 'No hospital account associated with this email.' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  emailOtpStore.set(email.toLowerCase().trim(), { otp, expiresAt: Date.now() + 5 * 60 * 1000, user });
  console.log(`[PMCH Auth Mailer] Sent OTP ${otp} to ${email}`);
  res.json({ success: true, message: `Verification code sent to ${email}`, demoOtp: otp });
});

app.post('/api/pmch/auth/verify-email-otp', (req, res) => {
  const { email, otp } = req.body;
  const record = emailOtpStore.get(email?.toLowerCase()?.trim());
  if (!record || record.expiresAt < Date.now()) return res.status(400).json({ error: 'OTP expired or invalid.' });
  if (record.otp !== otp?.trim()) return res.status(400).json({ error: 'Invalid verification code.' });
  emailOtpStore.delete(email.toLowerCase().trim());
  res.json({ success: true, user: record.user });
});

app.post('/api/pmch/auth/login', (req, res) => {
  const identifier = (req.body.username || req.body.email || '').trim();
  const password = (req.body.password || '').trim();
  const user = db.prepare('SELECT id, username, email, role, name, department FROM users WHERE (LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)) AND password = ?').get(identifier, identifier, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
  res.json({ success: true, user });
});

// ABDM Sandbox Endpoints
app.get('/api/pmch/abdm/profile/:uhid', (req, res) => {
  const uhid = req.params.uhid.trim();
  const abha = db.prepare('SELECT * FROM abha_identities WHERE uhid = ?').get(uhid);
  const consent = db.prepare("SELECT * FROM abdm_consents WHERE uhid = ? AND status = 'GRANTED' ORDER BY created_at DESC LIMIT 1").get(uhid);
  res.json({ linked: !!abha, abha: abha || null, consent: consent || null });
});

app.post('/api/pmch/abdm/generate-abha', (req, res) => {
  try {
    const { uhid, fullName, mobile, gender } = req.body;
    const r1 = Math.floor(1000 + Math.random() * 9000);
    const r2 = Math.floor(1000 + Math.random() * 9000);
    const r3 = Math.floor(1000 + Math.random() * 9000);
    const abhaNumber = `91-${r1}-${r2}-${r3}`;
    const cleanUser = fullName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const abhaAddress = `${cleanUser}${Math.floor(10 + Math.random() * 90)}@abdm`;

    db.prepare('INSERT OR REPLACE INTO abha_identities (uhid, abha_number, abha_address, full_name, gender, mobile) VALUES (?, ?, ?, ?, ?, ?)').run(
      uhid.trim(), abhaNumber, abhaAddress, fullName.trim(), gender || 'Male', mobile.trim()
    );
    res.json({ success: true, abhaNumber, abhaAddress, message: '14-Digit ABHA ID Generated & Linked!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pmch/abdm/grant-consent', (req, res) => {
  try {
    const { uhid, doctorId, hours } = req.body;
    const consentId = 'CONSENT-' + Math.floor(100000 + Math.random() * 900000);
    db.prepare("INSERT INTO abdm_consents (consent_id, uhid, doctor_id, scope, expiry_hours, status) VALUES (?, ?, ?, 'DIAGNOSTIC_EHR_PRESCRIPTIONS', ?, 'GRANTED')").run(
      consentId, uhid.trim(), doctorId || 'pmch-101', parseInt(hours) || 24
    );
    res.json({ success: true, consentId, message: `ABDM Patient Consent Granted for ${hours || 24} hours!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pmch/abdm/fhir-bundle/:uhid', (req, res) => {
  const uhid = req.params.uhid.trim();
  const abha = db.prepare('SELECT * FROM abha_identities WHERE uhid = ?').get(uhid);
  const rxs = db.prepare('SELECT * FROM prescriptions WHERE uhid = ?').all(uhid);
  const labs = db.prepare('SELECT * FROM lab_orders WHERE uhid = ?').all(uhid);

  const fhirBundle = {
    resourceType: 'Bundle',
    id: `PMCH-FHIR-${Date.now()}`,
    type: 'document',
    timestamp: new Date().toISOString(),
    identifier: { system: 'https://healthid.abdm.gov.in', value: abha ? abha.abha_number : 'UNLINKED' },
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: uhid,
          identifier: [{ system: 'ABHA', value: abha?.abha_number || 'N/A' }],
          name: [{ text: abha?.full_name || 'Patient' }],
          telecom: [{ system: 'phone', value: abha?.mobile || '9876543210' }]
        }
      },
      ...rxs.map(rx => ({
        resource: {
          resourceType: 'MedicationRequest',
          id: rx.rx_number,
          status: 'completed',
          intent: 'order',
          medicationCodeableConcept: { text: rx.medications_json },
          subject: { reference: `Patient/${uhid}` },
          encounter: { display: rx.diagnosis }
        }
      })),
      ...labs.map(l => ({
        resource: {
          resourceType: 'Observation',
          id: l.order_id,
          status: l.status,
          code: { text: l.test_name },
          valueString: l.result_val || 'Pending'
        }
      }))
    ]
  };
  res.json(fhirBundle);
});

// Clinical AI Checks
app.post('/api/pmch/ai/check-interactions', (req, res) => {
  const { selectedDrugs, patientAllergies } = req.body;
  const warnings = [];
  const drugNames = (selectedDrugs || []).map(d => d.toLowerCase());
  const allergies = (patientAllergies || []).map(a => a.toLowerCase());

  if (drugNames.some(d => d.includes('warfarin')) && drugNames.some(d => d.includes('aspirin'))) {
    warnings.push({
      severity: 'CRITICAL',
      title: 'Major Hemorrhagic Bleeding Risk',
      description: 'Concomitant use of Warfarin and Aspirin increases risk of internal hemorrhage.'
    });
  }

  if (allergies.some(a => a.includes('penicillin')) && drugNames.some(d => d.includes('amoxicillin'))) {
    warnings.push({
      severity: 'CRITICAL',
      title: 'Contraindication: Anaphylaxis Alert',
      description: 'Patient is Penicillin-Allergic. Amoxicillin administration carries high anaphylactic risk.'
    });
  }

  res.json({ safe: warnings.length === 0, hasCritical: warnings.some(w => w.severity === 'CRITICAL'), warnings });
});

app.post('/api/pmch/prescription/create', async (req, res) => {
  const { uhid, doctorName, diagnosis, medications } = req.body;
  const rxNumber = 'PMCH-RX-' + Math.floor(100000 + Math.random() * 900000);
  const payload = JSON.stringify({ hospital: 'PMCH & RI', rxNumber, uhid, doctor: doctorName, date: new Date().toISOString().split('T')[0] });
  try {
    const qrDataUrl = await QRCode.toDataURL(payload);
    db.prepare('INSERT INTO prescriptions (rx_number, uhid, doctor_name, diagnosis, medications_json, qr_data) VALUES (?, ?, ?, ?, ?, ?)').run(
      rxNumber, uhid, doctorName, diagnosis, JSON.stringify(medications), qrDataUrl
    );
    res.json({ success: true, prescription: { rxNumber, uhid, doctorName, diagnosis, medications, qrDataUrl, date: new Date().toLocaleDateString('en-IN') } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Doctors & Pharmacy Endpoints
app.get('/api/pmch/doctors', (req, res) => res.json(db.prepare('SELECT * FROM doctors').all()));
app.get('/api/pmch/pharmacy/catalog-list', (req, res) => res.json(db.prepare('SELECT id, name FROM medicines').all()));

app.get('/api/pmch/pharmacy', (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.name, m.category, m.requires_rx, m.reorder_level,
           COALESCE(SUM(b.current_stock), 0) AS stock,
           COALESCE(MIN(b.unit_price), 25.0) AS price,
           COALESCE(MIN(b.expiry_date), 'N/A') AS earliest_expiry
    FROM medicines m
    LEFT JOIN medicine_batches b ON m.id = b.medicine_id AND b.current_stock > 0 AND b.expiry_date > DATE('now')
    GROUP BY m.id
  `).all());
});

app.get('/api/pmch/pharmacy/batches', (req, res) => {
  res.json(db.prepare('SELECT b.*, m.name as medicine_name FROM medicine_batches b JOIN medicines m ON b.medicine_id = m.id ORDER BY b.expiry_date ASC').all());
});

app.post('/api/pmch/pharmacy/dispense', (req, res) => {
  const { cart, uhid, paymentId } = req.body;
  if (!cart || cart.length === 0) return res.status(400).json({ error: 'Cart empty' });
  const today = new Date().toISOString().split('T')[0];

  const dispenseTx = db.transaction(() => {
    let totalBill = 0;
    const dispensedDetails = [];
    for (const item of cart) {
      let needed = item.qty;
      const batches = db.prepare('SELECT * FROM medicine_batches WHERE medicine_id = ? AND current_stock > 0 AND expiry_date > ? ORDER BY expiry_date ASC').all(item.id, today);
      for (const batch of batches) {
        if (needed <= 0) break;
        const deduct = Math.min(batch.current_stock, needed);
        db.prepare('UPDATE medicine_batches SET current_stock = current_stock - ? WHERE id = ?').run(deduct, batch.id);
        needed -= deduct;
        totalBill += deduct * batch.unit_price;
        dispensedDetails.push({ medicineName: item.name, batchNumber: batch.batch_number, expiryDate: batch.expiry_date, quantity: deduct });
      }
    }
    const orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
    db.prepare('INSERT INTO orders (order_id, uhid, total_amount, items_json, payment_id) VALUES (?, ?, ?, ?, ?)').run(
      orderId, uhid || 'PMCH-80097', totalBill, JSON.stringify(dispensedDetails), paymentId || 'PMCH-TXN-UPI'
    );
    return { orderId, totalBill, dispensedDetails };
  });

  const result = dispenseTx();
  res.json({ success: true, order: result });
});

// Hospital Beds & Diagnostics
app.get('/api/pmch/ipd/beds', (req, res) => res.json(db.prepare('SELECT * FROM hospital_beds').all()));
app.get('/api/pmch/lims/catalog', (req, res) => res.json(db.prepare('SELECT * FROM lab_tests').all()));
app.get('/api/pmch/lims/orders', (req, res) => res.json(db.prepare('SELECT * FROM lab_orders ORDER BY id DESC').all()));

app.post('/api/pmch/lims/order', (req, res) => {
  const { uhid, testId } = req.body;
  const test = db.prepare('SELECT * FROM lab_tests WHERE id = ?').get(testId);
  const orderId = 'LAB-' + Math.floor(100000 + Math.random() * 900000);
  db.prepare("INSERT INTO lab_orders (order_id, uhid, test_id, test_name, doctor_name) VALUES (?, ?, ?, ?, 'Dr. Suresh Kumar')").run(orderId, uhid || 'PMCH-80097', test.id, test.name);
  res.json({ success: true, orderId });
});

app.post('/api/pmch/lims/report-result', (req, res) => {
  const { orderId, resultVal } = req.body;
  db.prepare("UPDATE lab_orders SET result_val = ?, flag = 'NORMAL', status = 'REPORT_PUBLISHED' WHERE order_id = ?").run(resultVal, orderId);
  res.json({ success: true });
});

app.post('/api/pmch/confirm-booking', (req, res) => {
  const { doctorId, patientName, patientPhone, uhid, amount, paymentId } = req.body;
  const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId);
  const last = db.prepare('SELECT MAX(token_number) as maxToken FROM appointments WHERE doctor_id = ?').get(doctorId);
  const nextToken = (last?.maxToken) ? last.maxToken + 1 : 105;
  const finalUhid = uhid || 'PMCH-80097';
  db.prepare('INSERT INTO appointments (token_number, doctor_id, doctor_name, patient_name, patient_phone, uhid, payment_id, amount_paid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    nextToken, doc.id, doc.name, patientName, patientPhone, finalUhid, paymentId || 'PMCH-TXN-UPI', amount || doc.fee
  );

  const textMsg = `Namaste ${patientName}. Appointment booked with ${doc.name} (${doc.unit}). Token #${nextToken}. Payment Ref: ${paymentId || 'DIRECT'}`;
  db.prepare('INSERT INTO notification_logs (channel, recipient_phone, template_name, message_body) VALUES (?, ?, ?, ?)').run(
    'WHATSAPP', patientPhone || '+91 98765 43210', 'WA_APPOINTMENT_CONFIRMATION', textMsg
  );

  res.json({ success: true, tokenNumber: nextToken, currentServing: doc.current_token || 101, doctorName: doc.name, specialty: doc.specialty, uhid: finalUhid });
});

// Insurance & Billing
app.get('/api/pmch/insurance/policy/:uhid', (req, res) => {
  const uhid = req.params.uhid.trim();
  const policy = db.prepare('SELECT * FROM patient_insurance WHERE uhid = ?').get(uhid);
  res.json(policy || { uhid, status: 'NONE' });
});

app.post('/api/pmch/insurance/register', (req, res) => {
  try {
    const { uhid, tpaProvider, policyNo, preauthApprovalLimit, coveragePercent } = req.body;
    if (!uhid || !policyNo) return res.status(400).json({ error: 'UHID and Policy Number are required.' });
    db.prepare("INSERT OR REPLACE INTO patient_insurance (uhid, tpa_provider, policy_no, preauth_approval_limit, coverage_percent, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')").run(
      uhid.trim(), tpaProvider || 'Star Health', policyNo.trim(), parseFloat(preauthApprovalLimit) || 50000.0, parseInt(coveragePercent) || 80
    );
    res.json({ success: true, message: `Insurance policy linked successfully to ${uhid.trim()}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pmch/billing/summary/:uhid', (req, res) => {
  try {
    const uhid = req.params.uhid.trim();
    const doctorFee = db.prepare('SELECT amount_paid FROM appointments WHERE uhid = ?').all(uhid).reduce((s, a) => s + (a.amount_paid || 0), 0);
    const pharmacyTotal = db.prepare('SELECT total_amount FROM orders WHERE uhid = ?').all(uhid).reduce((s, o) => s + (o.total_amount || 0), 0);
    const labTotal = db.prepare('SELECT t.price FROM lab_orders l JOIN lab_tests t ON l.test_id = t.id WHERE l.uhid = ?').all(uhid).reduce((s, l) => s + (l.price || 0), 0);
    const bed = db.prepare('SELECT * FROM hospital_beds WHERE assigned_uhid = ?').get(uhid);
    const bedCharges = bed ? bed.daily_rate * 2 : 0;
    const grandTotal = doctorFee + pharmacyTotal + labTotal + bedCharges;

    const policy = db.prepare('SELECT * FROM patient_insurance WHERE uhid = ?').get(uhid);
    let insuranceCovered = 0;
    let patientCopay = grandTotal;

    if (policy && policy.status === 'ACTIVE') {
      const maxCoverage = (grandTotal * (policy.coverage_percent / 100));
      insuranceCovered = Math.min(maxCoverage, policy.preauth_approval_limit);
      patientCopay = Math.max(0, grandTotal - insuranceCovered);
    }

    res.json({
      uhid,
      doctorFee,
      pharmacyTotal,
      labTotal,
      bedCharges,
      bedDetails: bed || null,
      grandTotal,
      insuranceCovered,
      patientCopay,
      insurancePolicy: policy || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pmch/billing/settle-discharge', (req, res) => {
  try {
    const { uhid, doctorFee, pharmacyTotal, labTotal, bedCharges, grandTotal, insuranceCovered, patientCopay, tpaName, paymentId } = req.body;
    const targetUhid = uhid ? uhid.trim() : 'PMCH-80097';
    const billId = 'PMCH-INV-' + Math.floor(100000 + Math.random() * 900000);
    const claimId = 'CLM-' + Math.floor(100000 + Math.random() * 900000);
    const paymentRef = paymentId || ('PMCH-UPI-' + Math.random().toString(36).substring(2, 8).toUpperCase());

    db.prepare(`
      INSERT INTO discharge_bills (bill_id, uhid, doctor_fee, pharmacy_total, lab_total, bed_charges, grand_total, insurance_paid, copay_paid, tpa_ref, payment_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      billId, targetUhid, doctorFee || 0, pharmacyTotal || 0, labTotal || 0, bedCharges || 0, grandTotal || 0,
      insuranceCovered || 0, patientCopay || 0, tpaName || 'Direct Cash/UPI', paymentRef
    );

    if (insuranceCovered && insuranceCovered > 0) {
      db.prepare(`
        INSERT INTO insurance_claims (claim_id, uhid, bill_id, tpa_name, total_bill, claimed_amount, patient_copay, claim_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'SETTLED')
      `).run(claimId, targetUhid, billId, tpaName, grandTotal, insuranceCovered, patientCopay);
    }

    db.prepare("UPDATE hospital_beds SET status = 'VACANT', assigned_uhid = NULL, admitted_at = NULL WHERE assigned_uhid = ?").run(targetUhid);

    const dischargeMsg = `Panimalar Hospital Discharge Dossier: Invoice ${billId} settled. TPA Coverage: INR ${insuranceCovered || 0}, Patient Co-Pay Settled: INR ${patientCopay || 0}. Download your official dossier on the hospital portal.`;
    db.prepare('INSERT INTO notification_logs (channel, recipient_phone, template_name, message_body) VALUES (?, ?, ?, ?)').run(
      'WHATSAPP', '+91 98765 43210', 'WA_DISCHARGE_DOSSIER_SENT', dischargeMsg
    );

    return res.json({
      success: true,
      billId,
      claimId: (insuranceCovered && insuranceCovered > 0) ? claimId : null,
      dischargeDate: new Date().toLocaleDateString('en-IN')
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Operations
app.post('/api/pmch/admin/add-medicine', (req, res) => {
  const { name, category, batchNumber, expiryDate, unitPrice, stock, barcode } = req.body;
  const medId = 'pmch-med-' + Date.now();
  db.prepare('INSERT INTO medicines (id, name, category, reorder_level, reorder_qty, requires_rx) VALUES (?, ?, ?, 20, 100, 1)').run(medId, name, category);
  db.prepare("INSERT INTO medicine_batches (medicine_id, batch_number, expiry_date, unit_price, current_stock, barcode_data, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')").run(
    medId, batchNumber, expiryDate, parseFloat(unitPrice) || 25, parseInt(stock) || 50, barcode || ('8901' + Date.now().toString().slice(-8))
  );
  res.json({ success: true, message: `Medicine '${name}' registered with Barcode!` });
});

app.post('/api/pmch/admin/add-batch', (req, res) => {
  const { medicineId, batchNumber, expiryDate, unitPrice, stock, barcode } = req.body;
  db.prepare("INSERT INTO medicine_batches (medicine_id, batch_number, expiry_date, unit_price, current_stock, barcode_data, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')").run(
    medicineId, batchNumber, expiryDate, parseFloat(unitPrice) || 25, parseInt(stock) || 50, barcode || ('8901' + Date.now().toString().slice(-8))
  );
  res.json({ success: true, message: `Batch '${batchNumber}' inwarded!` });
});

app.post('/api/pmch/admin/add-bed', (req, res) => {
  const { bedId, wardType, block, dailyRate } = req.body;
  db.prepare("INSERT INTO hospital_beds (bed_id, ward_type, block, daily_rate, status) VALUES (?, ?, ?, ?, 'VACANT')").run(bedId, wardType, block || 'Main Block', parseFloat(dailyRate) || 1000);
  res.json({ success: true, message: `Bed '${bedId}' created!` });
});

app.post('/api/pmch/admin/update-bed-allocation', (req, res) => {
  const { bedId, uhid, admittedAt, status } = req.body;
  if (status === 'VACANT') {
    db.prepare("UPDATE hospital_beds SET status = 'VACANT', assigned_uhid = NULL, admitted_at = NULL WHERE bed_id = ?").run(bedId);
  } else {
    db.prepare("UPDATE hospital_beds SET status = 'OCCUPIED', assigned_uhid = ?, admitted_at = ? WHERE bed_id = ?").run(
      uhid || 'PMCH-80097', admittedAt || new Date().toISOString().replace('T', ' ').substring(0, 19), bedId
    );
  }
  res.json({ success: true, message: `Bed '${bedId}' updated!` });
});

app.post('/api/pmch/admin/add-doctor', (req, res) => {
  const { name, specialty, exp, fee, unit } = req.body;
  const docId = 'pmch-' + Date.now();
  db.prepare('INSERT INTO doctors (id, name, specialty, exp, fee, unit, current_token) VALUES (?, ?, ?, ?, ?, ?, 101)').run(docId, name, specialty, exp || '10 yrs', parseInt(fee) || 300, unit || 'OPD Block A');
  res.json({ success: true, message: `Doctor '${name}' added!` });
});

app.get('/api/pmch/ehr/patient/:uhid', (req, res) => {
  const uhid = req.params.uhid.trim();
  res.json({
    uhid,
    appointments: db.prepare('SELECT * FROM appointments WHERE uhid = ? ORDER BY id DESC').all(uhid) || [],
    orders: db.prepare('SELECT * FROM orders WHERE uhid = ? ORDER BY id DESC').all(uhid) || [],
    prescriptions: db.prepare('SELECT * FROM prescriptions WHERE uhid = ? ORDER BY id DESC').all(uhid) || [],
    labOrders: db.prepare('SELECT * FROM lab_orders WHERE uhid = ? ORDER BY id DESC').all(uhid) || [],
    beds: db.prepare('SELECT * FROM hospital_beds WHERE assigned_uhid = ?').all(uhid) || [],
    insurance: db.prepare('SELECT * FROM patient_insurance WHERE uhid = ?').get(uhid) || null,
    claims: db.prepare('SELECT * FROM insurance_claims WHERE uhid = ? ORDER BY id DESC').all(uhid) || [],
    abha: db.prepare('SELECT * FROM abha_identities WHERE uhid = ?').get(uhid) || null
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log('PMCH Unified Server Active on port ' + PORT));
