const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config(); // লোকাল টেস্টিংয়ের জন্য, Render-এ এনভায়রনমেন্ট ভ্যারিয়েবল কাজ করবে

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection (Render Environment Variable থেকে MONGO_URI নিবে)
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => console.log('MongoDB Connection Error: ', err));

// Database Schema
const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    hasName: { type: Boolean, default: false },
    approvalStatus: { type: String, default: 'pending' }, // 'pending', 'approved', 'rejected'
    createdAt: { type: Date, default: Date.now }
});

const Device = mongoose.model('Device', deviceSchema);

// ==========================================
// USER APP APIs (Smali থেকে কল হবে)
// ==========================================

// 1. Check Status (অ্যাপ ওপেন হলে চেক করবে)
app.get('/api/check-status/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    try {
        let device = await Device.findOne({ deviceId });
        
        // যদি নতুন ডিভাইস হয়, তবে ডেটাবেসে pending অবস্থায় সেভ করবে
        if (!device) {
            device = new Device({ 
                deviceId: deviceId, 
                hasName: false, 
                approvalStatus: 'pending' 
            });
            await device.save();
        }
        
        // Smali কোডে ঠিক এই ৩টি জিনিস এক্সপেক্ট করে
        res.json({
            deviceId: device.deviceId,
            approvalStatus: device.approvalStatus,
            hasName: device.hasName
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// 2. Request Approval (Smali-এর ApprovalGate$4 থেকে নাম সাবমিট হলে)
app.post('/api/request-approval', async (req, res) => {
    const { deviceId, name } = req.body;
    try {
        // চেক করবে নামটি আগেই কেউ নিয়েছে কিনা (আপনার Smali কোডে এই এরর টোস্টটি আছে)
        const existingName = await Device.findOne({ name: name.trim() });
        if (existingName && existingName.deviceId !== deviceId) {
            // যদি নাম মিলে যায় কিন্তু ডিভাইস আইডি ভিন্ন হয়, তবে 400 এরর পাঠাবে
            return res.status(400).json({ error: 'Name already taken' }); 
        }

        let device = await Device.findOne({ deviceId });
        if (device) {
            device.name = name.trim();
            device.hasName = true;
            device.approvalStatus = 'pending'; // নাম সাবমিট করলে স্ট্যাটাস pending থাকবে
            await device.save();
            res.status(200).json({ success: true });
        } else {
            res.status(404).json({ error: 'Device not found' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// ADMIN DASHBOARD APIs
// ==========================================

// Admin Middleware (Render Environment Variable থেকে ADMIN_PASSWORD চেক করবে)
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
        const devices = await Device.find().sort({ createdAt: -1 }); // নতুনগুলো আগে দেখাবে
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
app.listen(PORT, () => {
    console.log(`Approval Gate Server is running on port ${PORT}`);
});
