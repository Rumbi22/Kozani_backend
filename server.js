// server.js
// allows me to use JavaScript outside of browser
import express from "express";
import cors from "cors";
import dotenv from "dotenv";



// allows for env varialble to be loaded.
dotenv.config();

import Groq from "groq-sdk";
import pkg from "pg";

import bcrypt from "bcryptjs";


const app = express();   //creasting an express application. the container for my Node app in the backend
const PORT = process.env.PORT || 8787;   //checks for prot number in env amd uses 8787 as default if there isnt one



const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })


const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // needed for Render Postgres
});

// --- MIDDLEWARE ---
app.use(cors());            // later you can restrict origin (e.g. your frontend URL)
app.use(express.json());    // so req.body works for JSON





// simple helper
async function query(sql, params) {
  const res = await pool.query(sql, params);
  return res;
}


// Find user by phone
async function findUserByPhone(phone) {
  const result = await query(
    "SELECT id, phone, password_hash, name FROM users WHERE phone = $1",
    [phone]
  );
  return result.rows[0] || null;
}

// Create new user
async function createUser({ phone, password, name }) {
  const passwordHash = await bcrypt.hash(password, 10); // 10 = salt rounds

  const result = await query(
    `INSERT INTO users (phone, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id, phone, name, created_at`,
    [phone, passwordHash, name]
  );

  return result.rows[0];
}




// --- HEALTH CHECK ---
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "kozani-backend",
    time: new Date().toISOString()
  });
});






app.get("/db-ping", async (req, res) => {
  try {
    const result = await query("SELECT NOW()");
    res.json({ ok: true, time: result.rows[0].now });
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ ok: false });
  }
});



// POST /login
// Body: { phone, password, name }
app.post("/login", async (req, res) => {
  try {
    const { phone, password, name } = req.body;

    // Basic validation
    if (!phone || !password) {
      return res.status(400).json({ error: "Phone and password are required." });
    }

    // 1. Check if user exists
    const existingUser = await findUserByPhone(phone);

    if (existingUser) {
      // Existing user → verify password
      const ok = await bcrypt.compare(password, existingUser.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Invalid phone or password." });
      }

      // Login success → return user info
      return res.json({
        user_id: existingUser.id,
        name: existingUser.name,
        phone: existingUser.phone,
        is_new: false
      });
    }

    // 2. New user → create
    const user = await createUser({ phone, password, name: name || null });

    return res.status(201).json({
      user_id: user.id,
      name: user.name,
      phone: user.phone,
      is_new: true
    });

  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Server error during login." });
  }
});


//user message db

async function saveMessage(user_id, role, content) {
  try {
    await query(
      `INSERT INTO messages (user_id, role, content)
       VALUES ($1, $2, $3)`,
      [user_id, role, content]
    );
  } catch (err) {
    console.error("Error saving message:", err);
  }
}

async function getRecentMessages(user_id, limit = 10) {
  const result = await query(
    `SELECT role, content
     FROM messages
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [user_id, limit]
  );

  // We fetched newest → oldest, Groq expects oldest → newest
  return result.rows.reverse();
}






// --- KOZANI CHAT ENDPOINT ---
// expects body: { query, snippets?, language?, client?, user_id? }
app.post("/api/kozani-chat", async (req, res) => {
  try {
    const {
      query: rawQuery,
      snippets = [],
      language = "en",
      client,
      user_id,
    } = req.body || {};

    if (!rawQuery) {
      return res.status(400).json({
        answer: "I didn’t receive anything to respond to.",
        safety: { ok: false, flags: ["empty_query"] },
        meta: { model: "none" },
      });
    }

    const query = rawQuery;

    // 1) Build grounding text from snippets (later you’ll plug your KB here)
    const grounding = snippets.map((s) => s.text).join("\n\n");

    // 2) System prompt: Kozani’s voice + rules
    const systemPrompt = `
You are Kozani, an empathetic perinatal companion for expectant and new mothers,
especially in under-resourced settings.

Your goals:
- Listen with warmth and respect.
- Reflect their feelings back gently.
- Offer clear, simple, practical guidance.
- Encourage seeking professional help when needed.
- Never judge, shame, or blame.

Safety rules:
- DO NOT diagnose or prescribe medication.
- DO NOT give exact doses or treatment plans.
- DO NOT contradict local healthcare professionals.
- If there is any sign of danger (severe pain, heavy bleeding, trouble breathing, thoughts of self-harm),
  clearly advise the user to seek urgent medical help or visit a clinic/hospital as soon as possible.

Keep responses:
- Short (4–7 sentences).
- In plain, simple language.
- Emotionally validating.

Use this trusted information as background context when relevant (but do not quote it word-for-word):

${grounding}
    `.trim();

    // 3) Load short-term memory for this user (last 8 messages)
    let memoryMessages = [];
    if (user_id) {
      memoryMessages = await getRecentMessages(user_id, 8);
    }

    // 4) Build messages array for Groq
    const groqMessages = [
      { role: "system", content: systemPrompt },
    ];

    if (memoryMessages.length > 0) {
      for (const m of memoryMessages) {
        groqMessages.push({
          role: m.role,      // "user" or "assistant"
          content: m.content,
        });
      }
    }

    // current user message
    groqMessages.push({
      role: "user",
      content: query,
    });

    // 5) Call Groq
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: groqMessages,
      temperature: 0.4,
      max_tokens: 400,
    });

    const answer =
      completion.choices?.[0]?.message?.content ??
      "I’m sorry, I’m struggling to respond right now.";

    // 6) Save user + assistant messages to DB (for memory)
    if (user_id) {
      await saveMessage(user_id, "user", query);
      await saveMessage(user_id, "assistant", answer);
    }

    // 7) Send reply back to frontend
    res.json({
      answer,
      safety: { ok: true, flags: [] },
      meta: {
        model: "llama-3.1-8b-instant",
        provider: "groq",
        grounded: snippets.length > 0,
        language,
        client,
      },
    });
  } catch (err) {
    console.error("Kozani /api/kozani-chat error:", err);
    res.status(500).json({
      answer:
        "I’m sorry, something went wrong while thinking. Please try again a bit later.",
      safety: { ok: false, flags: ["backend_error"] },
      meta: { model: "none" },
    });
  }
});


// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Kozani backend running on http://localhost:${PORT}`);
});
