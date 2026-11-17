// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'CHANGE_ME_ADMIN_TOKEN';
const PORT = process.env.PORT || 4000;

if (!MONGODB_URI) {
  console.error('FATAL: MONGODB_URI environment variable missing');
  process.exit(1);
}

// ─────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connect error:', err.message);
    process.exit(1);
  });

const DeviceSchema = new mongoose.Schema(
  {
    secretKey: { type: String, unique: true, required: true, index: true },
    name: { type: String, required: true },
    brand: String,
    model: String,
    device: String,
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
  },
  { timestamps: true }
);

const Device = mongoose.model('Device', DeviceSchema);

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function sanitize(str, max = 64) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}

// ─────────────────────────────────────────────
// PUBLIC API (app ব্যবহার করে)
// ─────────────────────────────────────────────

// হেলথ চেক
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// ১. স্ট্যাটাস চেক — অ্যাপ প্রথমে এটাই কল করবে
// GET /api/approval/:secretKey
app.get('/api/approval/:secretKey', async (req, res) => {
  try {
    const key = sanitize(req.params.secretKey, 128);
    if (!key) return res.json({ status: 'not_found' });

    const device = await Device.findOne({ secretKey: key }).lean();
    if (!device) return res.json({ status: 'not_found' });

    res.json({
      status: device.status,
      name: device.name,
      updatedAt: device.updatedAt,
    });
  } catch (err) {
    console.error('GET /api/approval error:', err);
    res.status(500).json({ status: 'error' });
  }
});

// ২. নতুন অনুমোদনের আবেদন জমা
// POST /api/approval
// body: { secretKey, name, brand, model, device }
app.post('/api/approval', async (req, res) => {
  try {
    const secretKey = sanitize(req.body.secretKey, 128);
    const name = sanitize(req.body.name, 64);
    const brand = sanitize(req.body.brand, 32);
    const model = sanitize(req.body.model, 64);
    const device = sanitize(req.body.device, 64);

    if (!secretKey || !name) {
      return res.status(400).json({ error: 'secretKey and name required' });
    }

    // আগে থেকে থাকলে সেটাই রিটার্ন
    const existing = await Device.findOne({ secretKey });
    if (existing) {
      return res.json({
        status: existing.status,
        name: existing.name,
        alreadyExists: true,
      });
    }

    const created = await Device.create({
      secretKey,
      name,
      brand,
      model,
      device,
      status: 'pending',
    });

    res.json({
      status: created.status,
      name: created.name,
      id: created._id,
    });
  } catch (err) {
    // duplicate key race condition
    if (err.code === 11000) {
      const existing = await Device.findOne({
        secretKey: sanitize(req.body.secretKey, 128),
      });
      return res.json({
        status: existing ? existing.status : 'pending',
        alreadyExists: true,
      });
    }
    console.error('POST /api/approval error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────
// ADMIN API (admin.html ব্যবহার করবে)
// ─────────────────────────────────────────────

// লগইন যাচাই
// POST /api/admin/login { token }
app.post('/api/admin/login', (req, res) => {
  const token = req.body && req.body.token;
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'wrong_token' });
  }
  res.json({ ok: true });
});

// সব ডিভাইস লিস্ট (ফিল্টার + পেজিনেশন)
// GET /api/admin/devices?status=pending&page=1&limit=50
app.get('/api/admin/devices', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const skip = (page - 1) * limit;

    const filter = {};
    if (['pending', 'approved', 'rejected'].includes(status)) {
      filter.status = status;
    }

    const [items, total] = await Promise.all([
      Device.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Device.countDocuments(filter),
    ]);

    res.json({ items, total, page, limit });
  } catch (err) {
    console.error('GET /api/admin/devices error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// স্ট্যাটাস আপডেট
// POST /api/admin/status { secretKey, action: approve|reject|pending }
app.post('/api/admin/status', requireAdmin, async (req, res) => {
  try {
    const secretKey = sanitize(req.body.secretKey, 128);
    const action = req.body.action;

    const map = {
      approve: 'approved',
      reject: 'rejected',
      pending: 'pending',
    };
    const status = map[action];
    if (!secretKey || !status) {
      return res.status(400).json({ error: 'invalid_input' });
    }

    const updated = await Device.findOneAndUpdate(
      { secretKey },
      { status },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'not_found' });

    res.json({ ok: true, status: updated.status });
  } catch (err) {
    console.error('POST /api/admin/status error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ডিভাইস ডিলিট
// POST /api/admin/delete { secretKey }
app.post('/api/admin/delete', requireAdmin, async (req, res) => {
  try {
    const secretKey = sanitize(req.body.secretKey, 128);
    if (!secretKey) return res.status(400).json({ error: 'invalid_input' });
    await Device.deleteOne({ secretKey });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/delete error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// স্ট্যাটস
// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [pending, approved, rejected, total] = await Promise.all([
      Device.countDocuments({ status: 'pending' }),
      Device.countDocuments({ status: 'approved' }),
      Device.countDocuments({ status: 'rejected' }),
      Device.countDocuments({}),
    ]);
    res.json({ pending, approved, rejected, total });
  } catch (err) {
    console.error('GET /api/admin/stats error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────
// STATIC FILES & ADMIN PANEL
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─────────────────────────────────────────────
// 404 fallback
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
