// index.js

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация Firebase Admin
if (!admin.apps.length) {
  let credential;
  
  // Пробуем загрузить из файла (для локальной разработки)
  const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");
  console.log("🔍 Looking for:", serviceAccountPath);
  console.log("📁 File exists:", fs.existsSync(serviceAccountPath));
  
  if (fs.existsSync(serviceAccountPath)) {
    console.log("📁 Using serviceAccountKey.json file");
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    console.log("📋 project_id:", serviceAccount.project_id);
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_PROJECT_ID) {
    // Используем environment variables (для Vercel)
    console.log("🔐 Using environment variables");
    credential = admin.credential.cert({
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    });
  } else {
    console.error("❌ No credentials found! Add serviceAccountKey.json or set environment variables.");
    process.exit(1);
  }

  admin.initializeApp({
    credential: credential,
    databaseURL: "https://truckstop-viewer-default-rtdb.firebaseio.com"
  });
  
  console.log("✅ Firebase initialized");
}

const db = admin.database();

// Nodemailer
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "2104.01038@manas.edu.kg",
    pass: process.env.SMTP_PASS || "dulg ezgq vdpl pkrk",
  },
});

// Генерация 6-значного OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ========================
// ROUTES
// ========================

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "OTP Server" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// POST /send-otp
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Генерируем OTP
    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 минут

    // Сохраняем в Firebase
    const emailKey = email.replace(/\./g, "_").replace(/@/g, "_at_");
    const otpRef = db.ref(`otpCodes/${emailKey}`);
    await otpRef.set({
      code: otp,
      expiresAt: expiresAt,
      attempts: 0,
      createdAt: Date.now(),
    });

    // Отправляем email
    const mailOptions = {
      from: '"Load Radar AI" <2104.01038@manas.edu.kg>',
      to: email,
      subject: "Your verification code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1976D2; text-align: center;">Load Radar AI</h2>
          <p style="text-align: center; color: #666;">Your verification code is:</p>
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #333;">${otp}</span>
          </div>
          <p style="text-align: center; color: #999; font-size: 12px;">
            This code expires in 5 minutes.<br>
            If you didn't request this code, please ignore this email.
          </p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    console.log(`✅ OTP sent to ${email}`);
    res.json({ success: true, message: "OTP sent successfully" });

  } catch (error) {
    console.error("❌ Error sending OTP:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// POST /verify-otp
app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    // Получаем OTP из Firebase
    const emailKey = email.replace(/\./g, "_").replace(/@/g, "_at_");
    const otpRef = db.ref(`otpCodes/${emailKey}`);
    const snapshot = await otpRef.get();

    if (!snapshot.exists()) {
      return res.status(400).json({ error: "Code not found. Please request a new code." });
    }

    const otpData = snapshot.val();

    // Проверяем попытки
    if (otpData.attempts >= 5) {
      await otpRef.remove();
      return res.status(400).json({ error: "Too many attempts. Please request a new code." });
    }

    // Проверяем срок
    if (Date.now() > otpData.expiresAt) {
      await otpRef.remove();
      return res.status(400).json({ error: "Code expired. Please request a new code." });
    }

    // Проверяем код
    if (otpData.code !== otp) {
      await otpRef.update({ attempts: otpData.attempts + 1 });
      const remaining = 5 - otpData.attempts - 1;
      return res.status(400).json({ error: `Invalid code. ${remaining} attempts remaining.` });
    }

    // Успех!
    await otpRef.remove();
    console.log(`✅ OTP verified for ${email}`);
    res.json({ success: true, message: "OTP verified successfully" });

  } catch (error) {
    console.error("❌ Error verifying OTP:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// Для локального запуска
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 OTP Server running on port ${PORT}`);
});

module.exports = app;