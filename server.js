import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import { google } from "googleapis";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
  })
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const gmail = google.gmail({ version: "v1", auth: oauth2Client });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.redirect("/auth");
  }
  oauth2Client.setCredentials(req.session.tokens);
  next();
}

async function summarizeAndClassifyEmail(emailText) {
  const prompt = `
You are an email assistant.

Given this email, return ONLY valid JSON in this format:
{
  "summary": "short actionable summary",
  "category": "Important | Promotional | Personal | Requires Reply",
  "replyDraft": "a polite suggested reply, or empty string if none needed"
}

Email:
${emailText}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  const text = response.output_text;

  try {
    return JSON.parse(text);
  } catch {
    return {
      summary: "Could not parse summary.",
      category: "Important",
      replyDraft: "",
    };
  }
}

async function getEmailBody(payload) {
  if (!payload) return "";

  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
  }

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  return "";
}

async function ensureLabel(auth, labelName) {
  const gmailApi = google.gmail({ version: "v1", auth });
  const labelsRes = await gmailApi.users.labels.list({ userId: "me" });
  const existing = labelsRes.data.labels?.find((l) => l.name === labelName);

  if (existing) return existing.id;

  const created = await gmailApi.users.labels.create({
    userId: "me",
    requestBody: {
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });

  return created.data.id;
}

async function applyLabel(auth, messageId, labelName) {
  const gmailApi = google.gmail({ version: "v1", auth });
  const labelId = await ensureLabel(auth, labelName);

  await gmailApi.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
    },
  });
}

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Gmail AI Assistant</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 1000px; margin: 40px auto; padding: 20px; }
          .btn { display:inline-block; padding:10px 16px; background:#111; color:#fff; text-decoration:none; border-radius:8px; margin-bottom:20px; }
          .email { border:1px solid #ddd; border-radius:12px; padding:16px; margin-bottom:16px; }
          .label { display:inline-block; padding:4px 10px; background:#f3f3f3; border-radius:999px; font-size:12px; margin-bottom:8px; }
          textarea { width:100%; min-height:120px; margin-top:10px; }
          button { padding:10px 14px; border:none; border-radius:8px; cursor:pointer; background:#111; color:#fff; }
          .topbar { display:flex; gap:12px; align-items:center; margin-bottom:24px; }
        </style>
      </head>
      <body>
        <h1>Gmail AI Assistant</h1>
        <p>Connect Gmail, summarize inbox messages, classify them, label them, and draft replies.</p>
        <div class="topbar">
          <a class="btn" href="/auth">Connect Gmail</a>
          <a class="btn" href="/emails">View Emails</a>
        </div>
      </body>
    </html>
  `);
});

app.get("/auth", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });

  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);
    res.redirect("/emails");
  } catch (error) {
    console.error(error);
    res.status(500).send("OAuth failed.");
  }
});

app.get("/emails", requireAuth, async (req, res) => {
  try {
    oauth2Client.setCredentials(req.session.tokens);

    const list = await gmail.users.messages.list({
      userId: "me",
      maxResults: 10,
      labelIds: ["INBOX"],
    });

    const messages = list.data.messages || [];
    const processed = [];

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = detail.data.payload.headers || [];
      const subject = headers.find((h) => h.name === "Subject")?.value || "(No Subject)";
      const from = headers.find((h) => h.name === "From")?.value || "(Unknown Sender)";
      const body = await getEmailBody(detail.data.payload);

      const ai = await summarizeAndClassifyEmail(body || `${subject}\n${from}`);
      await applyLabel(oauth2Client, msg.id, ai.category);

      processed.push({
        id: msg.id,
        subject,
        from,
        summary: ai.summary,
        category: ai.category,
        replyDraft: ai.replyDraft,
      });
    }

    const html = processed
      .map(
        (email) => `
        <div class="email">
          <div class="label">${email.category}</div>
          <h3>${email.subject}</h3>
          <p><strong>From:</strong> ${email.from}</p>
          <p><strong>Summary:</strong> ${email.summary}</p>
          <form method="POST" action="/send-reply">
            <input type="hidden" name="messageId" value="${email.id}" />
            <textarea name="replyBody">${email.replyDraft || ""}</textarea>
            <br />
            <button type="submit">Send Reply</button>
          </form>
        </div>
      `
      )
      .join("");

    res.send(`
      <html>
        <head>
          <title>Inbox</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 1000px; margin: 40px auto; padding: 20px; }
            .email { border:1px solid #ddd; border-radius:12px; padding:16px; margin-bottom:16px; }
            .label { display:inline-block; padding:4px 10px; background:#f3f3f3; border-radius:999px; font-size:12px; margin-bottom:8px; }
            textarea { width:100%; min-height:120px; margin-top:10px; }
            button, .btn { padding:10px 14px; border:none; border-radius:8px; cursor:pointer; background:#111; color:#fff; text-decoration:none; display:inline-block; }
          </style>
        </head>
        <body>
          <h1>Recent Emails</h1>
          <a class="btn" href="/">Home</a>
          <div style="margin-top:20px;"></div>
          ${html || "<p>No emails found.</p>"}
        </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Failed to fetch emails.");
  }
});

app.post("/send-reply", requireAuth, async (req, res) => {
  try {
    oauth2Client.setCredentials(req.session.tokens);

    const { messageId, replyBody } = req.body;

    const original = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Message-ID"],
    });

    const headers = original.data.payload.headers || [];
    const to = headers.find((h) => h.name === "From")?.value || "";
    const subject = headers.find((h) => h.name === "Subject")?.value || "";
    const messageHeaderId = headers.find((h) => h.name === "Message-ID")?.value || "";

    const rawMessage = [
      `To: ${to}`,
      `Subject: Re: ${subject}`,
      `In-Reply-To: ${messageHeaderId}`,
      `References: ${messageHeaderId}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      replyBody,
    ].join("\n");

    const encodedMessage = Buffer.from(rawMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage,
        threadId: original.data.threadId,
      },
    });

    res.redirect("/emails");
  } catch (error) {
    console.error(error);
    res.status(500).send("Failed to send reply.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
