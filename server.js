const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

// dotenv যদি ইন্সটল না থাকে, তবুও যেন Render-এ ক্র্যাশ না করে তাই try-catch দেওয়া হলো
try {
    require('dotenv').config();
} catch (err) {
    console.log("dotenv module not found. Relying on Render environment variables.");
}

const app = express();

// Render reverse proxy-র পিছনে সঠিক client IP পাওয়ার জন্য
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// ==================== SAFETY NETS (সার্ভার যেন না মরে) ====================
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

// MongoDB Connection (Render Environment Variable থেকে MONGO_URI নিবে)
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error("Fatal Error: MONGO_URI is missing in Environment Variables!");
} else {
    mongoose.set('strictQuery', true);
    mongoose.connect(mongoURI, {
        serverSelectionTimeoutMS: 15000,
        socketTimeoutMS: 45000
    })
      .then(() => console.log('MongoDB Connected Successfully'))
      .catch(err => console.log('MongoDB Connection Error: ', err));

    mongoose.connection.on('error', (err) => {
        console.error('[MONGO ERROR]', err && err.message ? err.message : err);
    });
    mongoose.connection.on('disconnected', () => {
        console.warn('[MONGO DISCONNECTED] trying to reconnect...');
        mongoose.connect(mongoURI, {
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000
        }).catch(err => console.error('[MONGO RECONNECT FAILED]', err && err.message ? err.message : err));
    });
    mongoose.connection.on('reconnected', () => {
        console.log('[MONGO RECONNECTED]');
    });
}

// Database Schema
const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true, trim: true, index: true },
    name: { type: String, default: '', trim: true },
    nameLower: { type: String, default: '', trim: true },
    hasName: { type: Boolean, default: false },
    approvalStatus: { type: String, default: 'pending' },

    // ===== Device info =====
    model: { type: String, default: '' },
    brand: { type: String, default: '' },
    manufacturer: { type: String, default: '' },
    osVersion: { type: String, default: '' },
    sdkInt: { type: Number, default: 0 },
    batteryLevel: { type: Number, default: -1 },
    totalMemory: { type: Number, default: 0 },
    appVersion: { type: String, default: '' },
    appVersionCode: { type: Number, default: 0 },
    language: { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now },

    createdAt: { type: Date, default: Date.now }
});

const Device = mongoose.model('Device', deviceSchema);

// ==================== HELPERS ====================
function normalizeDeviceId(v) {
    if (v === undefined || v === null) return '';
    try {
        return String(v).normalize('NFC').trim();
    } catch (e) {
        return String(v).trim();
    }
}

function isValidDeviceId(v) {
    if (!v) return false;
    if (v.length < 3 || v.length > 128) return false;
    if (v.toLowerCase() === 'unknown_device') return false;
    if (v.toLowerCase() === 'unknown') return false;
    if (v === '9774d56d682e549c') return false;
    return true;
}

function normalizeName(v) {
    if (v === undefined || v === null) return '';
    return String(v).replace(/\s+/g, ' ').trim();
}

function nameLower(v) {
    return normalizeName(v).toLowerCase();
}

function isValidName(v) {
    if (!v) return false;
    if (v.length < 1 || v.length > 60) return false;
    if (normalizeName(v).length === 0) return false;
    return true;
}

function pickString(v, max) {
    if (v === undefined || v === null) return '';
    const s = String(v).trim();
    return s.length > max ? s.substring(0, max) : s;
}

function pickNumber(v, def) {
    if (v === undefined || v === null) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

function extractDeviceInfo(body) {
    const b = body || {};
    return {
        model: pickString(b.model, 80),
        brand: pickString(b.brand, 80),
        manufacturer: pickString(b.manufacturer, 80),
        osVersion: pickString(b.osVersion, 40),
        sdkInt: pickNumber(b.sdkInt, 0),
        batteryLevel: pickNumber(b.batteryLevel, -1),
        totalMemory: pickNumber(b.totalMemory, 0),
        appVersion: pickString(b.appVersion, 40),
        appVersionCode: pickNumber(b.appVersionCode, 0),
        language: pickString(b.language, 20)
    };
}

// ==========================================
// USER APP APIs (Smali থেকে কল হবে)
// ==========================================

// 1. Check Status (অ্যাপ ওপেন হলে চেক করবে)
app.get('/api/check-status/:deviceId', async (req, res, next) => {
    try {
        const deviceId = normalizeDeviceId(req.params.deviceId);
        console.log(`[APP REQUEST] Check Status for Device: ${deviceId}`);

        if (!isValidDeviceId(deviceId)) {
            return res.status(400).json({ success: false, error: 'Invalid deviceId' });
        }

        const info = extractDeviceInfo(req.query || {});

        let device = await Device.findOne({ deviceId });

        if (!device) {
            console.log(`[NEW DEVICE] Registering new device: ${deviceId}`);
            device = new Device({
                deviceId: deviceId,
                hasName: false,
                approvalStatus: 'pending',
                ...info,
                lastSeenAt: new Date()
            });
            try {
                await device.save();
            } catch (saveErr) {
                if (saveErr && saveErr.code === 11000) {
                    device = await Device.findOne({ deviceId });
                    if (!device) throw saveErr;
                } else {
                    throw saveErr;
                }
            }
        } else {
            Object.assign(device, info);
            device.lastSeenAt = new Date();
            await device.save();
        }

        return res.json({
            success: true,
            deviceId: device.deviceId,
            approvalStatus: device.approvalStatus || 'pending',
            hasName: !!device.hasName,
            name: device.name || ''
        });
    } catch (err) {
        console.error("Check Status Error:", err);
        return next(err);
    }
});

// 2. Request Approval
app.post('/api/request-approval', async (req, res, next) => {
    try {
        const body = req.body || {};
        const deviceId = normalizeDeviceId(body.deviceId);
        const name = normalizeName(body.name);
        const nLower = nameLower(name);
        const info = extractDeviceInfo(body);
        console.log(`[APP REQUEST] Name Submit - Device: ${deviceId}, Name: ${name}`);

        if (!isValidDeviceId(deviceId)) {
            return res.status(400).json({ success: false, error: 'Invalid deviceId' });
        }
        if (!isValidName(name)) {
            return res.status(400).json({ success: false, error: 'Invalid name' });
        }

        // ✅ নাম uniqueness চেক বাদ — একই নাম একাধিক ডিভাইসে এলাউ

        let device = await Device.findOne({ deviceId });
        if (!device) {
            device = new Device({ deviceId, hasName: false, approvalStatus: 'pending' });
        }

        device.name = name;
        device.nameLower = nLower;
        device.hasName = true;
        device.approvalStatus = 'pending';
        Object.assign(device, info);
        device.lastSeenAt = new Date();

        await device.save();
        console.log(`[APP SUCCESS] Name updated for device: ${deviceId}`);
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error("Request Approval Error:", err);
        return next(err);
    }
});

// ==========================================
// ADMIN DASHBOARD APIs
// ==========================================

const checkAdminAuth = (req, res, next) => {
    try {
        const adminPass = req.headers['x-admin-password'];
        if (adminPass && adminPass === process.env.ADMIN_PASSWORD) {
            return next();
        }
        return res.status(401).json({ success: false, error: 'Unauthorized Access! Wrong Password.' });
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
};

// Admin Page Serve
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Get All Users Data
app.get('/api/admin/devices', checkAdminAuth, async (req, res, next) => {
    try {
        const devices = await Device.find().sort({ lastSeenAt: -1 }).lean();
        return res.json(devices);
    } catch (err) {
        console.error("Admin Fetch Error:", err);
        return next(err);
    }
});

// Change Status (Approve / Reject)
app.post('/api/admin/update-status', checkAdminAuth, async (req, res, next) => {
    try {
        const body = req.body || {};
        const deviceId = normalizeDeviceId(body.deviceId);
        const status = body.status;

        if (!isValidDeviceId(deviceId)) {
            return res.status(400).json({ success: false, error: 'Invalid deviceId' });
        }
        if (!['pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }

        await Device.findOneAndUpdate({ deviceId }, { approvalStatus: status });
        return res.json({ success: true });
    } catch (err) {
        console.error("Admin Update Status Error:", err);
        return next(err);
    }
});

// Delete a User
app.post('/api/admin/delete', checkAdminAuth, async (req, res, next) => {
    try {
        const body = req.body || {};
        const deviceId = normalizeDeviceId(body.deviceId);

        if (!isValidDeviceId(deviceId)) {
            return res.status(400).json({ success: false, error: 'Invalid deviceId' });
        }

        await Device.findOneAndDelete({ deviceId });
        return res.json({ success: true });
    } catch (err) {
        console.error("Admin Delete Error:", err);
        return next(err);
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
    res.json({
        success: true,
        mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        uptime: process.uptime()
    });
});

// ==========================================
// 404 + GLOBAL ERROR HANDLER
// ==========================================
app.use((req, res) => {
    return res.status(404).json({ success: false, error: 'Not found' });
});

app.use((err, req, res, next) => {
    console.error('[UNHANDLED ROUTE ERROR]', err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ success: false, error: 'Server error' });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Approval Gate Server is running on port ${PORT}`);
});
