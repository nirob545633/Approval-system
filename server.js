const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

// dotenv যদি ইন্সটল না থাকে, তবুও যেন Render-এ ক্র্যাশ না করে তাই try-catch দেওয়া হলো
try {
    require('dotenv').config();
} catch (err) {
    console.log("dotenv module not found. Relying on Render environment variables.");
}

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection (Render Environment Variable থেকে MONGO_URI নিবে)
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error("Fatal Error: MONGO_URI is missing in Environment Variables!");
} else {
    mongoose.connect(mongoURI)
      .then(() => console.log('MongoDB Connected Successfully'))
      .catch(err => console.log('MongoDB Connection Error: ', err));
}

// Database Schema
const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    hasName: { type: Boolean, default: false },
    approvalStatus: { type: String, default: 'pending' }, // 'pending', 'approved', 'rejected'
    whatsappNumber: { type: String, default: '+8801705891010' }, // নতুন যোগ করা হলো
    createdAt: { type: Date, default: Date.now }
});

const Device = mongoose.model('Device', deviceSchema);

// ==========================================
// USER APP APIs (Smali থেকে কল হবে)
// ==========================================

// 1. Check Status (অ্যাপ ওপেন হলে চেক করবে)
app.get('/api/check-status/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    console.log(`[APP REQUEST] Check Status for Device: ${deviceId}`); // লগ যুক্ত করা হলো
    
    try {
        let device = await Device.findOne({ deviceId });
        
        // যদি নতুন ডিভাইস হয়, তবে ডেটাবেসে pending অবস্থায় সেভ করবে
        if (!device) {
            console.log(`[NEW DEVICE] Registering new device: ${deviceId}`);
            device = new Device({ 
                deviceId: deviceId, 
                hasName: false, 
                approvalStatus: 'pending' 
            });
            await device.save();
        }
        
        res.json({
            deviceId: device.deviceId,
            approvalStatus: device.approvalStatus,
            hasName: device.hasName,
            whatsappNumber: device.whatsappNumber // নতুন যোগ করা হলো
        });
    } catch (err) {
        console.error("Check Status Error:", err);
        res.status(500).json({ error: 'Server error' });
    }
});

// 2. Request Approval (Smali-এর ApprovalGate$4 থেকে নাম সাবমিট হলে)
app.post('/api/request-approval', async (req, res) => {
    const { deviceId, name } = req.body;
    console.log(`[APP REQUEST] Name Submit - Device: ${deviceId}, Name: ${name}`); // লগ যুক্ত করা হলো
    
    try {
        // চেক করবে নামটি আগেই কেউ নিয়েছে কিনা
        const existingName = await Device.findOne({ name: name.trim() });
        if (existingName && existingName.deviceId !== deviceId) {
            return res.status(400).json({ error: 'Name already taken' }); 
        }

        let device = await Device.findOne({ deviceId });
        if (device) {
            device.name = name.trim();
            device.hasName = true;
            device.approvalStatus = 'pending'; // নাম দিলে pending থাকবে
            await device.save();
            console.log(`[APP SUCCESS] Name updated for device: ${deviceId}`);
            res.status(200).json({ success: true });
        } else {
            res.status(404).json({ error: 'Device not found' });
        }
    } catch (err) {
        console.error("Request Approval Error:", err);
        res.status(500).json({ error: 'Server error' });
    }
});

// 3. Update WhatsApp Number (নতুন যোগ করা হলো)
app.post('/api/update-number', async (req, res) => {
    const { deviceId, whatsappNumber } = req.body;
    console.log(`[APP REQUEST] Update Number - Device: ${deviceId}, Number: ${whatsappNumber}`);
    
    try {
        if (!deviceId || !whatsappNumber) {
            return res.status(400).json({ error: 'deviceId and whatsappNumber are required' });
        }

        let device = await Device.findOne({ deviceId });
        if (device) {
            device.whatsappNumber = whatsappNumber.trim();
            await device.save();
            console.log(`[APP SUCCESS] Number updated for device: ${deviceId}`);
            res.status(200).json({ success: true, whatsappNumber: device.whatsappNumber });
        } else {
            // যদি ডিভাইস না থাকে, তবে নতুন ডিভাইস হিসেবে সেভ করবে
            device = new Device({ 
                deviceId: deviceId, 
                whatsappNumber: whatsappNumber.trim(),
                approvalStatus: 'pending' 
            });
            await device.save();
            console.log(`[NEW DEVICE] Created with number for device: ${deviceId}`);
            res.status(200).json({ success: true, whatsappNumber: device.whatsappNumber });
        }
    } catch (err) {
        console.error("Update Number Error:", err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// ADMIN DASHBOARD APIs
// ==========================================

// Admin Middleware
const checkAdminAuth = (req, res, next) => {
    const adminPass = req.headers['x-admin-password'];
    if (adminPass === process.env.ADMIN_PASSWORD) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized Access! Wrong Password.' });
    }
};

// Admin Page Serve
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Get All Users Data
app.get('/api/admin/devices', checkAdminAuth, async (req, res) => {
    try {
        const devices = await Device.find().sort({ createdAt: -1 });
        res.json(devices);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});

// Change Status (Approve / Reject)
app.post('/api/admin/update-status', checkAdminAuth, async (req, res) => {
    const { deviceId, status } = req.body;
    try {
        await Device.findOneAndUpdate({ deviceId }, { approvalStatus: status });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Update failed' });
    }
});

// Delete a User
app.post('/api/admin/delete', checkAdminAuth, async (req, res) => {
    const { deviceId } = req.body;
    try {
        await Device.findOneAndDelete({ deviceId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
// Render-এ পোর্ট বাইন্ড করার জন্য 0.0.0.0 দেওয়া হলো
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Approval Gate Server is running on port ${PORT}`);
});
