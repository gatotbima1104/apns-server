// index.js
import express from "express";
import { ApnsClient, Notification, PushType } from "apns2";
import * as dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// Add security
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.WORKER_SECRET}`) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
});

// Load and normalize private key
const signingKey = (process.env.APN_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// Keep one persistent APNs connection alive
const apnClient = new ApnsClient({
  team: process.env.APN_TEAM_ID as string,
  keyId: process.env.APN_KEY_ID as string,
  signingKey,
  defaultTopic: process.env.APN_BUNDLE_ID,
  host: process.env.APN_HOST || "api.push.apple.com",
  requestTimeout: 30000,
});

// --- Helper: Safe send with retry on socket errors
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

app.post("/send-apn", async (req, res) => {
  try {
    const { tokens, payload, type } = req.body;
    if (!tokens?.length) throw new Error("Missing tokens");

    for (const token of tokens) {
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
    }

    res.status(200).json({ success: true });
  } catch (err: any) {
    console.error("❌ Error in /send-apn:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 APN Worker running on port ${PORT}`)
);
