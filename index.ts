import express from "express";
import { ApnsClient, Notification, PushType } from "apns2";
import * as dotenv from "dotenv";
import * as nodemailer from "nodemailer";
import * as handlebars from "handlebars";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const app = express();
app.use(express.json());

// --- Security Middleware ---
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.WORKER_SECRET}`) {
    console.warn("🚫 Unauthorized request blocked");
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
});

// --- Load and normalize private key ---
const signingKey = (process.env.APN_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// --- Initialize persistent APNs client once ---
const apnClient = new ApnsClient({
  team: process.env.APN_TEAM_ID as string,
  keyId: process.env.APN_KEY_ID as string,
  signingKey,
  defaultTopic: process.env.APN_BUNDLE_ID,
  host: process.env.APN_HOST || "api.push.apple.com",
  requestTimeout: 30000,
});

// --- Helper: safe send with retry ---
async function safeSend(notification: any, retries = 1) {
  try {
    await apnClient.send(notification);
  } catch (err: any) {
    if (
      retries > 0 &&
      (err.code === "UND_ERR_SOCKET" || err.message?.includes("socket"))
    ) {
      console.warn("🔁 Retrying APNs after socket close...");
      return safeSend(notification, retries - 1);
    } else {
      console.error("❌ APNs send error:", err);
    }
  }
}

// --- Main Route ---
app.post("/send-apn", async (req, res) => {
  console.log("📩 Incoming push request");

  const startTime = Date.now();
  try {
    const { tokens, payload, type } = req.body;
    if (!tokens?.length) throw new Error("Missing tokens");

    console.log(`➡️ Sending ${type} notification to ${tokens.length} tokens`);

    // Send in parallel to keep request under Railway timeout
    await Promise.all(
      tokens.map(async (token: any) => {
        let notification;

        if (type === "silent") {
          notification = new Notification(token, {
            aps: { "content-available": 1 },
            type: PushType.background,
            topic: process.env.APN_BUNDLE_ID,
          });
        } else {
          notification = new Notification(token, {
            aps: {
              alert: {
                title: payload?.title ?? "Coordiy Update",
                body: payload?.body ?? "Event changed",
              },
              sound: "default",
            },
            topic: process.env.APN_BUNDLE_ID,
          });
        }

        await safeSend(notification);
        console.log(`✅ Sent ${type} APN to ${token}`);
      })
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ All ${type} notifications sent in ${elapsed}s`);
    return res.status(200).json({ success: true, duration: elapsed });
  } catch (err: any) {
    console.error("❌ Error in /send-apn:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/send-email", async (req, res) => {
  try {
    const {
      to,
      template,
      subject,
      user,
      pass,
      eventTitle,
      eventDate,
      eventTime,
      eventLocation,
      eventId,
    } = req.body;

    console.log("hitted")

    if (!to || !template || !subject)
      return res.status(400).json({ error: "Missing params" });

    // Load template
    const templatePath = path.join(process.cwd(), `templates/${template}`);
    const file = fs.readFileSync(templatePath, "utf8");
    const compiled = handlebars.compile(file);

    const html = compiled({
      username: to,
      eventTitle,
      eventDate,
      eventTime,
      eventLocation,
      appName: "Cordy",
      supportEmail: user,
      icalLink: eventId
        ? `https://coordy-prod.vercel.app/api/calendar/${eventId}.ics`
        : "",
    });

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      auth: { user, pass },
    });

    const attachments = [];

    if (eventId) {
      attachments.push({
        filename: `${eventTitle}.ics`,
        path: `https://coordy-prod.vercel.app/api/calendar/${eventId}.ics`,
        contentType: "text/calendar; charset=UTF-8; method=REQUEST"
      });
    }

    const info = await transporter.sendMail({
      from: user,
      to,
      subject,
      html,
      attachments
    });


    console.log("📧 Email sent:", info.messageId);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("❌ Email worker error:", err);
    return res.status(500).json({ error: err.message });
  }
});


// --- Catch-all error logging ---
process.on("unhandledRejection", (reason) => {
  console.error("🚨 Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🚨 Uncaught Exception:", err);
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 APN Worker running on port ${PORT}`)
);
