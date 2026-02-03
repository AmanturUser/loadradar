// index.js

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ========================
// FIREBASE INITIALIZATION
// ========================

if (!admin.apps.length) {
  let credential;
  
  const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");
  console.log("🔍 Looking for:", serviceAccountPath);
  console.log("📁 File exists:", fs.existsSync(serviceAccountPath));
  
  if (fs.existsSync(serviceAccountPath)) {
    console.log("📁 Using serviceAccountKey.json file");
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    console.log("📋 project_id:", serviceAccount.project_id);
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_PROJECT_ID) {
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
    console.error("❌ No credentials found!");
    process.exit(1);
  }

  admin.initializeApp({
    credential: credential,
    databaseURL: "https://truckstop-viewer-default-rtdb.firebaseio.com"
  });
  
  console.log("✅ Firebase initialized");
}

const db = admin.database();

// ========================
// NODEMAILER (for OTP)
// ========================

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "2104.01038@manas.edu.kg",
    pass: process.env.SMTP_PASS || "dulg ezgq vdpl pkrk",
  },
});

// ========================
// GMAIL OAUTH CONFIG
// ========================

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ========================
// HELPER FUNCTIONS
// ========================

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Получить свежий access token (автообновление через refresh token)
async function getValidAccessToken(userId) {
  const snapshot = await db.ref(`users/${userId}/gmail`).get();
  
  if (!snapshot.exists()) {
    throw new Error("Gmail not connected");
  }

  const gmailData = snapshot.val();
  
  if (!gmailData.refreshToken) {
    throw new Error("No refresh token");
  }

  oauth2Client.setCredentials({
    access_token: gmailData.accessToken,
    refresh_token: gmailData.refreshToken,
  });

  // Проверяем истёк ли токен
  const now = Date.now();
  if (gmailData.expiresAt && now >= gmailData.expiresAt - 60000) {
    // Токен истёк или истечёт в течение минуты — обновляем
    console.log("🔄 Refreshing access token for user:", userId);
    
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      
      // Сохраняем новый токен
      await db.ref(`users/${userId}/gmail`).update({
        accessToken: credentials.access_token,
        expiresAt: credentials.expiry_date,
      });
      
      oauth2Client.setCredentials(credentials);
      console.log("✅ Token refreshed");
    } catch (error) {
      console.error("❌ Failed to refresh token:", error);
      throw new Error("Failed to refresh token. Please reconnect Gmail.");
    }
  }

  return oauth2Client;
}

// ========================
// HEALTH CHECK ROUTES
// ========================

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "LoadRadar API Server" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ========================
// OTP ROUTES
// ========================

// POST /send-otp
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 минут

    const emailKey = email.replace(/\./g, "_").replace(/@/g, "_at_");
    const otpRef = db.ref(`otpCodes/${emailKey}`);
    await otpRef.set({
      code: otp,
      expiresAt: expiresAt,
      attempts: 0,
      createdAt: Date.now(),
    });

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

    const emailKey = email.replace(/\./g, "_").replace(/@/g, "_at_");
    const otpRef = db.ref(`otpCodes/${emailKey}`);
    const snapshot = await otpRef.get();

    if (!snapshot.exists()) {
      return res.status(400).json({ error: "Code not found. Please request a new code." });
    }

    const otpData = snapshot.val();

    if (otpData.attempts >= 5) {
      await otpRef.remove();
      return res.status(400).json({ error: "Too many attempts. Please request a new code." });
    }

    if (Date.now() > otpData.expiresAt) {
      await otpRef.remove();
      return res.status(400).json({ error: "Code expired. Please request a new code." });
    }

    if (otpData.code !== otp) {
      await otpRef.update({ attempts: otpData.attempts + 1 });
      const remaining = 5 - otpData.attempts - 1;
      return res.status(400).json({ error: `Invalid code. ${remaining} attempts remaining.` });
    }

    await otpRef.remove();
    console.log(`✅ OTP verified for ${email}`);
    res.json({ success: true, message: "OTP verified successfully" });

  } catch (error) {
    console.error("❌ Error verifying OTP:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// ========================
// GMAIL OAUTH ROUTES
// ========================

// POST /gmail/auth-url - Получить ссылку для авторизации Gmail
app.post("/gmail/auth-url", async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: userId,
    });

    console.log(`🔗 Auth URL generated for user: ${userId}`);
    res.json({ authUrl });

  } catch (error) {
    console.error("❌ Error generating auth URL:", error);
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

// GET /gmail/callback - Callback от Google после авторизации
app.get("/gmail/callback", async (req, res) => {
  try {
    const { code, state: userId, error: authError } = req.query;

    if (authError) {
      console.error("❌ Auth error:", authError);
      return res.status(400).send(`
        <html>
          <body style="font-family: Arial; text-align: center; padding-top: 50px;">
            <h2>❌ Authorization failed</h2>
            <p>${authError}</p>
            <script>setTimeout(() => window.close(), 3000);</script>
          </body>
        </html>
      `);
    }

    if (!code || !userId) {
      return res.status(400).send("Missing code or userId");
    }

    // Обмениваем code на токены
    const { tokens } = await oauth2Client.getToken(code);
    
    // Получаем email пользователя Gmail
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    
    console.log("✅ Gmail connected:", userInfo.email, "for user:", userId);

    // Сохраняем в Firebase
    await db.ref(`users/${userId}/gmail`).set({
      email: userInfo.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      connectedAt: Date.now(),
      expiresAt: tokens.expiry_date,
    });

    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding-top: 50px;">
          <h2 style="color: #4CAF50;">✅ Gmail connected!</h2>
          <p style="color: #666;">${userInfo.email}</p>
          <p style="color: #999; font-size: 14px;">You can close this window</p>
          <script>
            setTimeout(() => {
              if (window.opener) {
                window.opener.postMessage({ type: 'gmail_connected', email: '${userInfo.email}' }, '*');
              }
              window.close();
            }, 2000);
          </script>
        </body>
      </html>
    `);

  } catch (error) {
    console.error("❌ Gmail callback error:", error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding-top: 50px;">
          <h2 style="color: #f44336;">❌ Connection failed</h2>
          <p style="color: #666;">Please try again</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        </body>
      </html>
    `);
  }
});

// GET /gmail/status/:userId - Проверить статус подключения Gmail
app.get("/gmail/status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const snapshot = await db.ref(`users/${userId}/gmail`).get();
    
    if (!snapshot.exists()) {
      return res.json({ connected: false });
    }

    const data = snapshot.val();
    res.json({ 
      connected: true,
      email: data.email,
      connectedAt: data.connectedAt,
    });

  } catch (error) {
    console.error("❌ Error checking Gmail status:", error);
    res.status(500).json({ error: "Failed to check status" });
  }
});

// DELETE /gmail/disconnect/:userId - Отключить Gmail
app.delete("/gmail/disconnect/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const snapshot = await db.ref(`users/${userId}/gmail`).get();
    
    if (!snapshot.exists()) {
      return res.json({ success: true, message: "Gmail was not connected" });
    }

    // Пытаемся отозвать токен у Google
    const data = snapshot.val();
    if (data.accessToken) {
      try {
        await oauth2Client.revokeToken(data.accessToken);
        console.log("🔓 Token revoked for user:", userId);
      } catch (revokeError) {
        console.log("⚠️ Could not revoke token:", revokeError.message);
      }
    }

    // Удаляем из Firebase
    await db.ref(`users/${userId}/gmail`).remove();
    
    console.log(`✅ Gmail disconnected for user: ${userId}`);
    res.json({ success: true, message: "Gmail disconnected" });

  } catch (error) {
    console.error("❌ Error disconnecting Gmail:", error);
    res.status(500).json({ error: "Failed to disconnect Gmail" });
  }
});

// ========================
// GMAIL SEND ROUTES
// ========================

// POST /gmail/send - Отправить email через Gmail API
app.post("/gmail/send", async (req, res) => {
  try {
    const { userId, to, subject, body, cc, bcc } = req.body;

    if (!userId || !to || !subject || !body) {
      return res.status(400).json({ error: "Missing required fields: userId, to, subject, body" });
    }

    // Получаем валидный токен
    const authClient = await getValidAccessToken(userId);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Получаем email отправителя
    const snapshot = await db.ref(`users/${userId}/gmail/email`).get();
    const senderEmail = snapshot.val();

    // Формируем email
    const emailLines = [
      `From: ${senderEmail}`,
      `To: ${to}`,
    ];
    
    if (cc) emailLines.push(`Cc: ${cc}`);
    if (bcc) emailLines.push(`Bcc: ${bcc}`);
    
    emailLines.push(
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body
    );

    const email = emailLines.join('\r\n');
    const encodedEmail = Buffer.from(email).toString('base64url');

    // Отправляем
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedEmail },
    });

    // Логируем в историю
    await db.ref(`users/${userId}/emailHistory`).push({
      to,
      cc: cc || null,
      subject,
      sentAt: Date.now(),
      messageId: result.data.id,
    });

    console.log(`✅ Email sent to ${to} from user ${userId}`);
    res.json({ success: true, messageId: result.data.id });

  } catch (error) {
    console.error("❌ Gmail send error:", error);
    
    if (error.message?.includes("refresh token") || error.message?.includes("reconnect")) {
      return res.status(401).json({ error: "Gmail token expired. Please reconnect Gmail." });
    }
    
    res.status(500).json({ error: error.message || "Failed to send email" });
  }
});

// POST /gmail/send-template - Отправить email по шаблону
app.post("/gmail/send-template", async (req, res) => {
  try {
    const { userId, to, templateId, variables, cc, bcc } = req.body;

    if (!userId || !to || !templateId || !variables) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Получаем шаблон из Firebase
    const templateSnapshot = await db.ref(`users/${userId}/emailTemplates/${templateId}`).get();
    
    if (!templateSnapshot.exists()) {
      return res.status(404).json({ error: "Template not found" });
    }

    const template = templateSnapshot.val();
    
    // Заменяем переменные в шаблоне
    let subject = template.subject;
    let body = template.body;

    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      subject = subject.replace(regex, value);
      body = body.replace(regex, value);
    }

    // Получаем валидный токен
    const authClient = await getValidAccessToken(userId);
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Получаем email отправителя
    const snapshot = await db.ref(`users/${userId}/gmail/email`).get();
    const senderEmail = snapshot.val();

    // Формируем email
    const emailLines = [
      `From: ${senderEmail}`,
      `To: ${to}`,
    ];
    
    if (cc) emailLines.push(`Cc: ${cc}`);
    if (bcc) emailLines.push(`Bcc: ${bcc}`);
    
    emailLines.push(
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body
    );

    const email = emailLines.join('\r\n');
    const encodedEmail = Buffer.from(email).toString('base64url');

    // Отправляем
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedEmail },
    });

    // Логируем
    await db.ref(`users/${userId}/emailHistory`).push({
      to,
      cc: cc || null,
      subject,
      templateId,
      sentAt: Date.now(),
      messageId: result.data.id,
    });

    console.log(`✅ Template email sent to ${to} from user ${userId}`);
    res.json({ success: true, messageId: result.data.id });

  } catch (error) {
    console.error("❌ Gmail template send error:", error);
    res.status(500).json({ error: error.message || "Failed to send email" });
  }
});

// ========================
// EMAIL TEMPLATES ROUTES
// ========================

// GET /templates/:userId - Получить все шаблоны пользователя
app.get("/templates/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const snapshot = await db.ref(`users/${userId}/emailTemplates`).get();
    
    if (!snapshot.exists()) {
      return res.json({ templates: [] });
    }

    const templatesObj = snapshot.val();
    const templates = Object.entries(templatesObj).map(([id, data]) => ({
      id,
      ...data,
    }));

    res.json({ templates });

  } catch (error) {
    console.error("❌ Error getting templates:", error);
    res.status(500).json({ error: "Failed to get templates" });
  }
});

// POST /templates/:userId - Создать шаблон
app.post("/templates/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, subject, body } = req.body;

    if (!name || !subject || !body) {
      return res.status(400).json({ error: "Missing required fields: name, subject, body" });
    }

    const newRef = await db.ref(`users/${userId}/emailTemplates`).push({
      name,
      subject,
      body,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    console.log(`✅ Template created for user ${userId}: ${newRef.key}`);
    res.json({ success: true, templateId: newRef.key });

  } catch (error) {
    console.error("❌ Error creating template:", error);
    res.status(500).json({ error: "Failed to create template" });
  }
});

// PUT /templates/:userId/:templateId - Обновить шаблон
app.put("/templates/:userId/:templateId", async (req, res) => {
  try {
    const { userId, templateId } = req.params;
    const { name, subject, body } = req.body;

    await db.ref(`users/${userId}/emailTemplates/${templateId}`).update({
      name,
      subject,
      body,
      updatedAt: Date.now(),
    });

    console.log(`✅ Template updated: ${templateId}`);
    res.json({ success: true });

  } catch (error) {
    console.error("❌ Error updating template:", error);
    res.status(500).json({ error: "Failed to update template" });
  }
});

// DELETE /templates/:userId/:templateId - Удалить шаблон
app.delete("/templates/:userId/:templateId", async (req, res) => {
  try {
    const { userId, templateId } = req.params;

    await db.ref(`users/${userId}/emailTemplates/${templateId}`).remove();

    console.log(`✅ Template deleted: ${templateId}`);
    res.json({ success: true });

  } catch (error) {
    console.error("❌ Error deleting template:", error);
    res.status(500).json({ error: "Failed to delete template" });
  }
});

// ========================
// EMAIL HISTORY ROUTES
// ========================

// GET /gmail/history/:userId - Получить историю отправленных писем
app.get("/gmail/history/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const snapshot = await db.ref(`users/${userId}/emailHistory`)
      .orderByChild('sentAt')
      .limitToLast(limit)
      .get();
    
    if (!snapshot.exists()) {
      return res.json({ history: [] });
    }

    const historyObj = snapshot.val();
    const history = Object.entries(historyObj)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.sentAt - a.sentAt);

    res.json({ history });

  } catch (error) {
    console.error("❌ Error getting email history:", error);
    res.status(500).json({ error: "Failed to get history" });
  }
});

// ========================
// START SERVER
// ========================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LoadRadar API Server running on port ${PORT}`);
  console.log(`📧 OTP endpoints: /send-otp, /verify-otp`);
  console.log(`📬 Gmail endpoints: /gmail/auth-url, /gmail/callback, /gmail/send, /gmail/status/:userId`);
  console.log(`📝 Template endpoints: /templates/:userId`);
});

module.exports = app;